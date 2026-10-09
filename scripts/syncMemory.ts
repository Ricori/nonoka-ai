/**
 * 把服务器的 data/memory 增量同步到本地，便于用线上数据跑测试。
 * 普通文件按 大小+mtime 比对只拉变化的，聊天记录只拉最近 CHAT_DAYS 天；nonoka.db 拉服务端一致性快照（--no-db 跳过）。
 *
 * 用法：npm run memory:sync -- [--no-db] [--delete]
 *   --delete  删掉本地有、服务器已没有的文件（不碰 backups 和库文件）
 * 配置（环境变量或项目根 .env）：MEMORY_SYNC_URL=http://host:9615  LOG_TOKEN=xxx
 * 同步库前先停掉本地机器人/测试，否则库文件被占用无法替换。
 */
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import Database from 'better-sqlite3';

try {
  process.loadEnvFile('.env');
} catch {
  /* 没有 .env 就只用环境变量 */
}

const BASE = (process.env.MEMORY_SYNC_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.LOG_TOKEN || '';
const ARGS = new Set(process.argv.slice(2));
const MEMORY_DIR = path.resolve('data', 'memory');
const DB_FILE = path.join(MEMORY_DIR, 'nonoka.db');
const CONCURRENCY = 8;
/** 聊天记录只同步最近这么多天的（按文件名里的日期） */
const CHAT_DAYS = 45;
const CHAT_RE = /^chat\/\d+_(\d{8})\.txt$/;

interface RemoteFile { path: string, size: number, mtime: number }

function api(pathname: string, params: Record<string, string> = {}): string {
  const u = new URL(BASE + pathname);
  if (TOKEN) u.searchParams.set('token', TOKEN);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/** 下载到 .sync-tmp，成功才返回临时路径，调用方负责改名 */
async function download(url: string, dest: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${res.status} ${await res.text()}`);
  const tmp = `${dest}.sync-tmp`;
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmp));
  return tmp;
}

function isSame(abs: string, remote: RemoteFile): boolean {
  try {
    const st = fs.statSync(abs);
    return st.size === remote.size && Math.abs(st.mtimeMs - remote.mtime) < 1000;
  } catch {
    return false;
  }
}

async function syncFiles() {
  const res = await fetch(api('/memory-manifest'));
  if (!res.ok) throw new Error(`拉清单失败: ${res.status} ${await res.text()}`);
  const remote = await res.json() as RemoteFile[];
  const cutoff = new Date(Date.now() - CHAT_DAYS * 86400000).toLocaleDateString('sv').replace(/-/g, '');
  const wanted = remote.filter((f) => {
    const m = CHAT_RE.exec(f.path);
    return !m || m[1] >= cutoff;
  });
  const changed = wanted.filter((f) => !isSame(path.join(MEMORY_DIR, f.path), f));
  console.log(`[sync] 服务器 ${remote.length} 个文件，${CHAT_DAYS} 天内 ${wanted.length} 个，需更新 ${changed.length} 个`);

  let done = 0;
  const queue = [...changed];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const dest = path.join(MEMORY_DIR, f.path);
      fs.renameSync(await download(api('/memory-file', { path: f.path }), dest), dest);
      // mtime 对齐服务器，下次才能按 mtime 判断没变
      fs.utimesSync(dest, new Date(), new Date(f.mtime));
      done += 1;
      if (done % 50 === 0 || done === changed.length) console.log(`[sync] ${done}/${changed.length}`);
    }
  }));

  if (ARGS.has('--delete')) {
    const keep = new Set(remote.map((f) => f.path));
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const abs = path.join(dir, e.name);
      return e.isDirectory() ? walk(abs) : [path.relative(MEMORY_DIR, abs).split(path.sep).join('/')];
    });
    const stale = walk(MEMORY_DIR).filter((rel) => !rel.startsWith('backups/') && !rel.startsWith('nonoka.db') && !keep.has(rel));
    stale.forEach((rel) => fs.rmSync(path.join(MEMORY_DIR, rel)));
    console.log(`[sync] 删除本地多余文件 ${stale.length} 个`);
  }
}

async function syncDb() {
  console.log('[sync] 拉取数据库快照（服务端先做 VACUUM，需要一会儿）…');
  const started = Date.now();
  const tmp = await download(api('/memory-db'), DB_FILE);
  const check = new Database(tmp, { readonly: true });
  const result = check.pragma('quick_check', { simple: true });
  check.close();
  if (result !== 'ok') throw new Error(`快照校验失败: ${result}`);
  // 旧 WAL 留着会被套到新库上导致损坏，必须一起删
  for (const f of [`${DB_FILE}-wal`, `${DB_FILE}-shm`]) fs.rmSync(f, { force: true });
  fs.renameSync(tmp, DB_FILE);
  const mb = (fs.statSync(DB_FILE).size / 1048576).toFixed(1);
  console.log(`[sync] 数据库已替换（${mb} MB，${((Date.now() - started) / 1000).toFixed(0)}s）`);
}

async function main() {
  if (!BASE) throw new Error('未配置 MEMORY_SYNC_URL（可写在项目根 .env）');
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  await syncFiles();
  if (!ARGS.has('--no-db')) await syncDb();
}

main().catch((err) => {
  console.error(`[sync] 失败: ${err instanceof Error ? err.message : err}`);
  if (/EBUSY|EPERM/.test(String(err))) console.error('[sync] 库文件被占用，先停掉本地机器人/测试进程');
  process.exit(1);
});
