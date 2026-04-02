export function getAdditionalChance(text: string): number {
  let score = 0;

  // 被提到
  if (text.includes('乃乃') || text.includes('nono')) score += 0.7;

  // 核心人设词第一梯队
  const coreInterests = /写作|小说|文学部|投稿|稿子|可爱|数学|算数/;
  if (coreInterests.test(text)) score += 0.3;

  // 核心人设词第二梯队
  const emotionKeywords = /甜|社团|前辈|学长|帮忙|拜托|考试|成绩|哭|难过|孤独|一个人|家人|父母/;
  if (emotionKeywords.test(text)) score += 0.2;


  return Math.min(score, 0.7); // 最高加到 70%, 最低 -20%
}
