import assert from 'node:assert/strict';
import Axios from 'axios';
import { rerankEvidence } from '@/service/llm';
import { createMemoryDb } from '@/modules/aiReply/memory/db';
import { assessEvidence, parseEvidence, formatEvidence } from '@/modules/aiReply/memory/evidence';
import { recallChatEvidence, recallMemoryEvidence } from '@/modules/aiReply/memory/recallEvidence';
import { recallChat } from '@/modules/aiReply/memory/retrieve';
import { saveEmbeddings } from '@/modules/aiReply/memory/vector';
import { segment } from '@/modules/aiReply/memory/segment';
import memoryStore from '@/modules/aiReply/memory/store';
import { backupDateKey } from '@/modules/aiReply/storage/message';

const sources = [{ id: 1, text: '只知道她在开发字幕工具，没有公开仓库链接' }];
const originalPost = Axios.post;
Axios.post = (async (url: string, body: any, options: any) => {
  assert.equal(new URL(url).pathname, '/llm/rerank');
  assert.deepEqual(Object.keys(body).sort(), ['candidates', 'query']);
  assert.equal(options.timeout, 45000);
  return { data: { success: true, decisions: [] } };
}) as typeof Axios.post;
try {
  assert.equal(await rerankEvidence('仓库链接', sources), '{"decisions":[]}');
} finally { Axios.post = originalPost; }
let failedRequests = 0;
Axios.post = (async (url: string) => {
  assert.equal(new URL(url).pathname, '/llm/rerank');
  failedRequests += 1;
  throw Error('service unavailable');
}) as typeof Axios.post;
try {
  assert.equal(await rerankEvidence('仓库链接', sources), null);
  assert.equal(failedRequests, 1);
} finally { Axios.post = originalPost; }
const reply = (id: number, status: string, quote: string) => JSON.stringify({ decisions: [{ id, status, quote }] });
assert.equal(parseEvidence(reply(999, 'supported', sources[0].text), sources), null);
assert.equal(parseEvidence(reply(1, 'supported', 'https://fabricated.example'), sources), null);
assert.equal(parseEvidence(reply(1, 'supported', ''), sources), null);
assert.equal(parseEvidence('not json', sources), null);
const pair = [...sources, { id: 6, text: '最近在写播放器' }];
const mixed = JSON.stringify({ decisions: [
  { id: 1, status: 'supported', quote: '没有公开仓库链接' },
  { id: 6, status: 'background', quote: '改写过的播放器' },
] });
assert.deepEqual(parseEvidence(mixed, pair)?.map((d) => d.id), [1]);
assert.deepEqual(parseEvidence('{"decisions":[]}', pair), []);
assert.equal((await assessEvidence('仓库链接', sources, async () => null)).status, 'unavailable');
assert.equal((await assessEvidence('仓库链接', sources, async () => { throw Error('timeout'); })).status, 'unavailable');
const background = await assessEvidence('仓库链接', sources, async () => reply(1, 'background', sources[0].text));
assert.equal(background.status, 'background');
assert.ok(formatEvidence(background, () => '[甲]').includes('没有所问答案'));
assert.equal((await assessEvidence('仓库链接', sources, async () => '{"decisions":[]}')).status, 'none');
let called = false;
assert.equal((await assessEvidence('空库', [], async () => { called = true; return null; })).status, 'none');
assert.equal(called, false);
const tail = { id: 2, text: `${'前面的说明。'.repeat(25)}目前月薪为8000元。` };
const excerpt = '目前月薪为8000元。';
const tailResult = await assessEvidence('月薪多少', [tail], async () => reply(2, 'supported', excerpt));
assert.ok(formatEvidence(tailResult, () => '[乙]').includes(excerpt));
const longText = `${'背景说明。'.repeat(160)}耳机型号不是ABC700，而是DEF900。`;
const longResult = await assessEvidence('耳机型号是什么', [{ id: 4, text: longText }], async (_q, candidates) => {
  assert.ok(candidates[0].text.includes('耳机型号不是ABC700，而是DEF900。'));
  assert.ok(candidates[0].text.length <= 400);
  assert.ok(candidates[0].excerpt!.start > 0);
  assert.equal(longText.slice(candidates[0].excerpt!.start, candidates[0].excerpt!.start + candidates[0].text.length), candidates[0].text);
  return reply(4, 'supported', '耳机型号不是ABC700，而是DEF900。');
});
assert.equal(longResult.status, 'supported');
assert.equal(longResult.hits[0].text, longText);
const source = {
  kind: 'memory' as const, subject: '甲 (10)', date: '20260927', context: ['[乙]说：只在邻居里的事实'],
};
const scope = { asOf: '20260928', subject: '甲 (10)' };
const withSource = await assessEvidence('甲喜欢什么', [{ id: 5, text: '喜欢摄影' }], async (_q, candidates, sentScope) => {
  assert.deepEqual(candidates[0].source, source);
  assert.deepEqual(sentScope, scope);
  return reply(5, 'supported', '喜欢摄影');
}, 5, scope, () => source);
assert.equal((withSource.hits[0] as { source?: unknown }).source, undefined);
assert.equal((await assessEvidence(
  '背景',
  [{ id: 5, text: '喜欢摄影' }],
  async () => reply(5, 'supported', '只在邻居里的事实'),
  5,
  undefined,
  () => source,
)).status, 'unavailable');
assert.equal((await assessEvidence(
  '问题',
  [{ id: 3, text: `${'甲'.repeat(400)}截断后的事实` }],
  async () => reply(3, 'supported', '截断后的事实'),
)).status, 'unavailable');
console.log('✓ 无效ID/伪造引用/截断外引用被逐条丢弃，全部失效才算故障；无证据、背景明确区分；有效尾部引文保留');

const db = createMemoryDb(':memory:');
try {
  const date = Number(backupDateKey());
  const ids: number[] = [];
  for (let i = 0; i < 12; i += 1) {
    const text = i === 11 ? '[甲]说：那个人开挂了，人家FPS还知道演一下' : `[甲]说：射击游戏正在讨论${i}`;
    const id = Number(db.prepare('INSERT INTO chat_line(group_id,user_id,date_key,seq,text) VALUES(?,?,?,?,?)').run(1, 10, date, i, text).lastInsertRowid);
    db.prepare('INSERT INTO chat_fts(rowid,seg) VALUES(?,?)').run(id, segment(text));
    ids.push(id);
  }
  const win = Number(db.prepare('INSERT INTO chat_window(group_id,date_key,line_from,line_to,text) VALUES(?,?,?,?,?)').run(1, date, ids[0], ids[11], '游戏讨论').lastInsertRowid);
  saveEmbeddings(db, 'window', [{ refId: win, vec: [1, 0, 0] }]);
  const opts = { query: '射击游戏作弊者会伪装吗', queryVec: Float32Array.from([1, 0, 0]), speakerIds: [10] };
  assert.ok(!(await recallChat(1, opts, db)).some((h) => h.id === ids[11]));
  const found = await recallChatEvidence(1, opts, db, async (_q, candidates, sentScope) => {
    const gold = candidates.find((c) => c.id === ids[11]);
    assert.ok(gold);
    assert.equal(gold.source?.kind, 'chat');
    assert.equal(gold.source?.date, String(date));
    assert.ok(gold.source?.subject.includes('(10)'));
    assert.ok(gold.source?.context?.length);
    assert.equal(sentScope?.subject, '群友 (10)');
    assert.equal(sentScope?.asOf, backupDateKey());
    return reply(gold.id, 'supported', gold.text);
  });
  assert.equal(found.hits[0].id, ids[11]);
  assert.equal((await recallChatEvidence(2, opts, db, async () => { throw Error('must not call'); })).status, 'none');
  assert.equal((await recallChatEvidence(1, { ...opts, speakerIds: [20] }, db, async () => { throw Error('must not call'); })).status, 'none');
  const id = memoryStore.addMemory({ ownerId: 30, kind: 'trait', text: '持有ABC700和DEF900耳机' }, db);
  const model = await recallMemoryEvidence(
    1,
    { query: '耳机型号是什么', aboutUserIds: [30], semantic: false },
    db,
    async (_q, candidates, sentScope) => {
      const hit = candidates.find((c) => c.id === id)!;
      assert.equal(hit.source?.kind, 'memory');
      assert.ok(hit.source?.subject.includes('(30)'));
      assert.equal(hit.source?.subject, sentScope?.subject);
      return reply(id, 'supported', hit.text);
    },
  );
  assert.equal(model.hits[0].id, id);
  const removed = await recallMemoryEvidence(
    1,
    { query: '耳机型号是什么', aboutUserIds: [30], semantic: false },
    db,
    async (_q, candidates) => {
      db.prepare('DELETE FROM memory WHERE id=?').run(id);
      return reply(id, 'supported', candidates.find((c) => c.id === id)!.text);
    },
  );
  assert.equal(removed.status, 'unavailable');
  assert.equal(removed.hits.length, 0);
  const moved = await recallChatEvidence(1, opts, db, async (_q, candidates) => {
    const gold = candidates.find((c) => c.id === ids[11])!;
    db.prepare('UPDATE chat_line SET user_id=20 WHERE id=?').run(gold.id);
    return reply(gold.id, 'supported', gold.text);
  });
  assert.equal(moved.status, 'unavailable');
  assert.equal(moved.hits.length, 0);
  console.log('✓ 窗口末尾同义答案进入重排，群/人物硬边界保持，无字段标签的真实型号保留');

  db.prepare('UPDATE chat_line SET user_id=10 WHERE id=?').run(ids[11]);
  const degraded = await recallChatEvidence(1, { ...opts, limit: 3 }, db, async () => null);
  assert.equal(degraded.status, 'unverified');
  assert.ok(degraded.hits.length > 0 && degraded.hits.length <= 3);
  assert.ok(degraded.hits.every((h) => h.evidence === undefined));
  assert.ok(formatEvidence(degraded, (h) => `[${h.userId}]`).includes('未经核验'));
  const kept = memoryStore.addMemory({ ownerId: 31, kind: 'trait', text: '持有GHI300耳机' }, db);
  const degradedMemory = await recallMemoryEvidence(
    1,
    { query: '耳机型号是什么', aboutUserIds: [31], semantic: false },
    db,
    async () => { throw Error('timeout'); },
  );
  assert.equal(degradedMemory.status, 'unverified');
  assert.equal(degradedMemory.hits[0].id, kept);
  console.log('✓ 重排不可用时退回本地检索结果并标为未核验');
} finally { db.close(); }
