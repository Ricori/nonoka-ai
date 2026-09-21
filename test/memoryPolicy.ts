import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createMemoryDb, getMeta, setMeta } from '@/modules/aiReply/memory/db';
import memoryStore from '@/modules/aiReply/memory/store';
import { maintainMemory } from '@/modules/aiReply/memory/maintenance';
import { recallChat, recallMemory, rrfFuse } from '@/modules/aiReply/memory/retrieve';
import { saveEmbeddings, searchSimilar } from '@/modules/aiReply/memory/vector';
import { isSelfMemoryCandidate } from '@/modules/aiReply/memory/extract';
import { historySince, usableMemory } from '@/modules/aiReply/memory/policy';
import { ingestChatBackups } from '@/modules/aiReply/memory/ingest';
import { backupDateKey, CHAT_BACKUP_DIR } from '@/modules/aiReply/storage/message';
import { segment } from '@/modules/aiReply/memory/segment';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nonoka-policy-'));
const db = createMemoryDb(path.join(dir, 'test.db'));
const vec = Float32Array.from([1, 0, 0]);
const files: string[] = [];
try {
  assert.deepEqual(['我住在广州', '我最近在玩塞尔达', '我上周通关了游戏'].map(isSelfMemoryCandidate), [true, true, true]);
  assert.deepEqual(['小王喜欢猫', '我朋友在北京工作', '我觉得小王是研究生', '他说“我住在北京”', '我是什么专业？'].map(isSelfMemoryCandidate), [false, false, false, false, false]);
  console.log('✓ 本人陈述与转述、问句、他人主语分离');

  const id = memoryStore.applyOps(1, 1, [{ op: 'ADD', kind: 'trait', text: '住在广州' }], db).added[0];
  saveEmbeddings(db, 'memory', [{ refId: id, vec, sourceText: '住在广州' }]);
  assert.equal(searchSimilar(db, 'memory', vec, 5).length, 1);
  memoryStore.applyOps(1, 1, [{ op: 'UPDATE', id, text: '住在上海' }], db);
  assert.equal(searchSimilar(db, 'memory', vec, 5).length, 0);
  assert.equal(saveEmbeddings(db, 'memory', [{ refId: id, vec, sourceText: '住在广州' }]), 0);
  assert.equal(saveEmbeddings(db, 'memory', [{ refId: id, vec, sourceText: '住在上海' }]), 1);
  memoryStore.applyOps(1, 1, [{ op: 'DELETE', id }], db);
  assert.equal(searchSimilar(db, 'memory', vec, 5).length, 0);
  assert.equal(saveEmbeddings(db, 'memory', [{ refId: id, vec, sourceText: '住在上海' }]), 0);
  console.log('✓ 自动更新/删除立即摘除向量，网络迟到结果不能写回');

  const normal = memoryStore.applyOps(2, 1, [{ op: 'ADD', kind: 'trait', text: '喜欢爬山' }], db).added[0];
  const blocked = memoryStore.applyOps(2, 1, [
    { op: 'ADD', kind: 'alias', text: '别人的名字' },
    { op: 'ADD', kind: 'relation', text: '是小王的同桌' },
    { op: 'UPDATE', id: normal, kind: 'alias', text: '张三' },
    { op: 'ADD', kind: 'trait', text: '昵称是张三' },
  ], db);
  assert.equal(blocked.blocked, 4);
  const legacy = memoryStore.addMemory({ ownerId: 2, kind: 'alias', text: '张三' }, db);
  db.prepare('UPDATE memory SET verified = 0 WHERE id = ?').run(legacy);
  memoryStore.noteNickName(1, 2, '当前昵称', db);
  assert.ok(!memoryStore.formatMemoryLine(2, 1, db)?.includes('张三'));
  assert.ok(!memoryStore.getManualAliases(db).has(2));
  assert.equal((await recallMemory(1, { query: '张三', aboutUserIds: [2], semantic: false }, db)).length, 0);
  maintainMemory(db);
  assert.ok(memoryStore.getMemory(legacy, db));
  memoryStore.updateMemory(legacy, { text: '张三' }, db);
  assert.deepEqual(memoryStore.getManualAliases(db).get(2), ['张三']);
  assert.equal((await recallMemory(1, { query: '张三', aboutUserIds: [2], semantic: false }, db)).length, 1);
  console.log('✓ 身份条目不能自动新增、改型或伪装，旧身份隔离后可人工确认恢复');

  assert.equal((await recallMemory(1, { query: '毕业学校', aboutUserIds: [2], semantic: false }, db)).length, 0);
  assert.ok((await recallMemory(1, { query: '个人档案', aboutUserIds: [2], semantic: false }, db)).length > 0);
  const same = rrfFuse([{ ids: [1, 1, 1] }]);
  assert.equal(same.get(1), rrfFuse([{ ids: [1] }]).get(1));
  for (let i = 0; i < 35; i++) {
    const stale = memoryStore.applyOps(3, 1, [{ op: 'ADD', text: `旧事实${i}` }], db).added[0];
    saveEmbeddings(db, 'memory', [{ refId: stale, vec }]);
  }
  saveEmbeddings(db, 'memory', [{ refId: normal, vec: [0.8, 0.6, 0] }]);
  searchSimilar(db, 'memory', vec, 30);
  db.prepare('UPDATE memory SET superseded_by = -1 WHERE owner_id = 3').run();
  const valid = await recallMemory(1, { query: '完全不匹配的查询', queryVec: vec }, db);
  assert.ok(valid.some((hit) => hit.id === normal));
  assert.ok(valid.every((hit) => hit.ownerId !== 3));
  console.log('✓ 具体事实不再用其他档案兜底，失效候选和重复排名不能挤掉有效证据');

  for (const kind of ['alias', 'relation', 'trait', 'episode'] as const) {
    for (let i = 0; i < 15; i++) memoryStore.addMemory({ ownerId: 4, kind, text: `${kind}-${i}` }, db);
  }
  const pinned = memoryStore.addMemory({ ownerId: 4, kind: 'trait', text: '人工置顶保留', pinned: true }, db);
  memoryStore.evict(4, db);
  assert.equal(memoryStore.listUserMemories(4, db).filter((m) => !m.pinned && usableMemory(m)).length, 14);
  assert.ok(memoryStore.getMemory(pinned, db));
  console.log('✓ 非置顶记忆总数 14，人工置顶例外');

  const group = 88008080;
  const oldDay = Number(backupDateKey(new Date(Date.now() - 60 * 86400000)));
  const today = Number(backupDateKey());
  const insert = db.prepare('INSERT INTO chat_line (group_id,user_id,date_key,seq,nick,text) VALUES (?,1,?,0,?,?)');
  const oldId = Number(insert.run(group, oldDay, '用户', '[用户]说：旧拉面记录').lastInsertRowid);
  const hotId = Number(insert.run(group, today, '用户', '[用户]说：新的拉面记录').lastInsertRowid);
  db.prepare('INSERT INTO chat_fts(rowid,seg) VALUES (?,?)').run(oldId, segment('旧拉面记录'));
  db.prepare('INSERT INTO chat_fts(rowid,seg) VALUES (?,?)').run(hotId, segment('新的拉面记录'));
  const topic = db.prepare('INSERT INTO topic(group_id,date_key,summary,user_ids,line_from,line_to) VALUES (?,?,?,?,?,?)');
  const oldTopic = Number(topic.run(group, oldDay, '旧拉面', '[1]', oldId, oldId).lastInsertRowid);
  const hotTopic = Number(topic.run(group, today, '新拉面', '[1]', hotId, hotId).lastInsertRowid);
  saveEmbeddings(db, 'topic', [{ refId: oldTopic, vec }, { refId: hotTopic, vec }]);
  assert.deepEqual(searchSimilar(db, 'topic', vec, 5).map((hit) => hit.refId), [hotTopic]);
  assert.deepEqual((await recallChat(group, { query: '拉面', days: 365, semantic: false }, db)).map((hit) => hit.id), [hotId]);
  const stats = maintainMemory(db);
  assert.equal(stats.lines, 1);
  assert.equal(db.prepare('SELECT rowid FROM chat_fts WHERE rowid = ?').get(oldId), undefined);
  assert.equal(db.prepare('SELECT id FROM topic WHERE id = ?').get(oldTopic), undefined);
  assert.equal(saveEmbeddings(db, 'topic', [{ refId: oldTopic, vec, sourceText: '旧拉面' }]), 0);
  fs.mkdirSync(CHAT_BACKUP_DIR, { recursive: true });
  const oldFile = path.join(CHAT_BACKUP_DIR, `${group}_${oldDay}.txt`);
  assert.ok(!fs.existsSync(oldFile));
  fs.writeFileSync(oldFile, '[1][用户]说：旧拉面记录\n');
  files.push(oldFile);
  ingestChatBackups(db, [group]);
  assert.equal((db.prepare('SELECT count(*) n FROM chat_line WHERE date_key < ?').get(historySince()) as { n: number }).n, 0);
  assert.ok(fs.existsSync(oldFile));
  console.log('✓ 冷数据退出原文索引/话题/向量，导入不复活，原始备份保留');

  const migrationPath = path.join(dir, 'migration.db');
  const legacyDb = createMemoryDb(migrationPath);
  const legacyId = memoryStore.addMemory({ ownerId: 6, kind: 'alias', text: '旧别名' }, legacyDb);
  const manualId = memoryStore.addMemory({ ownerId: 7, kind: 'alias', text: '已人工确认', source: '管理面板' }, legacyDb);
  saveEmbeddings(legacyDb, 'memory', [{ refId: legacyId, vec }]);
  legacyDb.exec('ALTER TABLE memory DROP COLUMN verified');
  setMeta(legacyDb, 'schema_version', '7');
  legacyDb.close();
  const migrated = createMemoryDb(migrationPath);
  try {
    assert.equal(getMeta(migrated, 'schema_version'), '8');
    assert.equal(memoryStore.getMemory(legacyId, migrated)?.verified, false);
    assert.equal(memoryStore.getMemory(manualId, migrated)?.verified, true);
    assert.equal((migrated.prepare("SELECT count(*) n FROM embedding WHERE ref_kind='memory'").get() as { n: number }).n, 0);
  } finally { migrated.close(); }
  console.log('✓ v7 迁移隔离未确认身份，保留已知人工来源，旧人物向量失效');
} finally {
  db.close();
  files.forEach((file) => fs.rmSync(file, { force: true }));
  fs.rmSync(dir, { recursive: true, force: true });
}
