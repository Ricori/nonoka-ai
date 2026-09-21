import { getMemoryDb, type MemoryDatabase } from './db';
import { historySince, usableMemorySql } from './policy';
import memoryStore from './store';
import { invalidateVectors } from './vector';

/** 冷层是既有 chat/*.txt 原始备份；这里只清在线派生索引，不动原始文件。 */
export function maintainMemory(db: MemoryDatabase = getMemoryDb()) {
  const since = historySince();
  const stats = db.transaction(() => {
    db.prepare('DELETE FROM chat_fts WHERE rowid IN (SELECT id FROM chat_line WHERE date_key < ?)').run(since);
    db.prepare("DELETE FROM embedding WHERE ref_kind = 'topic' AND ref_id IN (SELECT id FROM topic WHERE date_key < ?)").run(since);
    const topics = db.prepare('DELETE FROM topic WHERE date_key < ?').run(since).changes;
    const lines = db.prepare('DELETE FROM chat_line WHERE date_key < ?').run(since).changes;
    const owners = db.prepare("SELECT DISTINCT owner_id FROM memory WHERE scope = 'user' AND superseded_by IS NULL")
      .all() as { owner_id: number }[];
    let evicted = 0;
    owners.forEach(({ owner_id }) => { evicted += memoryStore.evict(owner_id, db).length; });
    const embeddings = db.prepare(`DELETE FROM embedding WHERE
      (ref_kind = 'memory' AND ref_id NOT IN (SELECT m.id FROM memory m WHERE ${usableMemorySql()}))
      OR (ref_kind = 'topic' AND ref_id NOT IN (SELECT id FROM topic))`).run().changes;
    db.prepare(`DELETE FROM memory_fts WHERE rowid NOT IN (SELECT m.id FROM memory m WHERE ${usableMemorySql()})`).run();
    // 超过热窗口的未完成计划不能把冷历史重新带回付费队列。
    const plans = db.prepare("SELECT key FROM meta WHERE key LIKE 'topic:v%:%'").all() as { key: string }[];
    const remove = db.prepare('DELETE FROM meta WHERE key = ?');
    plans.forEach(({ key }) => { if (Number(key.split(':').pop()) < since) remove.run(key); });
    return {
      since, lines, topics, embeddings, evicted,
    };
  }).immediate();
  invalidateVectors(db);
  return stats;
}
