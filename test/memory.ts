import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createMemoryDb, getMeta, setMeta } from '@/modules/aiReply/memory/db';
import memoryStore from '@/modules/aiReply/memory/store';
import { recallChat } from '@/modules/aiReply/memory/retrieve';
import { recallChatEvidence, recallMemoryEvidence } from '@/modules/aiReply/memory/recallEvidence';
import { formatEvidence } from '@/modules/aiReply/memory/evidence';
import { saveEmbeddings, searchSimilar } from '@/modules/aiReply/memory/vector';
import { ingestChatBackups, parseBackupLine } from '@/modules/aiReply/memory/ingest';
import { segment } from '@/modules/aiReply/memory/segment';
import { backupDateKey, CHAT_BACKUP_DIR } from '@/modules/aiReply/storage/message';

/** 用绝不会撞上真实群的号造样本，跑完就删 */
const FAKE_GROUP = 88888888;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nonoka-memory-'));
const db = createMemoryDb(path.join(dir, 'test.db'));
const vec = Float32Array.from([1, 0, 0]);
const today = Number(backupDateKey());
const fixture = path.join(CHAT_BACKUP_DIR, `${FAKE_GROUP}_${today}.txt`);
assert.ok(!fs.existsSync(fixture), `样本文件已存在，先手动清理：${fixture}`);
let seq = 0;

function line(group: number, user: number, body: string): number {
  const id = Number(db.prepare('INSERT INTO chat_line(group_id,user_id,date_key,seq,text) VALUES(?,?,?,?,?)')
    .run(group, user, today, ++seq, `[测试]说：${body}`).lastInsertRowid);
  db.prepare('INSERT INTO chat_fts(rowid,seg) VALUES(?,?)').run(id, segment(body));
  return id;
}

try {
  // v1~v8 已压平进 v9 基线：停在老版本的库直接拒绝，不能带着 topic 表继续跑
  const legacyPath = path.join(dir, 'legacy.db');
  const legacyDb = createMemoryDb(legacyPath);
  assert.equal(getMeta(legacyDb, 'schema_version'), '9');
  setMeta(legacyDb, 'schema_version', '8');
  legacyDb.close();
  assert.throws(() => createMemoryDb(legacyPath), /低于基线 v9/);
  console.log('✓ 新库落到 v9 基线，老库拒绝打开');

  assert.deepEqual(parseBackupLine('[111][雨漫]说：我周末要去爬山\r'), {
    userId: 111, nick: '雨漫', text: '[雨漫]说：我周末要去爬山', body: '我周末要去爬山',
  });
  assert.equal(parseBackupLine('[0][主动 0.0312]爬山啊')?.text, '爬山啊');
  assert.equal(parseBackupLine('[0][被动][工具 2][点名 1]秋叶原确实好逛')?.text, '秋叶原确实好逛');
  fs.mkdirSync(CHAT_BACKUP_DIR, { recursive: true });
  // 第二条正文自带换行：续行要接回上一条
  fs.writeFileSync(fixture, '[111][雨漫]说：去秋叶原买手办\n[222][hina]说：这家店好吃\n报名链接在群公告\n');
  assert.equal(ingestChatBackups(db, [FAKE_GROUP]).lines, 2);
  assert.equal(ingestChatBackups(db, [FAKE_GROUP]).lines, 0);
  fs.appendFileSync(fixture, '[0][主动 0.12]秋叶原确实好逛\n');
  assert.equal(ingestChatBackups(db, [FAKE_GROUP]).lines, 1);
  const rows = db.prepare('SELECT user_id, text FROM chat_line WHERE group_id = ? ORDER BY id').all(FAKE_GROUP) as { user_id: number, text: string }[];
  assert.deepEqual(rows.map((r) => r.text), ['[雨漫]说：去秋叶原买手办', '[hina]说：这家店好吃 报名链接在群公告', '秋叶原确实好逛']);
  console.log('✓ 备份行解析剥掉触发标记，续行接回，导入幂等且只处理新增行');

  line(2, 1, '松风餐厅晚上六点开门');
  line(3, 1, '松风餐厅订座电话：021-77778888');
  const phoneHits = await recallChat(2, { query: '松风餐厅订座电话', semantic: false }, db);
  assert.ok(phoneHits.length > 0);
  assert.ok(phoneHits.every((h) => !h.text.includes('77778888')));
  console.log('✓ 跨群记录不可见');

  const id = memoryStore.applyOps(1, 1, [{ op: 'ADD', kind: 'trait', text: '住在广州' }], db).added[0];
  saveEmbeddings(db, 'memory', [{ refId: id, vec, sourceText: '住在广州' }]);
  assert.equal(searchSimilar(db, 'memory', vec, 5).length, 1);
  memoryStore.applyOps(1, 1, [{ op: 'UPDATE', id, text: '住在上海' }], db);
  assert.equal(searchSimilar(db, 'memory', vec, 5).length, 0);
  assert.equal(saveEmbeddings(db, 'memory', [{ refId: id, vec, sourceText: '住在广州' }]), 0);
  memoryStore.applyOps(1, 1, [{ op: 'DELETE', id }], db);
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
  console.log('✓ 身份条目不能自动新增、改型或伪装');

  const ids = Array.from({ length: 3 }, (_, i) => line(1, 10, `射击游戏正在讨论${i}`));
  const opts = { query: '射击游戏', speakerIds: [10], semantic: false };
  const mustNotCall = async () => { throw Error('must not call'); };
  assert.equal((await recallChatEvidence(1, { ...opts, speakerIds: [20] }, db, mustNotCall)).status, 'none');
  const degraded = await recallChatEvidence(1, { ...opts, limit: 2 }, db, async () => null);
  assert.equal(degraded.status, 'unverified');
  assert.ok(degraded.hits.length > 0 && degraded.hits.length <= 2);
  assert.ok(degraded.hits.every((h) => ids.includes(h.id)));
  assert.ok(formatEvidence(degraded, (h) => `[${h.userId}]`).includes('未经核验'));
  const kept = memoryStore.addMemory({ ownerId: 31, kind: 'trait', text: '持有GHI300耳机' }, db);
  const degradedMemory = await recallMemoryEvidence(1, { query: '耳机型号是什么', aboutUserIds: [31], semantic: false }, db, async () => { throw Error('timeout'); });
  assert.equal(degradedMemory.status, 'unverified');
  assert.equal(degradedMemory.hits[0].id, kept);
  console.log('✓ 说话人边界保持；重排不可用时退回本地检索结果并标为未核验');
} finally {
  db.close();
  fs.rmSync(fixture, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
}
