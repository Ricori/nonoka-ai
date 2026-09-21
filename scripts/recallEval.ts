import { embedTexts } from '@/service/llm';
import { getMemoryDb } from '@/modules/aiReply/memory/db';
import { MIN_SIMILARITY, buildTermQueries, recallChat } from '@/modules/aiReply/memory/retrieve';
import { queryTerms } from '@/modules/aiReply/memory/segment';
import { searchSimilar } from '@/modules/aiReply/memory/vector';

/**
 * 召回质量评测：一组查询跑下来，把「为什么召回的是这几条」拆开量化。
 *
 * 探针（recallProbe）回答单条查询召回了什么，这里回答**为什么是它们**——
 * 字面那路的 bm25 分、语义那路的窗口相似度、最终结果里有多少条来自同一个窗口、
 * 有多少条是「不赖」这种没信息量的短句。批量跑才看得出是个例还是系统性偏差。
 * 要比命中率、校准阈值用 scripts/semanticAB.ts。
 *
 * 用法：
 *   npm run memory:eval -- 301750074
 *   npm run memory:eval -- 301750074 --days 30
 *
 * 每条查询花一次 embed 调用
 */

/** 默认查询，覆盖不同提问方式：具体名词、同义改写、人+事、抽象问法。命令行传了就用传的 */
const DEFAULT_QUERIES = [
  '上次说的那家拉面店',
  '谁在打游戏',
  '大家聊过什么游戏',
  '周末出去玩的计划',
  '有人生病了吗',
  '最近买了什么东西',
];

/** 短到没有注入价值的行：hasContent 只挡了 2 字以下，「不赖」这种照样能进 */
const LOW_VALUE_CHARS = 4;

const [groupArg, ...rest] = process.argv.slice(2);
const groupId = Number(groupArg);
if (!groupId) {
  console.error('用法: npm run memory:eval -- <群号> [--days 45]');
  process.exit(1);
}
const daysFlag = rest.indexOf('--days');
const days = daysFlag >= 0 ? Number(rest[daysFlag + 1]) : 45;

// --days 之外的位置参数当成自定义查询
const custom = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--days');
const QUERIES = custom.length > 0 ? custom : DEFAULT_QUERIES;

const db = getMemoryDb();
const line = (s = '') => console.log(s);
const since = Number(
  new Date(Date.now() - days * 86400000).toISOString().slice(0, 10).replace(/-/g, ''),
);

/** 复刻 literalChatLists 的语句，额外把 bm25 分数取出来看 */
const literalStmt = db.prepare(`
  SELECT c.id, c.text, bm25(chat_fts) AS score FROM chat_fts f CROSS JOIN chat_line c ON c.id = f.rowid
  WHERE f.chat_fts MATCH ? AND c.group_id = ? AND c.date_key >= ? AND c.user_id != 0
  ORDER BY bm25(chat_fts) LIMIT 5
`);

/** 一行里剩几个有效字，用来判断是不是「不赖」这种附和 */
function contentLen(text: string) {
  return text.replace(/^\[[^\]]*\][^：]*：/, '').replace(/\[[^\]]*\]/g, '').replace(/[\s\p{P}\p{S}]/gu, '').length;
}

/** 这一行落在哪个窗口里，用来看最终结果是不是全挤在一个窗口上 */
const windowOf = db.prepare(
  'SELECT id FROM chat_window WHERE group_id = ? AND ? BETWEEN line_from AND line_to ORDER BY id LIMIT 1',
);

const totals = {
  hits: 0, lowValue: 0, fromTopWindow: 0, queriesWithSemantic: 0, dupText: 0,
};

for (const query of QUERIES) {
  line(`\n${'='.repeat(70)}\n【${query}】`);

  // 1. 字面那路：检索词切得对不对，命中的 bm25 分有多差
  line(`\n[字面] 检索词 ${queryTerms(query).join('、') || '（无）'}`);
  buildTermQueries(query).forEach(({ match, weight }) => {
    const rows = literalStmt.all(match, groupId, since) as { id: number, text: string, score: number }[];
    line(`  ${match} ×${weight.toFixed(2)} -> ${rows.length} 条`);
    // bm25 越接近 0 越差；同一个词在几万行里遍地都是时就是这种分
    rows.slice(0, 3).forEach((r) => line(`      bm25 ${r.score.toFixed(2)}  ${r.text.slice(0, 40)}`));
  });

  // 2. 语义那路：相似度到底多高，阈值放进来的是什么
  const vec = (await embedTexts([query]))?.vectors;
  line(`\n[语义] 窗口相似度 top5（下限 ${MIN_SIMILARITY}）`);
  let topWindowId = -1;
  if (!vec) {
    line('  ⚠ embed 失败');
  } else {
    // 和线上一致：先按群收窄再检索
    const allow = new Set((db.prepare('SELECT id FROM chat_window WHERE group_id = ? AND date_key >= ?')
      .all(groupId, since) as { id: number }[]).map((r) => r.id));
    const sims = searchSimilar(db, 'window', vec[0], 5, allow);
    sims.forEach((s, i) => {
      const w = db.prepare('SELECT text FROM chat_window WHERE id = ?').get(s.refId) as { text: string };
      const pass = s.score >= MIN_SIMILARITY ? '✓' : '✗低于阈值';
      line(`  ${i + 1}. ${s.score.toFixed(3)} ${pass} ${w.text.replace(/\n/g, ' / ').slice(0, 60)}`);
    });
    if (sims[0] && sims[0].score >= MIN_SIMILARITY) {
      topWindowId = sims[0].refId;
      totals.queriesWithSemantic += 1;
    }
  }

  // 3. 最终结果：每条标出来源、所在窗口和信息量
  const hits = await recallChat(groupId, { query, days }, db);
  line(`\n[最终] ${hits.length} 条`);
  totals.dupText += hits.length - new Set(hits.map((h) => h.text)).size;
  hits.forEach((h) => {
    const w = windowOf.get(groupId, h.id) as { id: number } | undefined;
    const len = contentLen(h.text);
    const marks = [
      h.via,
      w ? `窗口#${w.id}` : '无窗口',
      len < LOW_VALUE_CHARS ? `⚠只有${len}个字` : '',
    ].filter(Boolean).join(' ');
    line(`  ${h.date} ${h.text.slice(0, 44)}  [${marks}]`);
    totals.hits += 1;
    if (len < LOW_VALUE_CHARS) totals.lowValue += 1;
    if (w && w.id === topWindowId) totals.fromTopWindow += 1;
  });
}

const pct = (n: number) => (totals.hits ? ((n / totals.hits) * 100).toFixed(0) : '0');
line(`\n${'='.repeat(70)}\n【汇总】${QUERIES.length} 条查询，共 ${totals.hits} 条结果`);
line(`  语义有效（top1 过阈值）的查询: ${totals.queriesWithSemantic}/${QUERIES.length}`);
line(`  少于 ${LOW_VALUE_CHARS} 个字的结果: ${totals.lowValue} 条 (${pct(totals.lowValue)}%)`);
line(`  来自同一个窗口（语义 top1）的结果: ${totals.fromTopWindow} 条 (${pct(totals.fromTopWindow)}%)`);
line(`  完全重复的文本: ${totals.dupText} 条`);
db.close();
