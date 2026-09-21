import { embedTexts } from '@/service/llm';
import { printError, printLog } from '@/utils/print';
import { getMemoryDb, type MemoryDatabase } from './db';
import { saveEmbeddings } from './vector';
import { usableMemorySql } from './policy';

/**
 * 记忆条目的向量化队列。
 *
 * 抽取是在回复之后的后台任务里跑的，向量化再串行等一次网络往返就太久了，
 * 攒一批一起发，失败就丢回队列等下次
 */

/** 攒够这么多条立刻发一批 */
const BATCH_SIZE = 20;

/** 没攒够也不能一直等，最多拖这么久 */
const FLUSH_DELAY = 15 * 1000;

/** 服务端单次上限，超了会被 400 */
const MAX_PER_REQUEST = 200;

const pending = new Set<number>();
let timer: NodeJS.Timeout | null = null;
let flushing = false;

/** 把记忆条目排进向量化队列，不阻塞调用方 */
export function enqueueEmbedding(ids: number[]) {
  ids.forEach((id) => pending.add(id));
  if (pending.size === 0) return;

  if (pending.size >= BATCH_SIZE) {
    flushEmbedQueue().catch(() => { });
    return;
  }
  if (!timer) {
    timer = setTimeout(() => { flushEmbedQueue().catch(() => { }); }, FLUSH_DELAY);
    // 队列里还有东西不该拦着进程退出
    timer.unref?.();
  }
}

/** 把队列里的条目向量化，由攒够批次或计时器触发 */
async function flushEmbedQueue(db: MemoryDatabase = getMemoryDb()): Promise<number> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  // 同一时刻只跑一批，否则会重复请求同一批 id
  if (flushing || pending.size === 0) return 0;
  flushing = true;

  const batch = [...pending].slice(0, MAX_PER_REQUEST);
  batch.forEach((id) => pending.delete(id));

  try {
    // 期间被删掉或淘汰掉的条目不用再算向量
    const rows = db.prepare(
      `SELECT id, text FROM memory m WHERE ${usableMemorySql()} AND id IN (${batch.map(() => '?').join(', ')})`,
    ).all(...batch) as { id: number, text: string }[];
    if (rows.length === 0) return 0;

    const result = await embedTexts(rows.map((r) => r.text));
    if (!result) {
      // 整批失败就放回去，下次再试；不能只补一半，调用方是按下标对回条目的
      rows.forEach((r) => pending.add(r.id));
      printError(`[EmbedQueue] ${rows.length} 条向量化失败，已放回队列`);
      return 0;
    }

    const n = saveEmbeddings(db, 'memory', rows.map((r, i) => ({ refId: r.id, vec: result.vectors[i], sourceText: r.text })), result.model);
    printLog(`[EmbedQueue] 已向量化 ${n} 条记忆`);
    return n;
  } catch (e) {
    batch.forEach((id) => pending.add(id));
    printError(`[EmbedQueue] 向量化异常: ${e}`);
    return 0;
  } finally {
    flushing = false;
    // 一批装不下的、或失败放回的，接着排下一轮
    if (pending.size > 0 && !timer) {
      timer = setTimeout(() => { flushEmbedQueue().catch(() => { }); }, FLUSH_DELAY);
      timer.unref?.();
    }
  }
}
