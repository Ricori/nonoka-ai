import { rerankEvidence, type RerankCandidate, type RerankScope } from '@/service/llm';
import { weightedTerms } from './segment';
import { windowLineScore } from './relevance';

export type EvidenceCandidate = RerankCandidate;
/** 能送去核验的记录：只要 id 和原文，来源信息另由 sourceOf 提供 */
export interface Evidenceable { id: number; text: string }
export interface EvidenceDecision {
  id: number;
  status: 'supported' | 'background';
  quote: string;
}
export type EvidenceJudge = (query: string, candidates: EvidenceCandidate[], scope?: RerankScope) => Promise<string | null>;
export interface EvidenceResult<T> {
  /** unverified：重排不可用，退回本地检索的前几条，未经核验 */
  status: 'supported' | 'background' | 'none' | 'unavailable' | 'unverified';
  hits: (T & { evidence?: EvidenceDecision })[];
  candidateCount: number;
}

/** 与服务端 /llm/rerank 的输入上限保持一致 */
export const EVIDENCE_CANDIDATE_LIMIT = 50;
export const EVIDENCE_TEXT_LIMIT = 400;
/** prompt 要求最多 5 条支持 + 2 条背景 */
const MAX_DECISIONS = 7;
/** 未核验结果只给开头这么多字，长公告整段塞回去会把上下文吃光 */
const MAX_UNVERIFIED_CHARS = 120;

/** 连续失败 3 次就歇 1 分钟，期间直接走未核验降级 */
let failures = 0;
let mutedUntil = 0;
export const judgeEvidence: EvidenceJudge = async (query, candidates, scope) => {
  if (Date.now() < mutedUntil) return null;
  const raw = await rerankEvidence(query, candidates, scope);
  if (raw && parseEvidence(raw, candidates)) failures = 0;
  else {
    failures += 1;
    if (failures >= 3) { mutedUntil = Date.now() + 60000; failures = 0; }
  }
  return raw;
};

/** 超长原文只送一段连续片段，优先从句子边界切，保留限定语 */
export function evidenceExcerpt(query: string, candidate: EvidenceCandidate): EvidenceCandidate {
  const { text } = candidate;
  if (text.length <= EVIDENCE_TEXT_LIMIT) return candidate;
  const terms = weightedTerms(query);
  const starts = new Set<number>([0, Math.max(0, text.length - EVIDENCE_TEXT_LIMIT)]);
  for (let i = 200; i < text.length; i += 200) {
    const boundary = Math.max(text.lastIndexOf('。', i), text.lastIndexOf('\n', i), text.lastIndexOf('；', i));
    starts.add(boundary >= i - 200 ? boundary + 1 : Math.max(0, i - 80));
  }
  const best = [...starts].map((start) => ({
    start, score: windowLineScore(text.slice(start, start + EVIDENCE_TEXT_LIMIT), terms),
  })).sort((a, b) => b.score - a.score || a.start - b.start)[0];
  return { ...candidate, text: text.slice(best.start, best.start + EVIDENCE_TEXT_LIMIT), excerpt: { start: best.start, totalLength: text.length } };
}

/** 逐条校验引文，不合格的只丢这一条；有判断但全部不合格才算失败，不能冒充"没有证据" */
export function parseEvidence(raw: string, candidates: EvidenceCandidate[]): EvidenceDecision[] | null {
  let parsed: any;
  try {
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch { return null; }
  if (!Array.isArray(parsed?.decisions)) return null;
  const sources = new Map(candidates.map((c) => [c.id, c.text]));
  const seen = new Set<number>();
  const valid = parsed.decisions.filter((d: any) => {
    const ok = d && sources.has(d.id) && !seen.has(d.id) && ['supported', 'background'].includes(d.status)
      && typeof d.quote === 'string' && d.quote.trim().length >= 2 && sources.get(d.id)!.includes(d.quote);
    if (ok) seen.add(d.id);
    return ok;
  }).slice(0, MAX_DECISIONS).map((d: any): EvidenceDecision => ({ id: d.id, status: d.status, quote: d.quote }));
  return parsed.decisions.length > 0 && valid.length === 0 ? null : valid;
}

export async function assessEvidence<T extends Evidenceable>(
  query: string,
  candidates: T[],
  judge: EvidenceJudge = judgeEvidence,
  limit = 5,
  scope?: RerankScope,
  sourceOf?: (hit: T) => EvidenceCandidate['source'],
): Promise<EvidenceResult<T>> {
  const input = candidates.slice(0, EVIDENCE_CANDIDATE_LIMIT).map((c) => {
    const source = sourceOf?.(c);
    return evidenceExcerpt(query, { id: c.id, text: c.text, ...(source ? { source } : {}) });
  });
  const empty = { hits: [], candidateCount: input.length };
  if (!input.length) return { ...empty, status: 'none' };
  let decisions: EvidenceDecision[] | null;
  try {
    const raw = await judge(query, input, scope);
    decisions = raw ? parseEvidence(raw, input) : null;
  } catch { decisions = null; }
  if (!decisions) return { ...empty, status: 'unavailable' };
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const ordered = [...decisions.filter((d) => d.status === 'supported'),
    ...decisions.filter((d) => d.status === 'background').slice(0, 2)];
  const hits = ordered.slice(0, limit).map((d) => ({ ...byId.get(d.id)!, evidence: d }));
  return {
    status: hits.some((h) => h.evidence.status === 'supported') ? 'supported' : hits.length ? 'background' : 'none',
    hits,
    candidateCount: input.length,
  };
}

/** 核验过的只给引文，引文可能在原文 120 字之后，不能截断 */
export function formatEvidence<T extends Evidenceable>(result: EvidenceResult<T>, label: (hit: T) => string): string {
  if (result.status === 'unavailable') return '证据检查暂时不可用。这次无法确认答案，请说明查询未完成，不得声称事实不存在或补造细节。';
  if (result.status === 'none') return '没有找到支持本次问题的证据。请说明没有查到，不能据此推断事实不存在。';
  if (result.status === 'unverified') {
    return `证据检查暂时不可用，以下是未经核验的检索结果，可能与问题无关。只能引用原文明确写出的内容，对不上就说没查到，不得补造细节。\n${
      result.hits.map((h) => `[记录${h.id}] ${label(h)}\n原文：${h.text.length > MAX_UNVERIFIED_CHARS ? `${h.text.slice(0, MAX_UNVERIFIED_CHARS)}…` : h.text}`).join('\n')}`;
  }
  const header = result.status === 'supported'
    ? '以下原文被判定为支持或背景。仅依据明确支持的原文作答，引用证据编号，保留说话人、否定、时间和条件。'
    : '仅找到相关背景，没有所问答案。请明确说明缺失信息，不得从背景推断数字、姓名、链接或其他细节。';
  return `${header}\n${result.hits.map((h) => `[证据${h.id}][${h.evidence?.status === 'supported' ? '支持' : '仅背景'}] ${label(h)}\n原文：${h.evidence?.quote ?? h.text}`).join('\n')}`;
}
