import { embedTexts } from '@/service/llm';
import { printError } from '@/utils/print';
import { backupDateKey } from '../storage/message';
import { getMemoryDb, type MemoryDatabase } from './db';
import { segment, stripSpeakerPrefix, weightedTerms } from './segment';
import { searchSimilar } from './vector';
import { HISTORY_DAYS, usableMemorySql } from './policy';

/**
 * 混合检索：字面（FTS5 + BM25）与语义（向量余弦）两路各自召回，再用 RRF 融合。
 *
 * 关键是排序里终于有了相关性——旧的实现从最近一天倒扫、凑满就停，
 * 拿到的永远是「最近 N 条」而不是「最相关 N 条」，20 天前的完美匹配会输给昨天勉强沾边的
 */

/** RRF 的平滑常数，取 60 是通行做法：名次靠前的差距被压平，不需要在两路之间调权重 */
const RRF_K = 60;

/** 每一路各取多少条进融合池 */
const CANDIDATE_LIMIT = 30;

const DEFAULT_LIMIT = 5;
const DEFAULT_DAYS = HISTORY_DAYS;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 一个话题最多展开几行原文，否则一段长对话就能把候选池灌满 */
const TOPIC_EXPAND_LIMIT = 3;

/**
 * 语义召回的相似度下限。这道闸不能省：余弦只排序不判断有无，
 * 没有下限时哪怕全库都跟问题无关，最不相关的那个也会以 rank 1 进入融合，压掉真正的字面命中。
 *
 * 阈值跟着 embedding 模型走，换模型必须重新量。qwen3.7-text-embedding 上实测
 * 该命中的最低 0.446、该落空的最高 0.394，中间有空档；取 0.40 卡在空档偏低的一侧——
 * 召回宁可多给，让模型自己判断要不要用，漏掉才是更糟的错。
 * （同一组样本换 text-embedding-v4 就是 0.409 对 0.409，根本切不开）
 *
 * 只用了一天的 4 个话题做样本，P6 攒出全量话题后要重新校准
 */
const MIN_SIMILARITY = 0.40;

export interface ChatHit {
  id: number;
  /** 'MM-DD' */
  date: string;
  userId: number;
  nick: string | null;
  /** 仍带 `[昵称]说：` 前缀，注入时直接可用 */
  text: string;
  /** 与命中同群同日的相邻原文，明确保留说话人，不把邻居的话当成命中者的事实。 */
  context?: string[];
}

export interface MemoryHit {
  id: number;
  scope: string;
  ownerId: number;
  kind: string;
  text: string;
  confidence: number;
  source: string | null;
}

interface CommonOptions {
  query: string;
  limit?: number;
  /** 已经算好的查询向量，传了就省一次 embed 往返 */
  queryVec?: Float32Array;
  /** 关掉语义那一路只走字面检索。主动插话这种不值得多花一次网络往返的场合用 */
  semantic?: boolean;
}

export interface RecallChatOptions extends CommonOptions {
  /** 硬过滤主命中；相邻上下文保留各自说话人。 */
  speakerIds?: number[];
  days?: number;
}

export interface RecallMemoryOptions extends CommonOptions {
  /** 硬过滤：问某个人就只要这个人的档案，混进别人的是噪音 */
  aboutUserIds?: number[];
  overview?: boolean;
}

export interface TermQuery {
  /** FTS5 的 MATCH 串 */
  match: string;
  /** 这一路在融合时的权重，一句话里所有检索词加起来为 1 */
  weight: number;
}

/**
 * 查询串必须过一遍和索引侧相同的分词再包成词组：索引里存的是分词后的 seg，
 * 直接拿 `"手办"` 去 MATCH 命中 0 行，`"手 办"` 才命中——「手办」不在 jieba 默认词典里。
 * 不包引号的话空格会被当成 AND，变成「手」和「办」分别出现在任意位置
 */
function phrase(text: string): string | null {
  const seg = segment(text);
  return seg ? `"${seg.replace(/"/g, '""')}"` : null;
}

/**
 * 把一句话拆成若干路检索，一个检索词一路，权重取它的 TF-IDF。
 *
 * 不把所有词 OR 进一条语句：BM25 的长度归一会让「好吃好吃」这种极短的行拿到高分，
 * 常见词于是盖过稀有词——查「拉面好吃吗」召回的全是「好吃」。
 * 一词一路、再按稀有度加权融合，排序维度才真的是稀有度
 */
export function buildTermQueries(query: string): TermQuery[] {
  const queries = weightedTerms(query).flatMap(({ term, weight }) => {
    const match = phrase(term);
    return match ? [{ match, weight }] : [];
  });

  if (queries.length === 0) {
    // 词典外的词会被切成单字、全被最小长度滤掉，这时退回整句当一个词组
    const match = phrase(query);
    return match ? [{ match, weight: 1 }] : [];
  }

  // 归一化成和为 1，让「字面」这一整路与「语义」那一路的份量相当
  const total = queries.reduce((sum, q) => sum + q.weight, 0) || 1;
  return queries.map((q) => ({ ...q, weight: q.weight / total }));
}

/** /llm/embed 挂掉时不要每次回复都去撞一次，连错几次就歇一会，期间只走字面检索 */
const EMBED_FAIL_LIMIT = 3;
const EMBED_COOLDOWN = 10 * 60 * 1000;
let embedFails = 0;
let embedMutedUntil = 0;

async function embedQuery(text: string): Promise<Float32Array | null> {
  if (Date.now() < embedMutedUntil) return null;

  const vectors = await embedTexts([text]);
  if (!vectors?.length) {
    embedFails += 1;
    if (embedFails >= EMBED_FAIL_LIMIT) {
      embedMutedUntil = Date.now() + EMBED_COOLDOWN;
      embedFails = 0;
      printError('[Retrieve] /llm/embed 连续失败，语义召回暂停 10 分钟，期间只走字面检索');
    }
    return null;
  }

  embedFails = 0;
  return Float32Array.from(vectors[0]);
}

/** 取查询向量：调用方给了就用，明确关掉语义路就返回 null，否则现算 */
function resolveQueryVec(opts: CommonOptions): Promise<Float32Array | null> | Float32Array | null {
  if (opts.queryVec) return opts.queryVec;
  return opts.semantic === false ? null : embedQuery(opts.query);
}

export interface RankedList {
  /** 按相关性降序的 id */
  ids: number[];
  /** 这一路的份量，默认 1 */
  weight?: number;
}

/** RRF：只比较各路里的名次，不需要在 BM25 分和余弦值这两种量纲之间换算 */
export function rrfFuse(lists: RankedList[], k = RRF_K): Map<number, number> {
  const scores = new Map<number, number>();
  lists.forEach(({ ids, weight = 1 }) => {
    [...new Set(ids)].forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + i + 1));
    });
  });
  return scores;
}

function placeholders(n: number) {
  return new Array(n).fill('?').join(', ');
}

function dateKeySince(days: number) {
  return Number(backupDateKey(new Date(Date.now() - days * DAY_MS)));
}

/** yyyymmdd -> 'MM-DD' */
function formatDate(dateKey: number) {
  const s = String(dateKey);
  return `${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

// ========== 聊天记录 ==========

function literalChatLists(db: MemoryDatabase, groupId: number, query: string, since: number, speakerIds?: number[]): RankedList[] {
  // CROSS JOIN 强制 FTS 当外层。让 SQLite 自己挑的话它会拿 chat_line 走索引当外层、
  // 再对每一行重跑一次 MATCH，6 万行的群实测 3.7s；换成这样是 2ms
  const stmt = db.prepare(`
    SELECT c.id FROM chat_fts f CROSS JOIN chat_line c ON c.id = f.rowid
    WHERE f.chat_fts MATCH ? AND c.group_id = ? AND c.date_key >= ? AND c.user_id != 0
      ${speakerIds?.length ? `AND c.user_id IN (${placeholders(speakerIds.length)})` : ''}
    ORDER BY bm25(chat_fts) LIMIT ?
  `);

  return buildTermQueries(query).flatMap(({ match, weight }) => {
    try {
      // bm25() 返回负值，升序即相关性降序。bot 自己的发言不算旧账
      const rows = stmt.all(match, groupId, since, ...(speakerIds ?? []), CANDIDATE_LIMIT) as { id: number }[];
      return rows.length > 0 ? [{ ids: rows.map((r) => r.id), weight }] : [];
    } catch (e) {
      // MATCH 串里混进 FTS5 语法字符时会抛，检索不到不该拖垮回复
      printError(`[Retrieve] 字面检索失败 (${match}): ${e}`);
      return [];
    }
  });
}

/**
 * 本群这段时间内的话题 id。向量检索是全库扫的，不先收窄的话候选池会被别的群吃掉——
 * 实测「有人养猫吗」的 top30 里一半是别的群的话题，过滤完本群只剩十几个
 */
function groupTopicIds(db: MemoryDatabase, groupId: number, since: number, speakerIds?: number[]): Set<number> {
  const rows = db.prepare(
    `SELECT t.id FROM topic t WHERE group_id = ? AND date_key >= ?
      ${speakerIds?.length ? `AND EXISTS (SELECT 1 FROM chat_line c WHERE c.group_id = t.group_id
        AND c.id BETWEEN t.line_from AND t.line_to AND c.user_id IN (${placeholders(speakerIds.length)}))` : ''}`,
  ).all(groupId, since, ...(speakerIds ?? [])) as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

/**
 * 话题命中之后，挑出话题里与查询最贴的几行。
 *
 * 取开头几行是不行的：话题跨度从几行到近百行不等，跨 58 行的「带猫看病」话题
 * 取开头 8 行，捞回来的是同一段对话里紧挨着的加班和痛车，猫在别处。
 * 完整词优先，单字重合仅作弱兜底，邻近上下文另行返回
 */
function pickTopicLines(
  db: MemoryDatabase,
  topic: { line_from: number, line_to: number },
  groupId: number,
  query: string,
  speakerIds?: number[],
): number[] {
  const rows = db.prepare(
    `SELECT id, text FROM chat_line WHERE id BETWEEN ? AND ? AND group_id = ? AND user_id != 0
      ${speakerIds?.length ? `AND user_id IN (${placeholders(speakerIds.length)})` : ''} ORDER BY id`,
  ).all(topic.line_from, topic.line_to, groupId, ...(speakerIds ?? [])) as { id: number, text: string }[];
  const terms = weightedTerms(query);
  const chars = new Set(terms.map((term) => term.term).join(''));

  // 重合度相同的保持对话顺序，短话题的表现和以前一致
  return rows.filter((row) => hasContent(row.text))
    .map((r, i) => {
      const body = stripSpeakerPrefix(r.text);
      let hit = 0;
      // 整词优先，字重合只作弱兜底；昵称和引文前缀不能给正文加分。
      terms.forEach(({ term, weight }) => { if (body.includes(term)) hit += 10 * weight; });
      chars.forEach((c) => { if (body.includes(c)) hit += 0.1; });
      return { id: r.id, hit, i };
    })
    .sort((a, b) => b.hit - a.hit || a.i - b.i)
    .slice(0, TOPIC_EXPAND_LIMIT)
    .map((r) => r.id);
}

function semanticChatIds(
  db: MemoryDatabase,
  groupId: number,
  query: string,
  vec: Float32Array,
  since: number,
  speakerIds?: number[],
): number[] {
  const allow = groupTopicIds(db, groupId, since, speakerIds);
  if (allow.size === 0) return [];

  const topics = searchSimilar(db, 'topic', vec, CANDIDATE_LIMIT, allow).filter((t) => t.score >= MIN_SIMILARITY);
  if (topics.length === 0) return [];

  const rows = db.prepare(
    `SELECT id, line_from, line_to FROM topic WHERE id IN (${placeholders(topics.length)})`,
  ).all(...topics.map((t) => t.refId)) as { id: number, line_from: number, line_to: number }[];

  // 话题只用于定位原文范围，正文排序不拿昵称凑相关性。
  const byId = new Map(rows.map((r) => [r.id, r]));

  // 按话题的相似度名次依次展开，同一话题内按相关性排，靠前的行拿到更好的名次
  return topics.flatMap(({ refId }) => {
    const topic = byId.get(refId);
    return topic ? pickTopicLines(db, topic, groupId, query, speakerIds) : [];
  });
}

/** CQ 码转成的占位符，剥掉之后才知道这行到底有没有内容 */
const PLACEHOLDER_RE = /\[[^\]]*\]/g;
const PUNCT_RE = /[\s\p{P}\p{S}]/gu;

/**
 * 至少要剩这么多个字才值得占一个注入名额。
 * 2 个字放得太宽——「不赖」「感觉」这种附和照样进结果，白占一条
 */
const MIN_CONTENT_CHARS = 4;

/**
 * 只发了个表情、图片或问号的行没有注入价值。
 * 话题展开会把整段对话里这类行一并带出来，不滤掉就是白占名额
 */
function hasContent(text: string): boolean {
  const body = stripSpeakerPrefix(text).replace(PLACEHOLDER_RE, '').replace(PUNCT_RE, '');
  return body.length >= MIN_CONTENT_CHARS;
}

function fetchChatLines(db: MemoryDatabase, ids: number[]) {
  const rows = db.prepare(
    `SELECT id, user_id, date_key, nick, text FROM chat_line WHERE id IN (${placeholders(ids.length)})`,
  ).all(...ids) as { id: number, user_id: number, date_key: number, nick: string | null, text: string }[];
  return new Map(rows.map((r) => [r.id, r]));
}

function adjacentContext(db: MemoryDatabase, groupId: number, row: { id: number, date_key: number }): string[] {
  return ['<', '>'].flatMap((operator) => {
    const neighbor = db.prepare(`SELECT text, user_id FROM chat_line
      WHERE group_id = ? AND date_key = ? AND id ${operator} ?
      ORDER BY id ${operator === '<' ? 'DESC' : 'ASC'} LIMIT 1`)
      .get(groupId, row.date_key, row.id) as { text: string, user_id: number } | undefined;
    if (!neighbor || !hasContent(neighbor.text)) return [];
    return [`${neighbor.user_id === 0 ? '[机器人] ' : ''}${neighbor.text.slice(0, 120)}`];
  });
}

export function isOverviewQuery(query: string): boolean {
  return /^(?:(?:个人|人物)?(?:档案|概况|简介|介绍|印象)|长期印象|性格和关系|(?:他|她|这个人|这人)?(?:是谁|是什么样的人|是个什么样的人))[？?。\s]*$/.test(query.trim());
}

/** 在某群的聊天记录里混合检索，按相关性降序返回最多 limit 条 */
export async function recallChat(
  groupId: number,
  opts: RecallChatOptions,
  db: MemoryDatabase = getMemoryDb(),
): Promise<ChatHit[]> {
  const {
    query, speakerIds, days = DEFAULT_DAYS, limit = DEFAULT_LIMIT,
  } = opts;
  const since = dateKeySince(Number.isFinite(days) && days > 0 ? Math.min(days, HISTORY_DAYS) : HISTORY_DAYS);

  const literal = literalChatLists(db, groupId, query, since, speakerIds);
  const vec = await resolveQueryVec(opts);
  const semantic = vec ? semanticChatIds(db, groupId, query, vec, since, speakerIds) : [];
  if (literal.length === 0 && semantic.length === 0) return [];

  const scores = rrfFuse([...literal, { ids: semantic }]);
  const lines = fetchChatLines(db, [...scores.keys()]);

  // 复读在群里很常见，「玩什么」连发三条会占掉三个名额，注入时只留最相关的那条
  const seen = new Set<string>();
  const topicCounts = new Map<number, number>();
  const topicOf = db.prepare(`SELECT id FROM topic WHERE group_id = ? AND date_key >= ?
    AND ? BETWEEN line_from AND line_to ORDER BY (line_to - line_from), id LIMIT 1`);

  return [...scores.entries()]
    .flatMap(([id, score]) => {
      const row = lines.get(id);
      if (!row || !hasContent(row.text)) return [];
      return [{ row, score }];
    })
    .sort((a, b) => b.score - a.score || b.row.id - a.row.id)
    .filter(({ row }) => {
      const body = `${row.user_id}:${stripSpeakerPrefix(row.text)}`;
      if (seen.has(body)) return false;
      const topic = topicOf.get(groupId, since, row.id) as { id: number } | undefined;
      if (topic) {
        const used = topicCounts.get(topic.id) ?? 0;
        if (used >= TOPIC_EXPAND_LIMIT) return false;
        topicCounts.set(topic.id, used + 1);
      }
      seen.add(body);
      return true;
    })
    .slice(0, limit)
    .map(({ row }) => ({
      id: row.id,
      date: formatDate(row.date_key),
      userId: row.user_id,
      nick: row.nick,
      text: row.text,
      context: adjacentContext(db, groupId, row),
    }));
}

// ========== 记忆条目 ==========

function memoryFilter(aboutUserIds?: number[]) {
  // 用户档案按 QQ 号跨群共享；memory.group_id 只记录最初来源群，不控制可见性。
  const where = [usableMemorySql()];
  const params: number[] = [];

  if (aboutUserIds?.length) {
    where.push("m.scope = 'user'", `m.owner_id IN (${placeholders(aboutUserIds.length)})`);
    params.push(...aboutUserIds);
  }
  return { where: where.join(' AND '), params };
}

function literalMemoryLists(db: MemoryDatabase, query: string, aboutUserIds?: number[]): RankedList[] {
  const { where, params } = memoryFilter(aboutUserIds);
  const stmt = db.prepare(`
    SELECT m.id FROM memory_fts f CROSS JOIN memory m ON m.id = f.rowid
    WHERE f.memory_fts MATCH ? AND ${where}
    ORDER BY bm25(memory_fts) LIMIT ?
  `);

  return buildTermQueries(query).flatMap(({ match, weight }) => {
    try {
      const rows = stmt.all(match, ...params, CANDIDATE_LIMIT) as { id: number }[];
      return rows.length > 0 ? [{ ids: rows.map((r) => r.id), weight }] : [];
    } catch (e) {
      printError(`[Retrieve] 记忆字面检索失败 (${match}): ${e}`);
      return [];
    }
  });
}

/**
 * 指名道姓要某人的档案时的兜底。
 *
 * 问「浅秋是个什么样的人」，检索词是「性格」「关系」这种抽象词，
 * 而存的是「爱发表情包」「脸盲严重」这种具体事实，字面对不上、
 * 向量也未必够近——但这类问句本来就该直接把档案端出来，不该空手而归
 */
function fallbackMemories(db: MemoryDatabase, aboutUserIds: number[], limit: number): MemoryHit[] {
  const { where, params } = memoryFilter(aboutUserIds);
  const rows = db.prepare(`
    SELECT m.id, m.scope, m.owner_id, m.kind, m.text, m.confidence, m.source
    FROM memory m WHERE ${where}
    ORDER BY m.pinned DESC, m.hits DESC, m.last_seen DESC, m.id LIMIT ?
  `).all(...params, limit) as any[];

  return rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    ownerId: r.owner_id,
    kind: r.kind,
    text: r.text,
    confidence: r.confidence,
    source: r.source,
  }));
}

/** 指定这几个人可见的全部记忆 id，用来把向量检索的范围先收窄 */
function ownedMemoryIds(db: MemoryDatabase, aboutUserIds?: number[]): Set<number> {
  const { where, params } = memoryFilter(aboutUserIds);
  const rows = db.prepare(`SELECT m.id FROM memory m WHERE ${where}`).all(...params) as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

function fetchMemories(db: MemoryDatabase, ids: number[], aboutUserIds?: number[]) {
  const { where, params } = memoryFilter(aboutUserIds);
  const rows = db.prepare(`
    SELECT m.id, m.scope, m.owner_id, m.kind, m.text, m.confidence, m.source
    FROM memory m WHERE m.id IN (${placeholders(ids.length)}) AND ${where}
  `).all(...ids, ...params) as any[];

  return new Map(rows.map((r) => [r.id as number, {
    id: r.id,
    scope: r.scope,
    ownerId: r.owner_id,
    kind: r.kind,
    text: r.text,
    confidence: r.confidence,
    source: r.source,
  } as MemoryHit]));
}

/** 在记忆库里混合检索。aboutUserIds 是硬过滤，问谁就只翻谁的档案 */
export async function recallMemory(
  _groupId: number,
  opts: RecallMemoryOptions,
  db: MemoryDatabase = getMemoryDb(),
): Promise<MemoryHit[]> {
  const { query, aboutUserIds, limit = DEFAULT_LIMIT } = opts;

  const literal = literalMemoryLists(db, query, aboutUserIds);
  const vec = await resolveQueryVec(opts);
  // 指定了人就把向量检索的范围先收到这些人的条目上，
  // 否则 top-30 会被别人的记忆占满，过滤完一条不剩
  const allow = ownedMemoryIds(db, aboutUserIds);
  const semantic = vec
    ? searchSimilar(db, 'memory', vec, CANDIDATE_LIMIT, allow)
      .filter((h) => h.score >= MIN_SIMILARITY).map((h) => h.refId)
    : [];

  const scores = rrfFuse([...literal, { ids: semantic }]);
  // 详情再做一次有效性检查，避免候选计算期间发生更新。
  const found = fetchMemories(db, [...scores.keys()], aboutUserIds);

  const ranked = [...scores.entries()]
    .flatMap(([id, score]) => {
      const hit = found.get(id);
      return hit ? [{ hit, score }] : [];
    })
    .sort((a, b) => b.score - a.score || b.hit.id - a.hit.id)
    .slice(0, limit)
    .map(({ hit }) => hit);

  // 兜底要看最终结果而不是候选：候选非空但详情已失效的情况同样算空手
  if (ranked.length === 0 && aboutUserIds?.length && (opts.overview === true || isOverviewQuery(query))) {
    return fallbackMemories(db, aboutUserIds, limit);
  }
  return ranked;
}
