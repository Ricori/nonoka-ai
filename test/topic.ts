import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TOPIC_REJECTED, type TopicLine, type TopicSegment } from '@/service/llm';
import { createMemoryDb, getMeta, setMeta, type MemoryDatabase } from '@/modules/aiReply/memory/db';
import {
  dayProgressKey, legacyTopicLines, prepareTopicLines, segmentTopicDay, topicBudgetRemaining,
  topicDayBacklog, topicSettings, topicSince, topicWatermarkKey,
} from '@/modules/aiReply/memory/topic';
import { getConsolidationBacklog } from '@/modules/aiReply/memory/consolidate';
import { backupDateKey } from '@/modules/aiReply/storage/message';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nonoka-topic-'));
const date = Number(backupDateKey(new Date(Date.now() - 86400000)));
const options = { maxCalls: 40, concurrency: 3, dailyLimit: 40 };
let checks = 0;

function seed(db: MemoryDatabase, count: number, group = 1, day = date) {
  const insert = db.prepare('INSERT INTO chat_line (group_id,user_id,date_key,seq,nick,text) VALUES (?,?,?,?,?,?)');
  db.transaction(() => {
    for (let i = 0; i < count; i++) insert.run(group, 1, day, i, '用户', `[用户]说：第${i}个话题今天准备去爬山`);
  })();
}

function summarize(lines: TopicLine[]): TopicSegment[] {
  return [{ summary: `话题${lines[0].id}`, userIds: [1], lineFrom: lines[0].id, lineTo: lines[lines.length - 1].id }];
}

async function test(name: string, fn: (db: MemoryDatabase, file: string) => Promise<void>) {
  const file = path.join(directory, `${checks}.db`);
  const db = createMemoryDb(file);
  try {
    await fn(db, file);
    checks += 1;
    console.log(`✓ ${name}`);
  } finally {
    if (db.open) db.close();
  }
}

try {
  const bodies = ['[图片]！！！', '哈哈哈哈哈', '我养猫', '我不养猫', '我养猫', '我养猫', '不能去？', '不能去'];
  const prepared = prepareTopicLines(bodies.map((body, i) => ({ id: i, body, userId: i === 5 ? 2 : 1, nick: '人' })));
  assert.deepEqual(prepared.map((l) => l.id), [2, 3, 5, 6, 7]);
  assert.equal(legacyTopicLines([{ id: 1, userId: 1, nick: null, body: '[图片]' }]).length, 0);
  assert.equal(topicSettings({ topicDailyLimit: 0 }).dailyLimit, 0);
  assert.equal(topicSettings({ topicDailyLimit: -1 }).dailyLimit, 40);
  assert.equal(topicSince(0), topicSince(45));
  console.log('✓ 本地过滤保留短事实、否定、问句和不同人的相同回答');

  await test('并发部分失败保存成功段，重新开库只补失败段', async (db, file) => {
    seed(db, 250);
    const first = await segmentTopicDay(db, 1, date, options, async (lines) => (
      lines[0].id === 101 ? null : summarize(lines)
    ));
    assert.deepEqual([first.calls, first.failed, first.created.length, first.complete], [3, 1, 2, false]);
    assert.equal(getMeta(db, topicWatermarkKey(1)), null);
    assert.deepEqual(topicDayBacklog(db, 1, date), { chunks: 1, lines: 100 });
    db.close();
    const reopened = createMemoryDb(file);
    try {
      const next = await segmentTopicDay(reopened, 1, date, options, async (lines) => {
        assert.equal(lines[0].id, 101);
        return summarize(lines);
      });
      assert.deepEqual([next.calls, next.created.length, next.complete], [1, 1, true]);
      assert.equal((reopened.prepare('SELECT count(*) n FROM topic').get() as { n: number }).n, 3);
      assert.equal(getMeta(reopened, topicWatermarkKey(1)), String(date));
      assert.equal((await segmentTopicDay(reopened, 1, date, options, async () => { throw new Error('重复调用'); })).calls, 0);
      assert.equal(topicBudgetRemaining(reopened, 40), 36);
    } finally { reopened.close(); }
  });

  await test('日预算限制并发请求，失败和重启也不能绕过，UTC 次日重置', async (db, file) => {
    seed(db, 350);
    const limited = { ...options, dailyLimit: 2 };
    const first = await segmentTopicDay(db, 1, date, limited, async () => null);
    assert.equal(first.calls, 2);
    assert.equal(first.failed, 2);
    db.close();
    const reopened = createMemoryDb(file);
    try {
      const stopped = await segmentTopicDay(reopened, 1, date, limited, async () => { throw new Error('超预算'); });
      assert.equal(stopped.calls, 0);
      assert.equal(topicBudgetRemaining(reopened, 2), 0);
      assert.equal(topicBudgetRemaining(reopened, 2, Date.now() + 86400000), 2);
      assert.equal(topicBudgetRemaining(reopened, 5), 3);
    } finally { reopened.close(); }
  });

  await test('兼容 v2 已付费断点，不删旧话题或重切前 100 行', async (db) => {
    seed(db, 205);
    setMeta(db, dayProgressKey(1, date), '1');
    db.prepare('INSERT INTO topic (group_id,date_key,summary,user_ids,line_from,line_to) VALUES (?,?,?,?,?,?)')
      .run(1, date, '旧话题', '[1]', 1, 100);
    const result = await segmentTopicDay(db, 1, date, options, async (lines) => {
      assert.ok(lines.every((line) => line.id > 100));
      return summarize(lines);
    });
    assert.equal(result.calls, 2);
    assert.equal(result.complete, true);
    assert.equal((db.prepare('SELECT count(*) n FROM topic').get() as { n: number }).n, 3);
    assert.equal(getMeta(db, dayProgressKey(1, date)), null);
  });

  await test('纯噪声无需请求；审核拒收不会反复调用；单轮上限有效', async (db) => {
    seed(db, 10);
    db.prepare('UPDATE chat_line SET text = ?').run('[用户]说：哈哈哈哈');
    const noise = await segmentTopicDay(db, 1, date, options, async () => { throw new Error('噪声不应调用'); });
    assert.deepEqual([noise.calls, noise.complete, noise.filtered], [0, true, 10]);
    seed(db, 220, 2);
    const one = await segmentTopicDay(db, 2, date, { ...options, maxCalls: 1 }, async () => TOPIC_REJECTED);
    assert.deepEqual([one.calls, one.skipped, one.complete], [1, 1, false]);
    const rest = await segmentTopicDay(db, 2, date, options, async (lines) => summarize(lines));
    assert.deepEqual([rest.calls, rest.complete], [2, true]);
    seed(db, 1, 3);
    assert.equal((await segmentTopicDay(db, 3, date, { ...options, dailyLimit: 0 }, async () => [])).calls, 0);
  });

  await test('两个任务重叠不重复请求同段', async (db) => {
    seed(db, 20);
    let calls = 0;
    let finish: (result: TopicSegment[]) => void = () => {};
    const pending = segmentTopicDay(db, 1, date, options, async (lines) => {
      calls += 1;
      return new Promise<TopicSegment[]>((resolve) => { finish = () => resolve(summarize(lines)); });
    });
    const overlapping = await segmentTopicDay(db, 1, date, options, async () => { throw new Error('重复请求'); });
    assert.equal(overlapping.calls, 0);
    assert.equal(overlapping.complete, false);
    finish([]);
    assert.equal((await pending).complete, true);
    assert.equal(calls, 1);
  });

  await test('近期窗口与预览共用计划，预览不写进度', async (db) => {
    seed(db, 20);
    seed(db, 20, 1, Number(backupDateKey(new Date(Date.now() - 60 * 86400000))));
    const before = db.prepare('SELECT * FROM meta ORDER BY key').all();
    const recent = getConsolidationBacklog([1], db, { topicLookbackDays: 30 });
    const all = getConsolidationBacklog([1], db, { topicLookbackDays: 0 });
    assert.equal(recent.days, 1);
    assert.equal(all.days, 1);
    assert.deepEqual(db.prepare('SELECT * FROM meta ORDER BY key').all(), before);
  });
  console.log(`全部 ${checks} 组 topic 流程测试通过（无模型调用）`);
} finally {
  // 仅清理本次 mkdtemp 创建的测试目录。
  fs.rmSync(directory, { recursive: true, force: true });
}
