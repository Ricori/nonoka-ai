/**
 * 动态语义评分：判断消息对夜夜的吸引力
 */
export function getTopicRelevance(text: string): number {
  let score = 0;

  // 被提到
  if (text.includes('夜夜')) score += 0.6;

  // 核心人设词
  const coreInterests = /钱|穷|打工|偶像/;
  if (coreInterests.test(text)) score += 0.4;

  // 负面情绪词
  const emotionKeywords = /累|烦|死|倒霉|扣钱|加班|熬夜|骂|烂完了/;
  if (emotionKeywords.test(text)) score += 0.2;

  // 动态长度加成
  if (text.length > 30) score += 0.1;

  // 问句加成（疑问句更容易触发好奇心）
  if (text.includes('吗') || text.includes('？')) score += 0.05;

  return Math.min(score, 0.6); // 最高基础加成到 60%
}
