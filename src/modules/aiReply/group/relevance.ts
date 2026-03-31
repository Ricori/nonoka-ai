const recentMessages = new Map<number, number[]>(); // 记录每个群近期消息的时间戳

/** 获取消息频率概率补正 */
export function getFrequencyCorrection(groupId: number): number {
  const now = Date.now();
  const windowMs = 40 * 1000; // 40秒窗口
  const timestamps = recentMessages.get(groupId) || [];
  // 清理窗口外的旧时间戳
  const recent = timestamps.filter((t) => now - t < windowMs);
  recent.push(now);
  recentMessages.set(groupId, recent);
  const count = recent.length;

  if (count === 0) return 0.2; // 死寂
  if (count < 5) return 0.1; // 冷清
  if (count < 10) return 0; // 正常
  if (count < 15) return -0.1; // 热闹
  return -0.2;
}

export function getAdditionalChance(groupId: number, text: string): number {
  let score = 0;

  // 被提到
  if (text.includes('夜夜')) score += 0.7;

  // 核心人设词
  const coreInterests = /钱|穷|打工|偶像/;
  if (coreInterests.test(text)) score += 0.3;

  // 负面情绪词
  const emotionKeywords = /累|烦|死|倒霉|扣钱|加班|骂|烂/;
  if (emotionKeywords.test(text)) score += 0.2;

  // 补正 [-0.2, 0.2]
  score += getFrequencyCorrection(groupId);

  return Math.min(score, 0.7); // 最高加到 70%, 最低 -20%
}
