import { embedTexts, segmentTopics } from '@/service/llm';
import { printError, printLog } from '@/utils/print';
import { backupDateKey } from '../storage/message';
import {
  getMemoryDb, getMeta, type MemoryDatabase,
} from './db';
import { ingestChatBackups } from './ingest';
import memoryStore from './store';
import {
  segmentTopicDay, topicBudgetRemaining, topicDayBacklog, topicSettings, topicSince, topicWatermarkKey, type TopicOptions,
} from './topic';
import { saveEmbeddings, type RefKind } from './vector';
import { historySince, usableMemorySql } from './policy';
import { maintainMemory } from './maintenance';

export { dayProgressKey, topicWatermarkKey } from './topic';

/**
 * 每日巩固：把昨天以前的日志切成话题并向量化，补齐漏掉的向量，再跑一遍淘汰。
 *
 * 向量化的是话题而不是每条消息——话题数量是 O(千)，消息是 O(百万)。
 * 话题的一句话概括本身就是语义检索的载体，比单条「好困」有意义得多
 */

/** 每轮最多处理几天。首次跑有几十天积压，分批消化，别一次把额度打满 */
const MAX_DAYS_PER_RUN = 3;

/** 每轮最多调几次 /llm/topic，给成本封顶 */
const MAX_CHUNKS_PER_RUN = 40;

/**
 * 同时发几个切话题请求。实测单次要 40~80s，串行跑完一天两三千行要半小时以上，
 * 首次那几十天的积压根本消化不动。段与段之间互不依赖，可以并发
 */
const CHUNK_CONCURRENCY = 3;

/** 向量化的批大小，服务端单次上限 200 */
const EMBED_BATCH = 200;

/** 覆盖每轮的封顶与并发，用于本地一次性消化历史积压 */
export interface ConsolidateOptions extends TopicOptions {
  maxDays?: number;
  maxChunks?: number;
  concurrency?: number;
}

export interface ConsolidateStats {
  ingestedLines: number;
  topicCalls?: number;
  topicFailures?: number;
  days: number;
  topics: number;
  embedded: number;
  evicted: number;
  /** 被上游内容审核拒收、只能跳过的段数 */
  skipped: number;
}

export interface ConsolidationBacklog {
  days: number;
  chunks: number;
  lines: number;
  oldestDate: number | null;
}

export interface ConsolidationRun {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  status: 'running' | 'success' | 'failed';
  pendingDaysBefore: number;
  pendingChunksBefore: number;
  pendingLinesBefore: number;
  pendingDaysAfter: number | null;
  pendingChunksAfter: number | null;
  pendingLinesAfter: number | null;
  oldestPendingDate: number | null;
  ingestedLines: number;
  processedDays: number;
  topics: number;
  embedded: number;
  evicted: number;
  skipped: number;
  error: string | null;
}

/** 分批向量化并入库，返回成功条数 */
async function embedAll(
  db: MemoryDatabase,
  refKind: RefKind,
  rows: { id: number, text: string }[],
): Promise<number> {
  let done = 0;
  for (let i = 0; i < rows.length; i += EMBED_BATCH) {
    const batch = rows.slice(i, i + EMBED_BATCH);
    const vectors = await embedTexts(batch.map((r) => r.text));
    if (!vectors) {
      // 整批失败就跳过，下轮巩固还会把它们当成缺向量的重新捞出来
      printError(`[Consolidate] ${batch.length} 条 ${refKind} 向量化失败`);
    } else {
      done += saveEmbeddings(db, refKind, batch.map((r, j) => ({ refId: r.id, vec: vectors[j], sourceText: r.text })));
    }
  }
  return done;
}

/** 找出这个群还没切过话题的日子（不含今天，今天还在追加） */
function pendingDays(db: MemoryDatabase, groupId: number, limit: number, since: number): number[] {
  const done = Number(getMeta(db, topicWatermarkKey(groupId)) ?? 0);
  const today = Number(backupDateKey());
  const rows = db.prepare(
    'SELECT DISTINCT date_key FROM chat_line WHERE group_id = ? AND date_key > ? AND date_key < ? AND date_key >= ? ORDER BY date_key LIMIT ?',
  ).all(groupId, done, today, since, limit) as { date_key: number }[];
  return rows.map((r) => r.date_key);
}

/** 与执行共用过滤、分段和历史范围，统计的是仍需付费处理的工作。 */
export function getConsolidationBacklog(
  groupIds: number[],
  db: MemoryDatabase = getMemoryDb(),
  opts: TopicOptions = {},
): ConsolidationBacklog {
  const today = Number(backupDateKey());
  const since = topicSince(topicSettings(opts).lookbackDays);
  const result: ConsolidationBacklog = {
    days: 0, chunks: 0, lines: 0, oldestDate: null,
  };

  [...new Set(groupIds)].forEach((groupId) => {
    const done = Number(getMeta(db, topicWatermarkKey(groupId)) ?? 0);
    const rows = db.prepare(`
      SELECT DISTINCT date_key AS dateKey
      FROM chat_line
      WHERE group_id = ? AND date_key > ? AND date_key < ? AND date_key >= ?
      ORDER BY date_key
    `).all(groupId, done, today, since) as { dateKey: number }[];

    rows.forEach(({ dateKey }) => {
      const { chunks: remainingChunks, lines: remainingLines } = topicDayBacklog(db, groupId, dateKey);
      result.days += 1;
      result.lines += remainingLines;
      result.chunks += remainingChunks;
      if (result.oldestDate === null || dateKey < result.oldestDate) result.oldestDate = dateKey;
    });
  });
  return result;
}

/** 补齐缺向量的记忆和话题。抽取时服务不可用、或上面切话题时向量化失败的，都靠这里兜住 */
async function backfillMissingVectors(db: MemoryDatabase): Promise<number> {
  const memories = db.prepare(`
    SELECT m.id, m.text FROM memory m
    LEFT JOIN embedding e ON e.ref_kind = 'memory' AND e.ref_id = m.id
    WHERE ${usableMemorySql()} AND e.ref_id IS NULL ORDER BY m.id LIMIT 100
  `).all() as { id: number, text: string }[];

  const topics = db.prepare(`
    SELECT t.id, t.summary AS text FROM topic t
    LEFT JOIN embedding e ON e.ref_kind = 'topic' AND e.ref_id = t.id
    WHERE e.ref_id IS NULL AND t.date_key >= ${historySince()} ORDER BY t.id LIMIT 200
  `).all() as { id: number, text: string }[];

  return await embedAll(db, 'memory', memories) + await embedAll(db, 'topic', topics);
}

/**
 * 跑一次巩固。groupIds 是要切话题的群（默认取 initiativeList），
 * 字面索引对所有群都建，但切话题要花 LLM 调用，只对会主动插话的群做
 */
export async function consolidateMemory(
  groupIds: number[],
  db: MemoryDatabase = getMemoryDb(),
  opts: ConsolidateOptions = {},
): Promise<ConsolidateStats> {
  const maxDays = opts.maxDays ?? MAX_DAYS_PER_RUN;
  const concurrency = opts.concurrency ?? CHUNK_CONCURRENCY;
  const maxChunks = opts.maxChunks ?? MAX_CHUNKS_PER_RUN;
  if (![maxDays, concurrency].every((n) => Number.isSafeInteger(n) && n > 0)
    || !Number.isSafeInteger(maxChunks) || maxChunks < 0) throw new Error('巩固天数、并发必须为正整数，调用上限必须为非负整数');
  const settings = topicSettings(opts);
  const stats: ConsolidateStats = {
    ingestedLines: 0, days: 0, topics: 0, embedded: 0, evicted: 0, skipped: 0, topicCalls: 0, topicFailures: 0,
  };

  // 1. 先把新备份行导进来，话题要从 chat_line 里取
  maintainMemory(db);
  stats.ingestedLines = ingestChatBackups(db).lines;

  // 2. 切话题 + 向量化，天数和调用次数都封顶
  let chunkBudget = maxChunks;
  for (const groupId of [...new Set(groupIds)]) {
    if (chunkBudget <= 0 || topicBudgetRemaining(db, settings.dailyLimit) === 0) break;
    for (const dateKey of pendingDays(db, groupId, maxDays, topicSince(settings.lookbackDays))) {
      if (chunkBudget <= 0 || topicBudgetRemaining(db, settings.dailyLimit) === 0) break;
      const day = await segmentTopicDay(db, groupId, dateKey, {
        maxCalls: chunkBudget, concurrency, dailyLimit: settings.dailyLimit,
      }, segmentTopics);
      chunkBudget -= day.calls;
      stats.topicCalls! += day.calls;
      stats.topicFailures! += day.failed;
      stats.topics += day.created.length;
      stats.skipped += day.skipped;
      stats.embedded += await embedAll(db, 'topic', day.created);
      printLog(`[Consolidate] 群 ${groupId} ${dateKey}：计划过滤 ${day.filtered} 行，本轮 topic 调用 ${day.calls} 次，失败 ${day.failed} 次`);
      if (!day.complete) break;
      stats.days += 1;
    }
  }

  // 3. 补齐漏掉的向量：抽取时服务不可用、或上面某批向量化失败的，都在这里兜住
  stats.embedded += await backfillMissingVectors(db);

  // 4. 淘汰。分数里已经含时间衰减，不需要另外写一遍「衰减」
  const owners = db.prepare(
    "SELECT DISTINCT owner_id FROM memory WHERE scope = 'user' AND superseded_by IS NULL",
  ).all() as { owner_id: number }[];
  owners.forEach(({ owner_id }) => {
    stats.evicted += memoryStore.evict(owner_id, db).length;
  });

  printLog(`[Consolidate] 导入 ${stats.ingestedLines} 行、切了 ${stats.days} 天共 ${stats.topics} 个话题、`
    + `topic 调用 ${stats.topicCalls} 次（失败 ${stats.topicFailures} 次，今日剩余额度 ${topicBudgetRemaining(db, settings.dailyLimit)}）、`
    + `向量化 ${stats.embedded} 条、淘汰 ${stats.evicted} 条`
    + `${stats.skipped > 0 ? `、跳过 ${stats.skipped} 段（内容审核拒收）` : ''}`);
  return stats;
}

/** Run one scheduled consolidation and persist its lifecycle plus before/after backlog. */
export async function consolidateMemoryTracked(
  groupIds: number[],
  db: MemoryDatabase = getMemoryDb(),
  runner: (ids: number[], database: MemoryDatabase) => Promise<ConsolidateStats> = consolidateMemory,
): Promise<ConsolidateStats> {
  const before = getConsolidationBacklog(groupIds, db);
  const startedAt = Date.now();
  const info = db.prepare(`
    INSERT INTO consolidation_run
      (started_at, status, pending_days_before, pending_chunks_before,
       pending_lines_before, oldest_pending_date)
    VALUES (?, 'running', ?, ?, ?, ?)
  `).run(startedAt, before.days, before.chunks, before.lines, before.oldestDate);
  const runId = Number(info.lastInsertRowid);

  try {
    const stats = await runner(groupIds, db);
    const after = getConsolidationBacklog(groupIds, db);
    db.prepare(`
      UPDATE consolidation_run SET
        finished_at = ?, status = 'success', pending_days_after = ?,
        pending_chunks_after = ?, pending_lines_after = ?, oldest_pending_date = ?,
        ingested_lines = ?, processed_days = ?, topics = ?, embedded = ?,
        evicted = ?, skipped = ?
      WHERE id = ?
    `).run(
      Date.now(),
      after.days,
      after.chunks,
      after.lines,
      after.oldestDate,
      stats.ingestedLines,
      stats.days,
      stats.topics,
      stats.embedded,
      stats.evicted,
      stats.skipped,
      runId,
    );
    return stats;
  } catch (error) {
    const after = getConsolidationBacklog(groupIds, db);
    db.prepare(`
      UPDATE consolidation_run SET
        finished_at = ?, status = 'failed', pending_days_after = ?,
        pending_chunks_after = ?, pending_lines_after = ?, oldest_pending_date = ?, error = ?
      WHERE id = ?
    `).run(
      Date.now(),
      after.days,
      after.chunks,
      after.lines,
      after.oldestDate,
      String(error).slice(0, 2000),
      runId,
    );
    throw error;
  }
}

/** Recent scheduled runs for the admin panel. */
export function listConsolidationRuns(
  db: MemoryDatabase = getMemoryDb(),
  limit = 10,
): ConsolidationRun[] {
  return db.prepare(`
    SELECT id, started_at AS startedAt, finished_at AS finishedAt, status,
      pending_days_before AS pendingDaysBefore,
      pending_chunks_before AS pendingChunksBefore,
      pending_lines_before AS pendingLinesBefore,
      pending_days_after AS pendingDaysAfter,
      pending_chunks_after AS pendingChunksAfter,
      pending_lines_after AS pendingLinesAfter,
      oldest_pending_date AS oldestPendingDate,
      ingested_lines AS ingestedLines, processed_days AS processedDays,
      topics, embedded, evicted, skipped, error
    FROM consolidation_run ORDER BY id DESC LIMIT ?
  `).all(Math.max(1, Math.min(50, limit))) as ConsolidationRun[];
}
