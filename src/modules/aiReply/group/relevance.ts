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
  if (text.includes('乃乃')) score += 0.7;

  // 核心人设词第一梯队
  const coreInterests = /写作|小说|文学部|投稿|稿子|可爱|数学|算数/;
  if (coreInterests.test(text)) score += 0.3;

  // 核心人设词第二梯队
  const emotionKeywords = /甜|社团|前辈|学长|帮忙|拜托|考试|成绩|哭|难过|孤独|一个人|家人|父母/;
  if (emotionKeywords.test(text)) score += 0.2;

  // 补正 [-0.2, 0.2]
  score += getFrequencyCorrection(groupId);

  return Math.min(score, 0.7); // 最高加到 70%, 最低 -20%
}
