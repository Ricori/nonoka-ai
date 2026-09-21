import { embedTexts } from '@/service/llm';
import Database from 'better-sqlite3';
import { getMemoryDb, type MemoryDatabase } from '@/modules/aiReply/memory/db';
import { buildTermQueries, recallChat } from '@/modules/aiReply/memory/retrieve';
import { queryTerms } from '@/modules/aiReply/memory/segment';
import { blobToVec, searchSimilar } from '@/modules/aiReply/memory/vector';
import { historySince } from '@/modules/aiReply/memory/policy';

/**
 * 召回质量评测：一组查询跑下来，把「为什么召回的是这几条」拆开量化。
 *
 * 探针（recallProbe）回答单条查询召回了什么，这里回答**为什么是它们**——
 * 字面那路的 bm25 分、语义那路的话题相似度、最终结果里有多少条来自同一个话题、
 * 有多少条是「不赖」这种没信息量的短句。批量跑才看得出是个例还是系统性偏差。
 *
 * 用法：
 *   npm run memory:eval -- 301750074
 *   npm run memory:eval -- 301750074 --days 60
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
const storedTopics = rest.includes('--stored-topics');
if (!groupId && !storedTopics) {
  console.error('用法: npm run memory:eval -- <群号> [--days 60]');
  process.exit(1);
}
const daysFlag = rest.indexOf('--days');
const days = daysFlag >= 0 ? Number(rest[daysFlag + 1]) : 60;

// --days 之外的位置参数当成自定义查询
const custom = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--days');
const QUERIES = custom.length > 0 ? custom : DEFAULT_QUERIES;

const db: MemoryDatabase = storedTopics
  ? new Database('data/memory/nonoka.db', { readonly: true, fileMustExist: true }) : getMemoryDb();

// 离线回放已有话题：复用已存向量，核对能否找回来源原文，不做付费模型调用。
if (storedTopics) {
  try {
    const rows = db.prepare(`SELECT t.group_id, t.summary, t.line_from, t.line_to, e.vec
      FROM topic t JOIN embedding e ON e.ref_kind = 'topic' AND e.ref_id = t.id
      WHERE t.date_key >= ? ${groupId ? 'AND t.group_id = ?' : ''}
      ORDER BY t.group_id, t.date_key, t.id`).all(historySince(), ...(groupId ? [groupId] : [])) as {
      group_id: number, summary: string, line_from: number, line_to: number, vec: Buffer,
    }[];
    let matched = 0;
    let outsideWindow = 0;
    let wrongGroup = 0;
    const count = Math.min(30, rows.length);
    for (let i = 0; i < count; i++) {
      const row = rows[Math.floor((i * rows.length) / count)];
      const hits = await recallChat(row.group_id, { query: row.summary, queryVec: blobToVec(row.vec), days: 45 }, db);
      if (hits.some((hit) => hit.id >= row.line_from && hit.id <= row.line_to)) matched += 1;
      for (const hit of hits) {
        const source = db.prepare('SELECT group_id, date_key FROM chat_line WHERE id = ?').get(hit.id) as { group_id: number, date_key: number };
        if (source.group_id !== row.group_id) wrongGroup += 1;
        if (source.date_key < historySince()) outsideWindow += 1;
      }
    }
    console.log(JSON.stringify({
      samples: count,
      sourceRecoveredInTop5: matched,
      outsideWindow,
      wrongGroup,
      note: '只读、零模型调用；使用已存话题回放，不能替代独立标注的相关性评测。',
    }, null, 2));
    if (outsideWindow || wrongGroup) process.exitCode = 1;
  } finally { db.close(); }
  process.exit(process.exitCode ?? 0);
}
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

/** 这一行落在哪个话题里，用来看最终结果是不是全挤在一个话题上 */
const topicOf = db.prepare(
  'SELECT id, summary FROM topic WHERE group_id = ? AND ? BETWEEN line_from AND line_to LIMIT 1',
);

const totals = {
  hits: 0, lowValue: 0, fromTopTopic: 0, queriesWithSemantic: 0, ownCand: 0, cand: 0, dupText: 0,
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

  // 2. 语义那路：相似度到底多高，0.40 的闸放进来的是什么
  const vec = await embedTexts([query]);
  line('\n[语义] 话题相似度 top5');
  let topTopicId = -1;
  if (!vec) {
    line('  ⚠ embed 失败');
  } else {
    // 和线上一致：先按群收窄再检索。另外算一遍全库的，看不收窄会浪费多少候选
    const allow = new Set((db.prepare('SELECT id FROM topic WHERE group_id = ? AND date_key >= ?')
      .all(groupId, since) as { id: number }[]).map((r) => r.id));
    const sims = searchSimilar(db, 'topic', vec[0], 30, allow);
    const rows = sims.slice(0, 5).map((s) => {
      const t = db.prepare('SELECT id, summary, group_id AS g, line_to - line_from AS span FROM topic WHERE id = ?')
        .get(s.refId) as { id: number, summary: string, g: number, span: number };
      return { ...t, score: s.score };
    });
    rows.forEach((r, i) => {
      const mine = r.g === groupId ? '' : `（别的群 ${r.g}）`;
      line(`  ${(i + 1)}. ${r.score.toFixed(3)} ${r.score >= 0.4 ? '✓' : '✗低于阈值'} 跨${r.span}行 ${r.summary.slice(0, 40)}${mine}`);
    });
    // 收窄前后的对比：全库 top30 里本群占几个，就是不收窄时能剩下的候选数
    const wide = searchSimilar(db, 'topic', vec[0], 30);
    const ownInWide = wide.filter((s) => allow.has(s.refId)).length;
    line(`  候选池 ${sims.length} 个（已按群收窄）｜不收窄的话全库 top30 里本群只有 ${ownInWide} 个`);
    totals.ownCand += ownInWide;
    totals.cand += wide.length;

    const own = rows.filter((r) => r.g === groupId && r.score >= 0.4);
    if (own.length > 0) {
      topTopicId = own[0].id;
      totals.queriesWithSemantic += 1;
    }
  }

  // 3. 最终结果：每条标出来源和信息量
  const hits = await recallChat(groupId, { query, days }, db);
  line(`\n[最终] ${hits.length} 条`);
  totals.dupText += hits.length - new Set(hits.map((h) => h.text)).size;
  hits.forEach((h) => {
    const t = topicOf.get(groupId, h.id) as { id: number, summary: string } | undefined;
    const len = contentLen(h.text);
    const marks = [
      t ? `话题#${t.id}` : '无话题',
      len < LOW_VALUE_CHARS ? `⚠只有${len}个字` : '',
    ].filter(Boolean).join(' ');
    line(`  ${h.date} ${h.text.slice(0, 44)}  [${marks}]`);
    totals.hits += 1;
    if (len < LOW_VALUE_CHARS) totals.lowValue += 1;
    if (t && t.id === topTopicId) totals.fromTopTopic += 1;
  });
}

line(`\n${'='.repeat(70)}\n【汇总】${QUERIES.length} 条查询，共 ${totals.hits} 条结果`);
line(`  语义有效（top1 过阈值且同群）的查询: ${totals.queriesWithSemantic}/${QUERIES.length}`);
line(`  少于 ${LOW_VALUE_CHARS} 个字的结果: ${totals.lowValue} 条 (${((totals.lowValue / totals.hits) * 100).toFixed(0)}%)`);
line(`  来自同一个话题（语义 top1）的结果: ${totals.fromTopTopic} 条 (${((totals.fromTopTopic / totals.hits) * 100).toFixed(0)}%)`);
line(`  完全重复的文本: ${totals.dupText} 条`);
line(`  收窄前的候选池利用率: ${totals.ownCand}/${totals.cand} (${((totals.ownCand / totals.cand) * 100).toFixed(0)}%)——现在已按群收窄，这部分浪费已消除`);
db.close();
