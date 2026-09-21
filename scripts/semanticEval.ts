import fs from 'fs';
import { botConfig } from '@/core/nnkConfig';
import { embedTexts } from '@/service/llm';
import { createMemoryDb } from '@/modules/aiReply/memory/db';
import { recallChat } from '@/modules/aiReply/memory/retrieve';
import { saveEmbeddings, syncVectorModel } from '@/modules/aiReply/memory/vector';
import { buildWindows } from '@/modules/aiReply/memory/window';
import { historySince } from '@/modules/aiReply/memory/policy';

/**
 * 语义召回评测与阈值校准：只走字面 vs 字面 + 窗口，在人工标注的查询上扫相似度下限，
 * 比 top5 命中率和误召回。换 embedding 模型后用它重新定 MIN_SIMILARITY。
 *
 * 会往库里写窗口和向量，务必对着副本跑：
 *   cp data/memory/nonoka.db* /tmp/
 *   SERVICE_URL=http://127.0.0.1:8787 SERVICE_KEY=xxx npx tsx scripts/semanticEval.ts <标注.json> /tmp/nonoka.db
 *
 * 标注格式 [{ g: 群号, q: 查询, gold: [chat_line.id...] }]，命中任一 gold 行即算召回；
 * gold 为空是负样本，群里没聊过，语义路返回的都算误召回。
 * 花费：窗口向量化（模型变了会全量重算）+ 每条查询一次 embed，不调 chat 模型。
 *
 * SCOPE=gold 省钱模式：窗口只算标注样本所在的群-天，并删掉副本里范围外的窗口。
 * 候选池变小，干扰项少，绝对数字偏高，只适合横向比较阈值
 */

const [setPath, dbPath] = process.argv.slice(2);
if (!setPath || !dbPath) {
  console.error('用法: npx tsx scripts/semanticEval.ts <标注.json> <库副本路径>');
  process.exit(1);
}
if (dbPath.replace(/\\/g, '/').endsWith('data/memory/nonoka.db')) throw new Error('别对着线上库跑，先复制一份');
// 服务端还没部署时，指向本地 wrangler dev
if (process.env.SERVICE_URL) botConfig.nonokaService.baseUrl = process.env.SERVICE_URL;
if (process.env.SERVICE_KEY) botConfig.nonokaService.apiKey = process.env.SERVICE_KEY;

interface Case { g: number, q: string, gold: number[] }
const cases = JSON.parse(fs.readFileSync(setPath, 'utf-8')) as Case[];
const db = createMemoryDb(dbPath);

const EMBED_BATCH = 100;
const SCOPE = process.env.SCOPE === 'gold';
const THRESHOLDS = [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70];

async function embed(texts: string[]) {
  // 上游偶发 502，重试几次再放弃
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await embedTexts(texts);
    if (result) return result;
  }
  throw new Error('向量化连续失败（额度用完或服务不可用），重跑会从断点继续');
}

/** 标注样本所在的群-天，SCOPE=gold 时窗口只留这些 */
function goldDays(): string {
  const rows = [...new Set(cases.flatMap((c) => c.gold))].map((id) => db.prepare(
    'SELECT group_id AS g, date_key AS d FROM chat_line WHERE id = ?',
  ).get(id) as { g: number, d: number });
  return [...new Set(rows.map((r) => `(${r.g}, ${r.d})`))].join(', ');
}

async function prepare() {
  const groups = [...new Set(cases.map((c) => c.g))];
  const created = groups.flatMap((g) => buildWindows(db, g, historySince()));
  console.log(`新切窗口 ${created.length} 个`);
  if (SCOPE) {
    const days = goldDays();
    db.transaction(() => {
      db.exec(`DELETE FROM embedding WHERE ref_kind = 'window' AND ref_id IN
        (SELECT id FROM chat_window WHERE (group_id, date_key) NOT IN (VALUES ${days}))`);
      db.exec(`DELETE FROM chat_window WHERE (group_id, date_key) NOT IN (VALUES ${days})`);
    })();
  }
  // 先用一次小请求对齐模型：换了模型会在这里清空旧向量，下面才按新模型补
  const probe = await embed(['模型探测']);
  console.log(`embedding 模型 ${probe.model ?? '(服务未返回，旧版)'}`);
  syncVectorModel(db, probe.model);

  const missing = db.prepare(`SELECT w.id, w.text FROM chat_window w
    LEFT JOIN embedding e ON e.ref_kind = 'window' AND e.ref_id = w.id
    WHERE e.ref_id IS NULL AND w.date_key >= ? AND w.group_id IN (${groups.join(', ')})`)
    .all(historySince()) as { id: number, text: string }[];
  console.log(`窗口待向量化 ${missing.length} 个`);
  for (let i = 0; i < missing.length; i += EMBED_BATCH) {
    const batch = missing.slice(i, i + EMBED_BATCH);
    const result = await embed(batch.map((r) => r.text));
    saveEmbeddings(db, 'window', batch.map((r, j) => ({ refId: r.id, vec: result.vectors[j] })), result.model);
    if ((i / EMBED_BATCH) % 20 === 0) console.log(`  ${i + batch.length}/${missing.length}`);
  }
}

interface Score { hit: number, rr: number, semanticOnlyHit: number, noise: number, negNoise: number }

async function evaluate(semantic: boolean, vecs: Float32Array[], minSimilarity?: number) {
  const s: Score = {
    hit: 0, rr: 0, semanticOnlyHit: 0, noise: 0, negNoise: 0,
  };
  const marks: string[] = [];
  for (const [i, c] of cases.entries()) {
    const hits = await recallChat(c.g, semantic
      ? { query: c.q, queryVec: vecs[i], minSimilarity }
      : { query: c.q, semantic: false }, db);
    const gold = new Set(c.gold);
    // 只靠语义路进来、又不是答案的，算误召回
    const noise = hits.filter((h) => h.via === 'semantic' && !gold.has(h.id)).length;
    if (c.gold.length === 0) {
      s.negNoise += noise;
      marks.push(noise ? `误${noise}` : '—');
      continue;
    }
    s.noise += noise;
    const rank = hits.findIndex((h) => gold.has(h.id));
    if (rank >= 0) {
      s.hit += 1;
      s.rr += 1 / (rank + 1);
      if (hits[rank].via === 'semantic') s.semanticOnlyHit += 1;
    }
    marks.push(rank >= 0 ? `#${rank + 1}${hits[rank].via === 'semantic' ? '语' : ''}` : '—');
  }
  return { s, marks };
}

async function run() {
  await prepare();
  const vecs: Float32Array[] = [];
  for (const c of cases) vecs.push(Float32Array.from((await embed([c.q])).vectors[0]));

  const pos = cases.filter((c) => c.gold.length > 0).length;
  const neg = cases.length - pos;
  const fmt = (s: Score) => `hit@5 ${String(s.hit).padStart(2)}/${pos}  MRR ${(s.rr / pos).toFixed(3)}  `
    + `仅语义命中 ${String(s.semanticOnlyHit).padStart(2)}  正样本误召回 ${String(s.noise).padStart(3)}  负样本误召回 ${String(s.negNoise).padStart(2)}（${neg} 条）`;

  const literal = await evaluate(false, vecs);
  console.log(`\n字面      ${fmt(literal.s)}`);
  console.log('\n[字面 + 窗口] 按相似度下限扫');
  for (const t of THRESHOLDS) console.log(`  ${t.toFixed(2)}  ${fmt((await evaluate(true, vecs, t)).s)}`);

  // 逐条明细用当前代码里的默认阈值，看具体哪条输在哪
  const withWindow = await evaluate(true, vecs);
  console.log('\n逐条（默认阈值）  字面 / 字面+窗口');
  cases.forEach((c, i) => console.log(`  ${literal.marks[i].padEnd(6)}${withWindow.marks[i].padEnd(6)} ${c.gold.length ? '' : '[负] '}${c.q}`));
}

try {
  await run();
} finally {
  db.close();
}
