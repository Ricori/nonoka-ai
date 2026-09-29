import type { RerankScope } from '@/service/llm';
import { getMemoryDb, type MemoryDatabase } from './db';
import {
  recallChat, recallMemory, resolveQueryVec, type RecallChatOptions, type RecallMemoryOptions,
} from './retrieve';
import {
  assessEvidence, EVIDENCE_CANDIDATE_LIMIT,
  type EvidenceCandidate, type Evidenceable, type EvidenceJudge, type EvidenceResult,
} from './evidence';
import { historySince, usableMemorySql } from './policy';
import memoryStore from './store';
import { backupDateKey } from '../storage/message';

/** 送给重排的主体/范围描述，服务端上限 160 字 */
const META_CHARS = 160;

/**
 * 候选交给重排核验：重排失败退回本地检索的前几条（标为未核验）；
 * 等模型期间记录可能被删改，只返回仍然有效的
 */
async function verify<T extends Evidenceable>(
  query: string,
  candidates: T[],
  judge: EvidenceJudge | undefined,
  limit: number,
  scope: RerankScope,
  sourceOf: (hit: T) => EvidenceCandidate['source'],
  fallback: () => Promise<T[]>,
  stillValid: (hit: T) => boolean,
): Promise<EvidenceResult<T>> {
  const result = await assessEvidence(query, candidates, judge, limit, scope, sourceOf);
  if (result.status === 'unavailable') {
    const hits = await fallback();
    return { ...result, status: hits.length ? 'unverified' : 'unavailable', hits };
  }
  result.hits = result.hits.filter(stillValid);
  if (result.status !== 'none') {
    result.status = result.hits.some((h) => h.evidence?.status === 'supported') ? 'supported'
      : result.hits.length ? 'background' : 'unavailable';
  }
  return result;
}

export async function recallChatEvidence(
  groupId: number,
  opts: RecallChatOptions,
  db: MemoryDatabase = getMemoryDb(),
  judge?: EvidenceJudge,
) {
  const limit = opts.limit ?? 5;
  // 查询向量只算一次，降级重跑本地检索时复用
  const queryVec = await resolveQueryVec(db, opts) ?? undefined;
  const base = { ...opts, queryVec, semantic: queryVec ? opts.semantic : false };
  const candidates = await recallChat(groupId, { ...base, candidateMode: true, limit: EVIDENCE_CANDIDATE_LIMIT }, db);
  const current = db.prepare('SELECT text, user_id FROM chat_line WHERE id = ? AND group_id = ? AND date_key >= ?');
  return verify(
    opts.query,
    candidates,
    judge,
    limit,
    { asOf: backupDateKey(), subject: opts.speakerIds?.map((id) => `群友 (${id})`).join(',').slice(0, META_CHARS) || undefined },
    (hit) => ({
      kind: 'chat',
      subject: `${hit.nick ?? '群友'} (${hit.userId})`.slice(0, META_CHARS),
      date: String(hit.dateKey),
      context: hit.context?.slice(0, 2).map((s) => s.slice(0, META_CHARS)),
    }),
    () => recallChat(groupId, { ...base, limit }, db),
    (hit) => {
      const row = current.get(hit.id, groupId, historySince()) as { text: string, user_id: number } | undefined;
      return row?.text === hit.text && row.user_id === hit.userId;
    },
  );
}

export async function recallMemoryEvidence(
  groupId: number,
  opts: RecallMemoryOptions,
  db: MemoryDatabase = getMemoryDb(),
  judge?: EvidenceJudge,
) {
  const limit = opts.limit ?? 5;
  const queryVec = await resolveQueryVec(db, opts) ?? undefined;
  const base = { ...opts, queryVec, semantic: queryVec ? opts.semantic : false };
  const subject = (id: number) => `${memoryStore.getNickName(id, groupId, db) ?? '群友'} (${id})`.slice(0, META_CHARS);
  const candidates = await recallMemory(groupId, { ...base, candidateMode: true, limit: EVIDENCE_CANDIDATE_LIMIT }, db);
  const current = db.prepare(`SELECT m.text, m.owner_id, m.scope FROM memory m WHERE m.id = ? AND ${usableMemorySql()}`);
  return verify(
    opts.query,
    candidates,
    judge,
    limit,
    { asOf: backupDateKey(), subject: opts.aboutUserIds?.map(subject).join(',').slice(0, META_CHARS) || undefined },
    (hit) => ({ kind: 'memory', subject: subject(hit.ownerId) }),
    () => recallMemory(groupId, { ...base, limit }, db),
    (hit) => {
      const row = current.get(hit.id) as { text: string, owner_id: number, scope: string } | undefined;
      return row?.text === hit.text && row.owner_id === hit.ownerId && row.scope === hit.scope;
    },
  );
}
