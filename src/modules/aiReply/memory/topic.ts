import { botConfig } from '@/core/nnkConfig';
import { TOPIC_REJECTED, type TopicLine, type TopicSegment } from '@/service/llm';
import { printError } from '@/utils/print';
import { backupDateKey } from '../storage/message';
import {
  delMeta, getMeta, setMeta, type MemoryDatabase,
} from './db';
import { stripSpeakerPrefix } from './segment';
import { HISTORY_DAYS, historySince } from './policy';

const TOPIC_CHUNK = 100;
const DAY_MS = 86400000;
const LEASE_MS = 10 * 60 * 1000;
const BUDGET_KEY = 'topic:daily-budget';

export const topicWatermarkKey = (groupId: number) => `topic:${groupId}`;
/** v2 按旧过滤规则计数，迁移时必须用相同规则定位，不能重切已付费的前缀。 */
export const dayProgressKey = (groupId: number, dateKey: number) => `topic:v2:${groupId}:${dateKey}`;
const planKey = (groupId: number, dateKey: number) => `topic:v3:${groupId}:${dateKey}`;

export interface TopicOptions {
  /** 0 禁用切话题；失败请求也计入预算，跨重启、手动和定时任务共享。 */
  topicDailyLimit?: number;
  /** 0 处理全部热历史，否则只处理最近 N 天；最多 45 天。 */
  topicLookbackDays?: number;
}

function integer(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function topicSettings(opts: TopicOptions = {}) {
  const config = botConfig.aiReply.memory;
  return {
    dailyLimit: integer(opts.topicDailyLimit ?? config?.topicDailyLimit, 40),
    lookbackDays: integer(opts.topicLookbackDays ?? config?.topicLookbackDays, HISTORY_DAYS),
  };
}

export function topicSince(days: number, now = Date.now()): number {
  return days === 0 ? historySince(now) : Math.max(historySince(now), Number(backupDateKey(new Date(now - days * DAY_MS))));
}

/** 保持 v2 原样，已有断点对应的是这套行序列。 */
export function legacyTopicLines(lines: TopicLine[]): TopicLine[] {
  return lines.filter((line) => line.body.replace(/\[[^\]]{1,10}\]/g, '').replace(/\s+/g, '').length > 2);
}

/** 只过滤确定的无内容表达，短事实（如“我养猫”）、否定和不同人的相同回答仍保留。 */
export function prepareTopicLines(lines: TopicLine[]): TopicLine[] {
  const seen = new Map<string, number>();
  return lines.filter((line, index) => {
    const body = line.body.replace(/\[(?:表情|图片|视频|语音|聊天记录|卡片消息|之前的图片)\]/g, '')
      .replace(/[\s\p{P}\p{S}]/gu, '');
    if (body.length <= 2 || /^(?:哈+|呵+|嘿+|嘻+|嗯+|哦+|啊+|233+|666+|笑死我了|哈哈笑死|确实|确实如此|好家伙|原来如此)$/u.test(body)) return false;
    // 不删中间标点，避免把“不能”与“不能？”当成同一句。
    const key = `${line.userId}:${line.body.trim().replace(/\s+/g, ' ')}`;
    const previous = seen.get(key);
    seen.set(key, index);
    return previous === undefined || index - previous > 20;
  });
}

interface TopicChunk {
  ids: number[];
  done?: boolean;
  leaseUntil?: number;
}

interface TopicPlan {
  chunks: TopicChunk[];
  filtered: number;
}

export function readTopicLines(db: MemoryDatabase, groupId: number, dateKey: number): TopicLine[] {
  const rows = db.prepare(
    'SELECT id, user_id AS userId, nick, text FROM chat_line WHERE group_id = ? AND date_key = ? ORDER BY id',
  ).all(groupId, dateKey) as { id: number, userId: number, nick: string | null, text: string }[];
  return rows.map((r) => ({
    id: r.id, userId: r.userId, nick: r.nick, body: r.userId === 0 ? r.text : stripSpeakerPrefix(r.text),
  }));
}

/** 计划只存原文 id；一旦开始就固定分段，过滤规则变化或重启不会让已完成的段重新付费。 */
function loadPlan(db: MemoryDatabase, groupId: number, dateKey: number): TopicPlan {
  const saved = getMeta(db, planKey(groupId, dateKey));
  if (saved) return JSON.parse(saved) as TopicPlan;
  const all = readTopicLines(db, groupId, dateKey);
  const legacyDone = Number(getMeta(db, dayProgressKey(groupId, dateKey)) ?? 0);
  const legacy = legacyTopicLines(all);
  const lastDoneId = legacy[Math.min(legacy.length, legacyDone * TOPIC_CHUNK) - 1]?.id ?? 0;
  const remaining = all.filter((line) => line.id > lastDoneId);
  const prepared = prepareTopicLines(remaining);
  const chunks: TopicChunk[] = [];
  for (let i = 0; i < prepared.length; i += TOPIC_CHUNK) {
    const slice = prepared.slice(i, i + TOPIC_CHUNK);
    // bot 独白不值得单独抽取；正常对话里的 bot 上下文仍随人类发言发送。
    if (slice.some((line) => line.userId !== 0)) chunks.push({ ids: slice.map((line) => line.id) });
  }
  return { chunks, filtered: remaining.length - chunks.reduce((n, c) => n + c.ids.length, 0) };
}

export function topicDayBacklog(db: MemoryDatabase, groupId: number, dateKey: number) {
  const plan = loadPlan(db, groupId, dateKey);
  const pending = plan.chunks.filter((chunk) => !chunk.done);
  return { chunks: pending.length, lines: pending.reduce((n, c) => n + c.ids.length, 0) };
}

export function topicBudgetRemaining(db: MemoryDatabase, limit: number, now = Date.now()): number {
  const budget = JSON.parse(getMeta(db, BUDGET_KEY) ?? '{}') as { day?: string, used?: number };
  return Math.max(0, limit - (budget.day === backupDateKey(new Date(now)) ? budget.used ?? 0 : 0));
}

type Segmenter = (lines: TopicLine[]) => Promise<TopicSegment[] | typeof TOPIC_REJECTED | null>;

/** 成功段各自提交；失败留待下一轮，避免超时后立刻重复请求。 */
export async function segmentTopicDay(
  db: MemoryDatabase,
  groupId: number,
  dateKey: number,
  opts: { maxCalls: number, concurrency: number, dailyLimit: number },
  segment: Segmenter,
) {
  if (!Number.isSafeInteger(opts.maxCalls) || opts.maxCalls < 0
    || !Number.isSafeInteger(opts.concurrency) || opts.concurrency <= 0
    || !Number.isSafeInteger(opts.dailyLimit) || opts.dailyLimit < 0) throw new Error('无效的话题调用预算或并发');
  const result = {
    created: [] as { id: number, text: string }[],
    calls: 0,
    skipped: 0,
    failed: 0,
    filtered: 0,
    complete: false,
  };
  const key = planKey(groupId, dateKey);
  const state = db.transaction(() => {
    if (Number(getMeta(db, topicWatermarkKey(groupId)) ?? 0) >= dateKey) return null;
    const plan = loadPlan(db, groupId, dateKey);
    setMeta(db, key, JSON.stringify(plan));
    return plan;
  }).immediate();
  if (!state) return { ...result, complete: true };
  result.filtered = state.filtered;
  const byId = new Map(readTopicLines(db, groupId, dateKey).map((line) => [line.id, line]));
  const insert = db.prepare(
    'INSERT INTO topic (group_id, date_key, summary, user_ids, line_from, line_to) VALUES (?, ?, ?, ?, ?, ?)',
  );

  const claim = (index: number): { lines: TopicLine[], leaseUntil: number } | null => db.transaction(() => {
    const raw = getMeta(db, key);
    if (!raw) return null;
    const plan = JSON.parse(raw) as TopicPlan;
    const chunk = plan.chunks[index];
    const now = Date.now();
    if (chunk.done || (chunk.leaseUntil ?? 0) > now || topicBudgetRemaining(db, opts.dailyLimit, now) <= 0) return null;
    const lines = chunk.ids.map((id) => byId.get(id));
    if (lines.some((line) => !line)) throw new Error('话题计划引用的原文缺失，拒绝生成不完整摘要');
    const remaining = topicBudgetRemaining(db, opts.dailyLimit, now);
    setMeta(db, BUDGET_KEY, JSON.stringify({ day: backupDateKey(new Date(now)), used: opts.dailyLimit - remaining + 1 }));
    chunk.leaseUntil = now + LEASE_MS;
    setMeta(db, key, JSON.stringify(plan));
    return { lines: lines as TopicLine[], leaseUntil: chunk.leaseUntil };
  }).immediate();

  const run = async (index: number) => {
    const claimed = claim(index);
    if (!claimed) return;
    result.calls += 1;
    let topics: Awaited<ReturnType<Segmenter>>;
    try {
      topics = await segment(claimed.lines);
    } catch (error) {
      printError(`[Consolidate] 切话题失败: ${error}`);
      topics = null;
    }
    db.transaction(() => {
      const raw = getMeta(db, key);
      if (!raw) return;
      const plan = JSON.parse(raw) as TopicPlan;
      // 超时任务的迟到结果不能覆盖接手任务已经保存的结果。
      if (plan.chunks[index].done || plan.chunks[index].leaseUntil !== claimed.leaseUntil) return;
      delete plan.chunks[index].leaseUntil;
      if (topics === null) {
        result.failed += 1;
      } else {
        if (topics === TOPIC_REJECTED) result.skipped += 1;
        else {
          topics.forEach((topic) => {
            const info = insert.run(groupId, dateKey, topic.summary, JSON.stringify(topic.userIds), topic.lineFrom, topic.lineTo);
            result.created.push({ id: Number(info.lastInsertRowid), text: topic.summary });
          });
        }
        plan.chunks[index].done = true;
      }
      setMeta(db, key, JSON.stringify(plan));
    }).immediate();
  };

  const pending = state.chunks.flatMap((c, i) => (!c.done && (c.leaseUntil ?? 0) <= Date.now() ? [i] : []));
  for (let i = 0; i < pending.length && result.calls < opts.maxCalls; i += opts.concurrency) {
    const wave = pending.slice(i, i + Math.min(opts.concurrency, opts.maxCalls - result.calls));
    const settled = await Promise.allSettled(wave.map(run));
    const rejected = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
    if (rejected) throw rejected.reason;
    if (result.failed > 0 || topicBudgetRemaining(db, opts.dailyLimit) === 0) break;
  }

  db.transaction(() => {
    const raw = getMeta(db, key);
    if (!raw) {
      result.complete = Number(getMeta(db, topicWatermarkKey(groupId))) >= dateKey;
      return;
    }
    const plan = JSON.parse(raw) as TopicPlan;
    if (plan.chunks.some((chunk) => !chunk.done)) return;
    // 水位与计划清理原子提交，崩溃不能造成成功一天再次切分。
    const watermark = Number(getMeta(db, topicWatermarkKey(groupId)) ?? 0);
    setMeta(db, topicWatermarkKey(groupId), String(Math.max(watermark, dateKey)));
    delMeta(db, key);
    delMeta(db, dayProgressKey(groupId, dateKey));
    delMeta(db, `topic:${groupId}:${dateKey}`);
    result.complete = true;
  }).immediate();
  return result;
}
