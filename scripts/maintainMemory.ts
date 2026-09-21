import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createMemoryDb } from '@/modules/aiReply/memory/db';
import { maintainMemory } from '@/modules/aiReply/memory/maintenance';
import { historySince, usableMemorySql } from '@/modules/aiReply/memory/policy';

/** 默认只读预览；--apply 先做 SQLite 一致性备份，再迁移、清理及收缩热库。不调用模型。 */
const file = path.resolve('data/memory/nonoka.db');
const read = new Database(file, { readonly: true, fileMustExist: true });
const since = historySince();
console.log(JSON.stringify({
  since,
  oldChatLines: (read.prepare('SELECT count(*) n FROM chat_line WHERE date_key < ?').get(since) as { n: number }).n,
  oldTopics: (read.prepare('SELECT count(*) n FROM topic WHERE date_key < ?').get(since) as { n: number }).n,
  beforeBytes: fs.statSync(file).size,
}, null, 2));

try {
  if (process.argv.includes('--apply')) {
    const directory = path.resolve('data/memory/backups');
    fs.mkdirSync(directory, { recursive: true });
    const backup = path.join(directory, `nonoka-before-maintenance-${Date.now()}.db`);
    await read.backup(backup);
    console.log(`一致性备份：${backup}`);
  } else console.log('只读预览。传 --apply 执行；原始聊天备份不删除。');
} finally { read.close(); }

if (process.argv.includes('--apply')) {
  const db = createMemoryDb(file);
  try {
    const stats = maintainMemory(db);
    db.exec("INSERT INTO chat_fts(chat_fts) VALUES ('optimize'); INSERT INTO memory_fts(memory_fts) VALUES ('optimize');");
    db.exec('VACUUM');
    db.pragma('wal_checkpoint(TRUNCATE)');
    const pending = db.prepare(`SELECT count(*) n FROM memory m LEFT JOIN embedding e
      ON e.ref_kind = 'memory' AND e.ref_id = m.id WHERE ${usableMemorySql()} AND e.ref_id IS NULL`).get() as { n: number };
    const quarantined = db.prepare("SELECT count(*) n FROM memory WHERE superseded_by IS NULL AND kind IN ('alias','relation') AND verified=0 AND pinned=0").get() as { n: number };
    console.log(JSON.stringify({
      ...stats,
      afterBytes: fs.statSync(file).size,
      pendingMemoryEmbeddings: pending.n,
      quarantinedIdentities: quarantined.n,
      integrity: db.pragma('quick_check', { simple: true }),
    }, null, 2));
  } finally { db.close(); }
}
