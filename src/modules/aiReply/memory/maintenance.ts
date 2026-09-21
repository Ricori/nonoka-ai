import { getMemoryDb, type MemoryDatabase } from './db';
import { historySince, usableMemorySql } from './policy';
import memoryStore from './store';
import { invalidateVectors } from './vector';

/** 冷层是既有 chat/*.txt 原始备份；这里只清在线派生索引，不动原始文件。 */
export function maintainMemory(db: MemoryDatabase = getMemoryDb()) {
  const since = historySince();
  const stats = db.transaction(() => {
    db.prepare('DELETE FROM chat_fts WHERE rowid IN (SELECT id FROM chat_line WHERE date_key < ?)').run(since);
    db.prepare("DELETE FROM embedding WHERE ref_kind = 'window' AND ref_id IN (SELECT id FROM chat_window WHERE date_key < ?)").run(since);
    const windows = db.prepare('DELETE FROM chat_window WHERE date_key < ?').run(since).changes;
    const lines = db.prepare('DELETE FROM chat_line WHERE date_key < ?').run(since).changes;
    const owners = db.prepare("SELECT DISTINCT owner_id FROM memory WHERE scope = 'user'")
      .all() as { owner_id: number }[];
    let evicted = 0;
    owners.forEach(({ owner_id }) => { evicted += memoryStore.evict(owner_id, db).length; });
    const embeddings = db.prepare(`DELETE FROM embedding WHERE
      (ref_kind = 'memory' AND ref_id NOT IN (SELECT m.id FROM memory m WHERE ${usableMemorySql()}))
      OR (ref_kind = 'window' AND ref_id NOT IN (SELECT id FROM chat_window))`).run().changes;
    db.prepare(`DELETE FROM memory_fts WHERE rowid NOT IN (SELECT m.id FROM memory m WHERE ${usableMemorySql()})`).run();
    return {
      since, lines, windows, embeddings, evicted,
    };
  }).immediate();
  // 每天滚动删掉的旧行、覆盖写的向量会留下空页，不还回去文件只涨不缩（auto_vacuum=INCREMENTAL 的库才有效）
  db.pragma('incremental_vacuum');
  invalidateVectors(db);
  return stats;
}
