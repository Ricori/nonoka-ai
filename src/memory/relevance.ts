import { stripSpeakerPrefix, type WeightedTerm } from './segment';

/** 按权重算问题里有多少词在正文出现，奖励覆盖整个问题而不是只撞上一个常见短词 */
export function termCoverage(text: string, terms: WeightedTerm[]): number {
  const body = stripSpeakerPrefix(text).toLowerCase();
  const total = terms.reduce((sum, t) => sum + t.weight, 0);
  if (!total) return 0;
  return terms.reduce((sum, t) => sum + (body.includes(t.term.toLowerCase()) ? t.weight : 0), 0) / total;
}

/** 窗口内挑行用：整词覆盖为主，字重合只作弱兜底，不能单独当检索依据 */
export function windowLineScore(text: string, terms: WeightedTerm[]): number {
  const body = stripSpeakerPrefix(text).toLowerCase();
  const chars = new Set(terms.map((t) => t.term).join('').toLowerCase());
  const overlap = [...chars].filter((c) => body.includes(c)).length / Math.max(chars.size, 1);
  return termCoverage(text, terms) + 0.1 * overlap;
}

/** 表情、图片、「哈哈哈」「好家伙」这类附和没有注入价值；三个字的短事实要保留 */
export function hasRecallContent(text: string): boolean {
  const body = stripSpeakerPrefix(text).replace(/\[[^\]]*\]/g, '').replace(/[\s\p{P}\p{S}]/gu, '');
  return body.length >= 3 && !/^(?:哈+|呵+|嘿+|嘻+|嗯+|哦+|啊+|233+|666+|笑死我了|哈哈笑死|确实如此|好家伙|原来如此|不知道|不清楚)$/u.test(body);
}
