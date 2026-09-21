import { embedTexts } from '@/service/llm';
import { printError, printLog } from '@/utils/print';
import { getMemoryDb, type MemoryDatabase } from './db';
import { ingestChatBackups } from './ingest';
import memoryStore from './store';
import { saveEmbeddings, type RefKind } from './vector';
import { buildWindows } from './window';
import { historySince, usableMemorySql } from './policy';
import { maintainMemory } from './maintenance';

/**
 * 定时巩固：导入新日志、切语义窗口、补齐缺失的向量，再跑一遍淘汰。
 * 全程不调 chat 模型，只花 embedding
 */

/** 向量化的批大小，服务端单次上限 200 */
const EMBED_BATCH = 200;

/** 窗口正文长，批小一点，别让单次请求撞上超时 */
const WINDOW_EMBED_BATCH = 100;

/** 补向量最多跑几轮。换模型后要把 45 天内的全部重算，每轮只捞一批，得循环 */
const BACKFILL_ROUNDS = 30;

export interface ConsolidateStats {
  ingestedLines: number;
  /** 新切的语义窗口数 */
  windows: number;
  embedded: number;
  evicted: number;
}

export interface ConsolidationBacklog {
  /** 已切好但还没有向量的窗口 */
  windows: number;
  /** 还没有向量的有效记忆 */
  memories: number;
  /** 最早一个缺向量窗口的日期 */
  oldestDate: number | null;
}

export interface ConsolidationRun {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  status: 'running' | 'success' | 'failed';
  pendingBefore: number;
  pendingAfter: number | null;
  oldestPendingDate: number | null;
  ingestedLines: number;
  windows: number;
  embedded: number;
  evicted: number;
  error: string | null;
}

/** 分批向量化并入库，返回成功条数 */
async function embedAll(
  db: MemoryDatabase,
  refKind: RefKind,
  rows: { id: number, text: string }[],
): Promise<number> {
  const size = refKind === 'window' ? WINDOW_EMBED_BATCH : EMBED_BATCH;
  let done = 0;
  for (let i = 0; i < rows.length; i += size) {
    const batch = rows.slice(i, i + size);
    const result = await embedTexts(batch.map((r) => r.text));
    if (!result) {
      // 整批失败就跳过，下轮巩固还会把它们当成缺向量的重新捞出来
      printError(`[Consolidate] ${batch.length} 条 ${refKind} 向量化失败`);
    } else {
      done += saveEmbeddings(db, refKind, batch.map((r, j) => ({ refId: r.id, vec: result.vectors[j], sourceText: r.text })), result.model);
    }
  }
  return done;
}

const MISSING_MEMORY_SQL = () => `FROM memory m
  LEFT JOIN embedding e ON e.ref_kind = 'memory' AND e.ref_id = m.id
  WHERE ${usableMemorySql()} AND e.ref_id IS NULL`;

const MISSING_WINDOW_SQL = () => `FROM chat_window w
  LEFT JOIN embedding e ON e.ref_kind = 'window' AND e.ref_id = w.id
  WHERE e.ref_id IS NULL AND w.date_key >= ${historySince()}`;

/** 还缺多少向量。窗口每轮都会切齐，真正会积压的只有向量化 */
export function getConsolidationBacklog(db: MemoryDatabase = getMemoryDb()): ConsolidationBacklog {
  const w = db.prepare(`SELECT count(*) AS n, min(w.date_key) AS oldest ${MISSING_WINDOW_SQL()}`).get() as { n: number, oldest: number | null };
  const m = db.prepare(`SELECT count(*) AS n ${MISSING_MEMORY_SQL()}`).get() as { n: number };
  return { windows: w.n, memories: m.n, oldestDate: w.oldest };
}

async function backfillOnce(db: MemoryDatabase): Promise<number> {
  const memories = db.prepare(`SELECT m.id, m.text ${MISSING_MEMORY_SQL()} ORDER BY m.id LIMIT 500`).all() as { id: number, text: string }[];
  const windows = db.prepare(`SELECT w.id, w.text ${MISSING_WINDOW_SQL()} ORDER BY w.id LIMIT 2000`).all() as { id: number, text: string }[];
  return await embedAll(db, 'memory', memories) + await embedAll(db, 'window', windows);
}

/** 补齐缺向量的记忆和窗口。服务不可用时漏掉的、换模型后被清空的，都靠这里兜住 */
async function backfillMissingVectors(db: MemoryDatabase): Promise<number> {
  let total = 0;
  for (let round = 0; round < BACKFILL_ROUNDS; round++) {
    const n = await backfillOnce(db);
    // 缺的都补完了，或这一轮全部失败，都别再空转
    if (n === 0) break;
    total += n;
  }
  return total;
}

/**
 * 跑一次巩固。groupIds 是要切语义窗口的群（默认取 initiativeList），
 * 字面索引对所有群都建，窗口要花 embedding，只对会主动插话的群做
 */
export async function consolidateMemory(
  groupIds: number[],
  db: MemoryDatabase = getMemoryDb(),
): Promise<ConsolidateStats> {
  const stats: ConsolidateStats = {
    ingestedLines: 0, windows: 0, embedded: 0, evicted: 0,
  };

  // 1. 先把新备份行导进来，窗口要从 chat_line 里取
  maintainMemory(db);
  stats.ingestedLines = ingestChatBackups(db).lines;

  // 2. 切语义窗口，今天的满员窗口也算；向量统一在下一步补
  [...new Set(groupIds)].forEach((groupId) => {
    stats.windows += buildWindows(db, groupId, historySince()).length;
  });

  // 3. 补向量：新窗口、抽取时服务不可用漏掉的记忆、换模型后被清空的，一并补齐
  stats.embedded = await backfillMissingVectors(db);

  // 4. 淘汰。分数里已经含时间衰减，不需要另外写一遍「衰减」
  const owners = db.prepare(
    "SELECT DISTINCT owner_id FROM memory WHERE scope = 'user'",
  ).all() as { owner_id: number }[];
  owners.forEach(({ owner_id }) => {
    stats.evicted += memoryStore.evict(owner_id, db).length;
  });

  printLog(`[Consolidate] 导入 ${stats.ingestedLines} 行、新增 ${stats.windows} 个语义窗口、`
    + `向量化 ${stats.embedded} 条、淘汰 ${stats.evicted} 条`);
  return stats;
}

const pendingOf = (b: ConsolidationBacklog) => b.windows + b.memories;

/** 跑一次定时巩固，把起止状态和前后积压记进 consolidation_run，给管理面板看 */
export async function consolidateMemoryTracked(
  groupIds: number[],
  db: MemoryDatabase = getMemoryDb(),
  runner: (ids: number[], database: MemoryDatabase) => Promise<ConsolidateStats> = consolidateMemory,
): Promise<ConsolidateStats> {
  const before = getConsolidationBacklog(db);
  const info = db.prepare(`
    INSERT INTO consolidation_run (started_at, status, pending_before, oldest_pending_date)
    VALUES (?, 'running', ?, ?)
  `).run(Date.now(), pendingOf(before), before.oldestDate);
  const runId = Number(info.lastInsertRowid);

  try {
    const stats = await runner(groupIds, db);
    const after = getConsolidationBacklog(db);
    db.prepare(`
      UPDATE consolidation_run SET
        finished_at = ?, status = 'success', pending_after = ?, oldest_pending_date = ?,
        ingested_lines = ?, windows = ?, embedded = ?, evicted = ?
      WHERE id = ?
    `).run(Date.now(), pendingOf(after), after.oldestDate, stats.ingestedLines, stats.windows, stats.embedded, stats.evicted, runId);
    return stats;
  } catch (error) {
    const after = getConsolidationBacklog(db);
    db.prepare(`
      UPDATE consolidation_run SET
        finished_at = ?, status = 'failed', pending_after = ?, oldest_pending_date = ?, error = ?
      WHERE id = ?
    `).run(Date.now(), pendingOf(after), after.oldestDate, String(error).slice(0, 2000), runId);
    throw error;
  }
}

/** 最近几次定时巩固，给管理面板看 */
export function listConsolidationRuns(
  db: MemoryDatabase = getMemoryDb(),
  limit = 10,
): ConsolidationRun[] {
  return db.prepare(`
    SELECT id, started_at AS startedAt, finished_at AS finishedAt, status,
      pending_before AS pendingBefore, pending_after AS pendingAfter,
      oldest_pending_date AS oldestPendingDate, ingested_lines AS ingestedLines,
      windows, embedded, evicted, error
    FROM consolidation_run ORDER BY id DESC LIMIT ?
  `).all(Math.max(1, Math.min(50, limit))) as ConsolidationRun[];
}
