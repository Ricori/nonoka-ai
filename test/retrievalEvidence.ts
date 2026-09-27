import assert from 'node:assert/strict';
import { createMemoryDb } from '@/modules/aiReply/memory/db';
import { recallChat, recallMemory } from '@/modules/aiReply/memory/retrieve';
import { hasRecallContent } from '@/modules/aiReply/memory/relevance';
import { segment, queryTerms } from '@/modules/aiReply/memory/segment';
import { backupDateKey } from '@/modules/aiReply/storage/message';
import { saveEmbeddings } from '@/modules/aiReply/memory/vector';
import memoryStore from '@/modules/aiReply/memory/store';

const db = createMemoryDb(':memory:');
const today = Number(backupDateKey());
let seq = 0;
function line(group: number, user: number, body: string): number {
  const id = Number(db.prepare('INSERT INTO chat_line(group_id,user_id,date_key,seq,text) VALUES(?,?,?,?,?)')
    .run(group, user, today, ++seq, `[测试]说：${body}`).lastInsertRowid);
  db.prepare('INSERT INTO chat_fts(rowid,seg) VALUES(?,?)').run(id, segment(body));
  return id;
}

try {
  assert.equal(hasRecallContent('[甲]说：我养猫'), true);
  assert.equal(hasRecallContent('[甲]说：已毕业'), true);
  for (const body of ['哈哈哈', '好家伙', '不知道', '[图片]', '不赖']) {
    assert.equal(hasRecallContent(`[甲]说：${body}`), false);
  }
  const graduated = line(1, 1, '已毕业');
  line(1, 2, '我还在大学读书');
  assert.equal((await recallChat(1, { query: '已毕业', speakerIds: [1], semantic: false }, db))[0].id, graduated);
  assert.ok(!queryTerms('最近上次哪里买的相机').some((t) => ['最近', '上次', '哪里'].includes(t)));
  console.log('✓ 三字事实保留，附和过滤，泛用时间词不占检索词');

  line(2, 1, '松风餐厅晚上六点开门');
  line(3, 1, '松风餐厅订座电话：021-77778888');
  const phoneHits = await recallChat(2, { query: '松风餐厅订座电话', semantic: false }, db);
  assert.ok(phoneHits.length > 0);
  assert.ok(phoneHits.every((h) => !h.text.includes('77778888')));
  console.log('✓ 跨群记录不可见');

  const memory = memoryStore.addMemory({ ownerId: 20, kind: 'trait', text: '喜欢徒步旅行' }, db);
  assert.ok((await recallMemory(1, { query: '个人档案', aboutUserIds: [20], semantic: false }, db)).some((h) => h.id === memory));
  const passport = memoryStore.addMemory({ ownerId: 21, kind: 'trait', text: '护照号码：E12345678' }, db);
  assert.equal((await recallMemory(1, { query: '护照号码是多少', aboutUserIds: [21], semantic: false }, db))[0].id, passport);
  console.log('✓ 指名概览兜底和字面档案命中');

  // 与查询没有共同词的语义命中不能被硬过滤
  const hike = line(4, 40, '周末去爬山');
  const window = Number(db.prepare('INSERT INTO chat_window(group_id,date_key,line_from,line_to,text) VALUES(?,?,?,?,?)')
    .run(4, today, hike, hike, '周末去爬山').lastInsertRowid);
  saveEmbeddings(db, 'window', [{ refId: window, vec: [1, 0, 0] }]);
  const semantic = await recallChat(4, { query: '登高运动', queryVec: Float32Array.from([1, 0, 0]) }, db);
  assert.equal(semantic[0].id, hike);
  assert.equal(semantic[0].via, 'semantic');
  assert.equal((await recallChat(4, { query: '登高运动', speakerIds: [41], queryVec: Float32Array.from([1, 0, 0]) }, db)).length, 0);
  const weakVec = Float32Array.from([0.47, Math.sqrt(1 - 0.47 ** 2), 0]);
  assert.equal((await recallChat(4, { query: '登高运动', queryVec: weakVec }, db))[0].id, hike);
  assert.equal((await recallChat(4, { query: '登高运动', queryVec: weakVec, minSimilarity: 0.5 }, db)).length, 0);
  assert.equal((await recallChat(4, { query: '登高运动', queryVec: Float32Array.from([0, 1, 0]) }, db)).length, 0);
  const weakWindows: { refId: number, vec: number[] }[] = [];
  for (let i = 0; i < 6; i += 1) {
    const id = line(5, 50, `独立活动记录${i}`);
    const refId = Number(db.prepare('INSERT INTO chat_window(group_id,date_key,line_from,line_to,text) VALUES(?,?,?,?,?)')
      .run(5, today, id, id, `独立活动记录${i}`).lastInsertRowid);
    weakWindows.push({ refId, vec: [1, 0, 0] });
  }
  saveEmbeddings(db, 'window', weakWindows);
  assert.equal((await recallChat(5, { query: '登高运动', queryVec: weakVec, limit: 20 }, db)).length, 5);
  const weakMemory = memoryStore.addMemory({ ownerId: 60, kind: 'trait', text: '周末去爬山' }, db);
  saveEmbeddings(db, 'memory', [{ refId: weakMemory, vec: [1, 0, 0] }]);
  const memoryVec = Float32Array.from([0.52, Math.sqrt(1 - 0.52 ** 2), 0]);
  assert.equal((await recallMemory(1, { query: '登高运动', queryVec: memoryVec, aboutUserIds: [60] }, db))[0].id, weakMemory);
  assert.equal((await recallMemory(1, { query: '登高运动', queryVec: memoryVec }, db)).length, 0);
  assert.equal((await recallMemory(1, { query: '登高运动', queryVec: memoryVec, aboutUserIds: [61] }, db)).length, 0);
  console.log('✓ 无字面重合的语义候选不会被硬过滤，说话人边界保持');
} finally {
  db.close();
}
