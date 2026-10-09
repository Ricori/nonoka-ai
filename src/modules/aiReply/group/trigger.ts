import type { FormattedMessage } from '@/types/message';
import groupProfileStorage from '../storage/groupProfile';

/** 被 @ 后提升插话概率的时间窗口 */
const RECENT_AT_WINDOW = 100 * 1000;
/** 主动插话概率的衰减周期 */
const DECAY_PERIOD = 25 * 1000;
/** 基础插话概率 */
const BASE_CHANCE = 0.015;
/** 近期被 @ 时的插话概率 */
const RECENT_AT_CHANCE = 0.12;

/** 预算窗口：窗口内 Σ实际概率 对齐 Σ基础概率，时机分只挪概率不加量 */
const BUDGET_WINDOW = 60 * 60 * 1000;
/** 单条时机分换成的放大倍数上限，免得一条消息独吞整窗预算 */
const MAX_BOOST = 4;
/** 时机分看的上下文条数，与传给模型的上下文长度一致 */
const SCORE_CONTEXT = 20;

/** 时机分权重：按聊天备份里主动插话后 6 条内有没有人接话拟合（控制了基础概率），效果用 test:initiative-gate 回放验证 */
const W_MENTION_SHARE = 8.0;
const W_PLACEHOLDER_ONLY = 0.27;
const W_REPLY_OTHER = -0.16;

const PLACEHOLDER_ONLY_RE = /^(?:\s*(?:\[表情\]|\[图片\]|\[视频\]|\[语音\]|\[CQ:image[^\]]*\]))+\s*$/;
const REPLY_OTHER_RE = /^\[[^\]]*\]回复了(?!我的消息)/;

/** 获取消息相关性附加概率 */
function getAdditionalChance(text: string): number {
  let score = 0;
  // 核心人设词第一梯队
  const coreInterests = /写作|小说|文学部|投稿|稿子|可爱|数学|算数/;
  if (coreInterests.test(text)) score += 0.3;
  // 核心人设词第二梯队
  const emotionKeywords = /甜|社团|前辈|学长|帮忙|拜托|考试|成绩|哭|难过|孤独|一个人|家人|父母/;
  if (emotionKeywords.test(text)) score += 0.2;
  return Math.min(score, 0.7);
}

/** 去掉 `[昵称]说：` / `[昵称]回复了X的消息(...)，说：` 前缀，取正文 */
function getBody(text: string): string {
  const mark = REPLY_OTHER_RE.test(text) || text.includes('回复了我的消息') ? '，说：' : '说：';
  const i = text.indexOf(mark);
  return i >= 0 ? text.slice(i + mark.length) : text;
}

/**
 * 插话时机分（logit 增量）。群友正在找 bot 说话时更容易接得上；
 * 只数群友 @/回复 bot，不数 bot 自己的发言——自己插话没人理时接话率反而低于平均
 */
export function scoreMoment(history: FormattedMessage[]): number {
  const recent = history.slice(-SCORE_CONTEXT);
  const last = recent.at(-1);
  if (!last) return 0;
  const mentionShare = recent.filter((m) => m.role === 'user' && m.isMentionMe).length / recent.length;
  return W_MENTION_SHARE * mentionShare
    + (PLACEHOLDER_ONLY_RE.test(getBody(last.message)) ? W_PLACEHOLDER_ONLY : 0)
    + (REPLY_OTHER_RE.test(last.message) ? W_REPLY_OTHER : 0);
}

interface WindowEntry {
  time: number;
  baseChance: number;
  boost: number;
}

export interface InitiativeChance {
  /** 关键词与 @ 衰减算出的基础概率，窗口内的总和即插话预算 */
  baseChance: number;
  /** 按时机分重新分配后的实际概率 */
  chance: number;
}

/** 群聊主动插话的触发策略：维护各群的@时间与插话时间，计算触发概率与衰减 */
export class GroupReplyTrigger {
  /** 记录每个群最后被 @ 的时间 */
  private lastAtTime = new Map<number, number>();

  /** 记录每个群最后主动插话的时间 */
  private lastInitiativeTime = new Map<number, number>();

  /** 各群预算窗口内的候选时刻 */
  private windows = new Map<number, WindowEntry[]>();

  /** 各群预算窗口内的实际插话时间 */
  private hits = new Map<number, number[]>();

  /** 记录群内bot被提到的时间（提到后短时间内插话概率提高） */
  noteMention(groupId: number, now = Date.now()) {
    this.lastAtTime.set(groupId, now);
  }

  /** 基础插话概率：只决定预算多少，不决定花在哪条消息上 */
  private getBaseChance(groupId: number, text: string, now: number): number {
    const lastAt = this.lastAtTime.get(groupId) || 0;
    const lastInitiative = this.lastInitiativeTime.get(groupId) || 0;

    // 被提到后一段时间内插话概率增大
    const isRecentlyAt = now - lastAt < RECENT_AT_WINDOW;
    let triggerChance = (isRecentlyAt ? RECENT_AT_CHANCE : BASE_CHANCE) + getAdditionalChance(text);

    // 如果上次是主动插话且一个衰减周期内没被提到，则开始按周期衰减，最低回落到基础概率
    if (lastInitiative > lastAt && now - lastAt >= DECAY_PERIOD) {
      const decayPeriods = Math.floor((now - lastAt) / DECAY_PERIOD);
      triggerChance = Math.max(BASE_CHANCE, triggerChance * (0.5 ** decayPeriods));
    }

    // 分群缩放：各群活跃度与对 bot 的接受度差别很大，用群档案里的系数整体调节
    const { chanceScale } = groupProfileStorage.getProfile(groupId);
    return Math.min(1, triggerChance * chanceScale);
  }

  private prune<T>(list: T[], getTime: (item: T) => number, now: number) {
    const expireBefore = now - BUDGET_WINDOW;
    let i = 0;
    while (i < list.length && getTime(list[i]) < expireBefore) i += 1;
    if (i > 0) list.splice(0, i);
  }

  /** 计算本条消息的插话概率并记入预算窗口（不掷骰） */
  evaluate(groupId: number, history: FormattedMessage[], now = Date.now()): InitiativeChance {
    const baseChance = this.getBaseChance(groupId, history.at(-1)?.message ?? '', now);
    const window = this.windows.get(groupId) ?? [];
    const hits = this.hits.get(groupId) ?? [];
    this.windows.set(groupId, window);
    this.hits.set(groupId, hits);
    this.prune(window, (e) => e.time, now);
    this.prune(hits, (t) => t, now);

    const boost = Math.min(MAX_BOOST, Math.exp(scoreMoment(history)));
    window.push({ time: now, baseChance, boost });

    // 归一化：窗口内按基础概率加权的平均放大倍数为 1，期望插话数等于预算
    const expected = window.reduce((sum, e) => sum + e.baseChance, 0);
    if (expected <= 0) return { baseChance, chance: 0 };
    const norm = window.reduce((sum, e) => sum + e.baseChance * e.boost, 0) / expected;
    // 反馈只收紧不放宽：实际插话已超过预算就压低
    const feedback = Math.min(1, Math.max(0, 1 + (expected - hits.length) / Math.max(1, expected)));
    return { baseChance, chance: Math.min(1, (baseChance * boost * feedback) / norm) };
  }

  /** 主动插话判定：按概率决定是否插话。
   *  命中则记录本次插话时间并返回实际使用的概率（供统计留档），未命中返回 null */
  rollInitiative(
    groupId: number,
    history: FormattedMessage[],
    now = Date.now(),
    random = Math.random,
  ): InitiativeChance | null {
    const result = this.evaluate(groupId, history, now);
    if (random() >= result.chance) return null;
    this.recordHit(groupId, now);
    return result;
  }

  /** 记录一次主动插话：开始衰减，并计入预算窗口的实际插话数 */
  recordHit(groupId: number, now = Date.now()) {
    this.lastInitiativeTime.set(groupId, now);
    this.hits.get(groupId)?.push(now);
  }
}
