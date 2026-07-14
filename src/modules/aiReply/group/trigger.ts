/** 被 @ 后提升插话概率的时间窗口 */
const RECENT_AT_WINDOW = 100 * 1000;
/** 主动插话概率的衰减周期 */
const DECAY_PERIOD = 25 * 1000;
/** 基础插话概率 */
const BASE_CHANCE = 0.015;
/** 近期被 @ 时的插话概率 */
const RECENT_AT_CHANCE = 0.12;

/** 获取消息相关性附加概率 */
export function getAdditionalChance(text: string): number {
  let score = 0;
  // 核心人设词第一梯队
  const coreInterests = /写作|小说|文学部|投稿|稿子|可爱|数学|算数/;
  if (coreInterests.test(text)) score += 0.3;
  // 核心人设词第二梯队
  const emotionKeywords = /甜|社团|前辈|学长|帮忙|拜托|考试|成绩|哭|难过|孤独|一个人|家人|父母/;
  if (emotionKeywords.test(text)) score += 0.2;
  return Math.min(score, 0.7);
}


/** 群聊主动插话的触发策略：维护各群的@时间与插话时间，计算触发概率与衰减 */
export class GroupReplyTrigger {
  /** 记录每个群最后被 @ 的时间 */
  private lastAtTime = new Map<number, number>();

  /** 记录每个群最后主动插话的时间 */
  private lastInitiativeTime = new Map<number, number>();

  /** 记录群内bot被提到的时间（提到后短时间内插话概率提高） */
  noteMention(groupId: number) {
    this.lastAtTime.set(groupId, Date.now());
  }

  /** 主动插话判定：按概率决定是否插话，命中则记录本次插话时间并返回 true */
  shouldInitiative(groupId: number, message: string): boolean {
    const now = Date.now();
    const lastAt = this.lastAtTime.get(groupId) || 0;
    const lastInitiative = this.lastInitiativeTime.get(groupId) || 0;

    // 被提到后一段时间内插话概率增大
    const isRecentlyAt = now - lastAt < RECENT_AT_WINDOW;
    // 消息相关性的附加概率
    const additional = getAdditionalChance(message);
    // 触发概率
    let triggerChance = (isRecentlyAt ? RECENT_AT_CHANCE : BASE_CHANCE) + additional;

    // 如果上次是主动插话且一个衰减周期内没被提到，则开始按周期衰减，最低回落到基础概率
    if (lastInitiative > lastAt && now - lastAt >= DECAY_PERIOD) {
      const decayPeriods = Math.floor((now - lastAt) / DECAY_PERIOD);
      triggerChance = Math.max(BASE_CHANCE, triggerChance * (0.5 ** decayPeriods));
    }

    if (Math.random() < triggerChance) {
      this.lastInitiativeTime.set(groupId, now);
      return true;
    }
    return false;
  }
}
