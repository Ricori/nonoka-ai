import { printError } from '@/utils/print';
import { getMeta, setMeta, type MemoryDatabase } from './db';
import { historySince, usableMemorySql } from './policy';

/**
 * 向量存取与暴力检索。
 *
 * 向量化的是「话题片段」和「记忆条目」而不是每条消息，数量是 O(千) 而非 O(百万)，
 * 几千条 Float32Array 常驻内存扫一遍是毫秒级，不值得引一个向量索引库
 */

export type RefKind = 'memory' | 'topic';

/** 换 embedding 模型维度会变，首次写入时记下来，之后不一致直接拒绝 */
const DIM_KEY = 'vector_dim';

export interface SimilarHit {
  refId: number;
  /** 余弦相似度，[-1, 1] */
  score: number;
}

interface VecRow {
  refId: number;
  vec: Float32Array;
}

/** 存进库的都是单位向量，余弦相似度退化成点积 */
export function normalize(input: number[] | Float32Array): Float32Array {
  const vec = Float32Array.from(input);
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];

  const len = Math.sqrt(sum);
  if (len > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= len;
  }
  return vec;
}

export function vecToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function blobToVec(buf: Buffer): Float32Array {
  // Buffer 可能落在共享的 ArrayBuffer 上，slice 出一份独立且对齐的副本
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/** 解码后的向量按库 + 类型常驻内存，否则每次检索都要把整张表读出来重新解码 */
const cache = new WeakMap<MemoryDatabase, Map<RefKind, VecRow[]>>();
const cacheVersions = new WeakMap<MemoryDatabase, string>();

export function invalidateVectors(db: MemoryDatabase) {
  cache.delete(db);
  cacheVersions.delete(db);
}

function invalidate(db: MemoryDatabase, refKind: RefKind) {
  cache.get(db)?.delete(refKind);
}

function loadVectors(db: MemoryDatabase, refKind: RefKind): VecRow[] {
  const version = `${db.pragma('data_version', { simple: true })}:${historySince()}`;
  if (cacheVersions.get(db) !== version) {
    cache.delete(db);
    cacheVersions.set(db, version);
  }
  let byKind = cache.get(db);
  if (!byKind) {
    byKind = new Map();
    cache.set(db, byKind);
  }

  let rows = byKind.get(refKind);
  if (!rows) {
    rows = (db.prepare(refKind === 'topic'
      ? `SELECT e.ref_id, e.vec FROM embedding e JOIN topic t ON t.id = e.ref_id WHERE e.ref_kind = 'topic' AND t.date_key >= ${historySince()}`
      : `SELECT e.ref_id, e.vec FROM embedding e JOIN memory m ON m.id = e.ref_id WHERE e.ref_kind = 'memory' AND ${usableMemorySql()}`)
      .all() as { ref_id: number, vec: Buffer }[])
      .map((r) => ({ refId: r.ref_id, vec: blobToVec(r.vec) }));
    byKind.set(refKind, rows);
  }
  return rows;
}

export function getVectorDim(db: MemoryDatabase): number | null {
  const dim = getMeta(db, DIM_KEY);
  return dim === null ? null : Number(dim);
}

/** 维度守卫：第一次写入时定下维度，之后对不上就拒绝，免得两种模型的向量混在一张表里 */
function checkDim(db: MemoryDatabase, len: number): boolean {
  const dim = getVectorDim(db);
  if (dim === null) {
    setMeta(db, DIM_KEY, String(len));
    return true;
  }
  if (dim !== len) {
    printError(`[Vector] 维度不一致：库里是 ${dim}，这次是 ${len}。换 embedding 模型需要清空 embedding 表重建`);
    return false;
  }
  return true;
}

/** 批量写入（存在则覆盖），返回真正写进去的条数 */
export function saveEmbeddings(
  db: MemoryDatabase,
  refKind: RefKind,
  items: { refId: number, vec: number[] | Float32Array, sourceText?: string }[],
): number {
  if (items.length === 0) return 0;
  if (!checkDim(db, items[0].vec.length)) return 0;

  const stmt = db.prepare(
    'INSERT INTO embedding (ref_kind, ref_id, vec) VALUES (?, ?, ?) ON CONFLICT(ref_kind, ref_id) DO UPDATE SET vec = excluded.vec',
  );

  const written = db.transaction(() => {
    let n = 0;
    for (const { refId, vec, sourceText } of items) {
      let currentText = true;
      // 网络请求期间文本可能被改写、删除或冷却归档，迟到向量不能再写回来。
      if (sourceText !== undefined) {
        const current = db.prepare(refKind === 'memory'
          ? `SELECT m.text FROM memory m WHERE m.id = ? AND ${usableMemorySql()}`
          : `SELECT summary AS text FROM topic WHERE id = ? AND date_key >= ${historySince()}`)
          .get(refId) as { text: string } | undefined;
        currentText = !!current && current.text === sourceText;
      }
      // 同一批里维度飘了就跳过这条，不连累整批
      if (currentText && vec.length === items[0].vec.length) {
        stmt.run(refKind, refId, vecToBlob(normalize(vec)));
        n += 1;
      }
    }
    return n;
  })();

  invalidate(db, refKind);
  return written;
}

export function saveEmbedding(db: MemoryDatabase, refKind: RefKind, refId: number, vec: number[] | Float32Array) {
  return saveEmbeddings(db, refKind, [{ refId, vec }]);
}

export function deleteEmbeddings(db: MemoryDatabase, refKind: RefKind, refIds: number[]) {
  if (refIds.length === 0) return;
  const stmt = db.prepare('DELETE FROM embedding WHERE ref_kind = ? AND ref_id = ?');
  db.transaction(() => refIds.forEach((id) => stmt.run(refKind, id)))();
  invalidate(db, refKind);
}

/** 暴力余弦 top-K，按相似度降序。allowIds 给了就只在这批里找 */
export function searchSimilar(
  db: MemoryDatabase,
  refKind: RefKind,
  query: number[] | Float32Array,
  topK: number,
  allowIds?: Set<number>,
): SimilarHit[] {
  const q = normalize(query);
  const hits: SimilarHit[] = [];

  for (const row of loadVectors(db, refKind)) {
    // 维度对不上的是换模型前留下的旧向量，跳过而不是算出一个没意义的相似度
    if (row.vec.length === q.length && (!allowIds || allowIds.has(row.refId))) {
      let dot = 0;
      for (let i = 0; i < q.length; i++) dot += q[i] * row.vec[i];
      hits.push({ refId: row.refId, score: dot });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}
