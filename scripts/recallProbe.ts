import { botConfig } from '@/core/nnkConfig';
import aliasIndex from '@/modules/aiReply/history/aliasIndex';
import { getMemoryDb } from '@/modules/aiReply/memory/db';
import { buildTermQueries, recallChat, recallMemory } from '@/modules/aiReply/memory/retrieve';
import { queryTerms } from '@/modules/aiReply/memory/segment';
import memoryStore from '@/modules/aiReply/memory/store';
import { runMemoryTool } from '@/modules/aiReply/memory/tools';

/**
 * 召回探针：不发消息、不惊动群，直接问「这句话能召回什么」。
 *
 * 线上只能看到模型最终说了什么，中间的召回是个黑盒——工具没被调用、名字没解析、
 * 检索落空这三种失败在群里看起来一模一样。这里把它们摊开：
 * 名字解析、检索词、字面 vs 语义各自的战果、模型最终看到的文本，逐层打印。
 *
 * 用法：
 *   npm run memory:probe -- 301750074 "上次说的那家拉面店"
 *   npm run memory:probe -- 301750074 "流逝是什么样的人" --about 流逝
 *   npm run memory:probe -- 301750074 "爬山" --speaker 千果 --days 90
 *
 *   --about    查某人的档案（走 recall_memory）
 *   --speaker  限定是谁说的（走 recall_chat）
 *   --days     往前翻多少天，默认 14——和线上工具的默认值一致
 *
 * 只花一次 embed 调用（语义那一路），不花回复额度
 */

const [groupArg, query, ...rest] = process.argv.slice(2);
const groupId = Number(groupArg);

if (!groupId || !query) {
  console.error('用法: npm run memory:probe -- <群号> "<问题>" [--about 名字] [--speaker 名字] [--days 30]');
  process.exit(1);
}

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

const about = flag('about');
const speaker = flag('speaker');
const days = Number(flag('days') ?? 14);

const db = getMemoryDb();
const line = (s = '') => console.log(s);

/** 昵称好认，userId 不好认，打印时一律带上昵称 */
function who(userId: number) {
  return `${memoryStore.getNickName(userId, groupId) ?? '?'}(${userId})`;
}

line(`群 ${groupId}｜问题「${query}」｜days=${days}`);

// 1. 这个群到底有没有料。没有数据时后面每一层都会空，先说清楚
const stat = db.prepare(
  'SELECT count(*) AS n, min(date_key) AS a, max(date_key) AS b FROM chat_line WHERE group_id = ?',
).get(groupId) as { n: number, a: number, b: number };
const windows = db.prepare(`SELECT count(*) AS n FROM chat_window w
  JOIN embedding e ON e.ref_kind = 'window' AND e.ref_id = w.id WHERE w.group_id = ?`).get(groupId) as { n: number };
const memories = db.prepare(
  'SELECT count(*) AS n FROM memory WHERE group_id = ? OR group_id IS NULL',
).get(groupId) as { n: number };

line('\n[数据]');
line(`  聊天 ${stat.n} 行${stat.n ? `（${stat.a} ~ ${stat.b}）` : ''}｜已向量化窗口 ${windows.n} 个｜记忆 ${memories.n} 条`);
if (windows.n === 0) line('  ⚠ 没有窗口向量，语义召回这条路不存在，只剩字面检索');
if (!botConfig.aiReply.initiativeList.includes(groupId)) {
  line('  ⚠ 不在 initiativeList 里，巩固任务默认不给这个群切语义窗口');
}

// 2. 名字解析。线上「名字未解析」时检索根本没跑，这一层是最容易踩的坑
if (about || speaker) {
  const name = about ?? speaker!;
  const ids = aliasIndex.resolve(groupId, name);
  line('\n[名字解析]');
  line(`  「${name}」-> ${ids.length ? ids.map(who).join('、') : '认不出'}`);
  if (ids.length === 0) {
    line('  ⚠ 解析失败，线上会直接返回「没有找到叫XX的群友」，检索不会执行');
    // 这个人可能只是没在本群说过话：resolve 有同群约束，跨群的人一律认不出
    const seen = db.prepare(
      'SELECT DISTINCT group_id AS g FROM chat_line WHERE nick LIKE ? LIMIT 5',
    ).all(`%${name}%`) as { g: number }[];
    if (seen.length > 0) line(`  提示：昵称含「${name}」的人在这些群说过话：${seen.map((s) => s.g).join('、')}`);
  }
}

// 3. 检索词。抽象问题（「上个月说过的话」）切不出实义词，字面检索必空
line('\n[检索词]');
const terms = queryTerms(query);
line(`  ${terms.length ? terms.join('、') : '（空，句子里没有实义词）'}`);
line(`  FTS 串: ${buildTermQueries(query).map((q) => `${q.match}×${q.weight.toFixed(2)}`).join('  ')}`);

// 4. 字面与语义分开跑。两者都空和只有一路空，说明的问题完全不同
const speakerIds = speaker ? aliasIndex.resolve(groupId, speaker) : undefined;
const literal = await recallChat(groupId, {
  query, speakerIds, days, semantic: false,
}, db);
const both = await recallChat(groupId, {
  query, speakerIds, days,
}, db);

const show = (hits: typeof literal) => hits.forEach((h) => line(`    ${h.date} ${who(h.userId)} ${h.text}`));

line(`\n[字面检索] ${literal.length} 条`);
show(literal);
line(`\n[字面+语义] ${both.length} 条`);
show(both);

const onlySemantic = both.filter((h) => !literal.some((l) => l.id === h.id));
if (onlySemantic.length > 0) {
  line(`  ↑ 其中 ${onlySemantic.length} 条只有语义能召回（字面一个字都没重合）`);
} else if (windows.n > 0) {
  line('  ↑ 语义没有额外贡献，可能是相似度没过下限');
}

// 5. 记忆召回
const aboutUserIds = about ? aliasIndex.resolve(groupId, about) : undefined;
const mem = await recallMemory(groupId, { query, aboutUserIds }, db);
line(`\n[记忆召回] ${mem.length} 条`);
mem.forEach((m) => line(`    ${who(m.ownerId)} [${m.kind}] ${m.text}`));

// 6. 模型最终看到的原文。前面几层是给人看的，这一层才是线上真正发生的事
line('\n[模型看到的]');
const toolInput = about
  ? { query, about }
  : { query, speaker, days };
const toolName = about ? 'recall_memory' : 'recall_chat';
const text = await runMemoryTool(groupId, toolName, toolInput);
line(`  ${toolName}(${JSON.stringify(toolInput)})`);
text.split('\n').forEach((t) => line(`    ${t}`));

db.close();
