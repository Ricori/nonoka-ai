import { printError, printLog } from '@/utils/print';
import {
  delMeta, getMeta, setMeta, type MemoryDatabase,
} from './db';
import { historySince, usableMemorySql } from './policy';

/**
 * 向量存取与暴力检索。
 *
 * 向量化的是「聊天窗口」和「记忆条目」而不是每条消息，数量是 O(万) 而非 O(百万)，
 * 几千条 Float32Array 常驻内存扫一遍是毫秒级，不值得引一个向量索引库
 */

export type RefKind = 'memory' | 'window';

/** 每种向量对应的源表与有效范围。窗口随热历史一起过期 */
function sourceSql(refKind: RefKind): { rows: string, text: string } {
  if (refKind === 'memory') {
    return {
      rows: `SELECT e.ref_id, e.vec FROM embedding e JOIN memory m ON m.id = e.ref_id WHERE e.ref_kind = 'memory' AND ${usableMemorySql()}`,
      text: `SELECT m.text FROM memory m WHERE m.id = ? AND ${usableMemorySql()}`,
    };
  }
  return {
    rows: `SELECT e.ref_id, e.vec FROM embedding e JOIN chat_window w ON w.id = e.ref_id WHERE e.ref_kind = 'window' AND w.date_key >= ${historySince()}`,
    text: `SELECT text FROM chat_window WHERE id = ? AND date_key >= ${historySince()}`,
  };
}

/** 换 embedding 模型维度会变，首次写入时记下来，之后不一致直接拒绝 */
const DIM_KEY = 'vector_dim';

/**
 * 库里向量出自哪个模型。维度相同的两个模型照样不能互相比，只看维度拦不住，
 * 所以按模型名认：变了就清空全部向量，由巩固任务在 45 天热窗口内重算
 */
const MODEL_KEY = 'vector_model';

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
    rows = (db.prepare(sourceSql(refKind).rows).all() as { ref_id: number, vec: Buffer }[])
      .map((r) => ({ refId: r.ref_id, vec: blobToVec(r.vec) }));
    byKind.set(refKind, rows);
  }
  return rows;
}

/**
 * 让库里的向量与这次返回的模型对齐，返回库里的旧向量还能不能用。
 * model 为 null 是旧版服务不报模型名，按原样放行
 */
export function syncVectorModel(db: MemoryDatabase, model: string | null): boolean {
  if (!model) return true;
  const current = getMeta(db, MODEL_KEY);
  if (current === model) return true;
  const cleared = db.transaction(() => {
    const n = db.prepare('DELETE FROM embedding').run().changes;
    delMeta(db, DIM_KEY);
    setMeta(db, MODEL_KEY, model);
    return n;
  }).immediate();
  invalidateVectors(db);
  printLog(`[Vector] embedding 模型 ${current ?? '(未记录)'} -> ${model}，清空 ${cleared} 条旧向量，等巩固任务重算`);
  return false;
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
  /** 产出这批向量的模型，传了就先与库对齐，模型变了会清空旧向量 */
  model?: string | null,
): number {
  if (items.length === 0) return 0;
  if (model !== undefined) syncVectorModel(db, model);
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
        const current = db.prepare(sourceSql(refKind).text).get(refId) as { text: string } | undefined;
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
