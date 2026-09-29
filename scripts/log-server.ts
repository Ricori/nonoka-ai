/**
 * 轻量日志网页服务：tail PM2 的日志文件，用 SSE 实时推到浏览器。
 * 除复用项目里的 better-sqlite3 做数据库备份外只用 Node 内置模块。独立于机器人进程运行（机器人崩了也能看日志）。
 *
 * 用法：
 *   npx tsx scripts/log-server.ts
 * 环境变量：
 *   LOG_PORT   监听端口，默认 9615
 *   LOG_HOST   绑定地址，默认 0.0.0.0（对外可访问）
 *   LOG_TOKEN  访问令牌，建议设置；设置后需用 ?token=xxx 访问
 *   LOG_FILES  要 tail 的文件，逗号分隔，默认 logs/nonoka.log
 *   LOG_TAIL   初次连接回放的行数，默认 300
 *   LOG_DB_BACKUP_DAYS  记忆库自动备份间隔天数，默认 10，0 关闭
 *   LOG_DB_BACKUP_KEEP  自动备份保留份数，默认 3
 *
 * pm2-logrotate 配置为 retain all 后旧日志会一直保留（见 scripts/setup-logrotate.sh），
 * 切分出来的归档文件（<name>__<时间戳>.log[.gz]）不会再被 tail，但可以通过
 * GET /archives 列出、GET /archive?file=xxx 读取（网页上也有下拉框可以切换查看）。
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 程序主目录（scripts 的上一级） */
const ROOT = path.resolve(__dirname, '..');
/** 要打包下载的记忆目录 */
const MEMORY_DIR = path.resolve(ROOT, 'data', 'memory');
/** pm2 要 reload 的应用名（逗号分隔）。注意别写 nonoka-log，否则会把本服务自己重启掉、更新中断 */
const UPDATE_APPS = (process.env.LOG_UPDATE_APPS || 'nonoka')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const PORT = Number(process.env.LOG_PORT || 9615);
const HOST = process.env.LOG_HOST || '0.0.0.0';
const TOKEN = process.env.LOG_TOKEN || '';
const TAIL_LINES = Number(process.env.LOG_TAIL || 500);
const FILES = (process.env.LOG_FILES || 'logs/out.log,logs/error.log')
  .split(',')
  .map((f) => f.trim())
  .filter(Boolean)
  .map((f) => path.resolve(__dirname, '..', f));

/** 当前连接的 SSE 客户端 */
const clients = new Set<http.ServerResponse>();

/** 广播一条日志到所有客户端 */
function broadcast(line: string) {
  const payload = `data: ${line.replace(/\n/g, '\\n')}\n\n`;
  for (const res of clients) res.write(payload);
}

/** 是否正在执行更新，避免并发点击重复触发 */
let updating = false;

interface UpdateStep {
  cmd: string;
  args: string[];
}

/** 顺序执行一组命令，输出实时广播到日志页面（带 [update] 标签） */
function runSteps(steps: UpdateStep[], done: (ok: boolean) => void) {
  const line = (s: string) => broadcast(`[update] ${s}`);
  let idx = 0;
  const next = () => {
    if (idx >= steps.length) {
      line('✅ 更新完成');
      done(true);
      return;
    }
    const { cmd, args } = steps[idx++];
    line(`$ ${cmd} ${args.join(' ')}`);
    // Windows 下 git / pm2 常是 .cmd，需要 shell 才能找到
    const child = spawn(cmd, args, { cwd: ROOT, shell: true });
    child.stdout.on('data', (d) => d.toString('utf8').split(/\r?\n/).filter(Boolean).forEach(line));
    child.stderr.on('data', (d) => d.toString('utf8').split(/\r?\n/).filter(Boolean).forEach(line));
    child.on('error', (err) => {
      line(`❌ 执行失败: ${err.message}`);
      done(false);
    });
    child.on('close', (code) => {
      if (code === 0) {
        next();
      } else {
        line(`❌ 命令退出码 ${code}，更新中止`);
        done(false);
      }
    });
  };
  next();
}

/** 执行「git pull + pm2 reload」，全过程输出广播到日志页面 */
function doUpdate(done: (ok: boolean) => void) {
  if (updating) {
    broadcast('[update] ⚠️ 已有更新任务在执行中，忽略本次请求');
    done(false);
    return;
  }
  updating = true;
  broadcast('[update] 🚀 开始更新代码…');
  const steps: UpdateStep[] = [
    { cmd: 'git', args: ['pull'] },
    ...UPDATE_APPS.map((app) => ({ cmd: 'pm2', args: ['reload', app] })),
  ];
  runSteps(steps, (ok) => {
    updating = false;
    done(ok);
  });
}

/** 读取一个文件的全部文本行，自动识别 .gz（pm2-logrotate 压缩后的归档） */
function readAllLines(file: string): string[] {
  try {
    const buf = fs.readFileSync(file);
    const text = file.endsWith('.gz') ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    return text.split(/\r?\n/).filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/** 读取文件最后 n 行（用于初次连接回放） */
function readLastLines(file: string, n: number): string[] {
  return readAllLines(file).slice(-n);
}

interface ArchiveEntry {
  name: string;
  abs: string;
  tag: string;
  mtime: number;
}

/** 列出某个实时日志文件对应的归档（pm2-logrotate 切分出来的旧文件），新的排前面 */
function listArchives(file: string): ArchiveEntry[] {
  const dir = path.dirname(file);
  const base = path.basename(file, '.log');
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.startsWith(`${base}__`) && (name.endsWith('.log') || name.endsWith('.log.gz')))
    .map((name) => {
      const abs = path.join(dir, name);
      let mtime = 0;
      try {
        mtime = fs.statSync(abs).mtimeMs;
      } catch {
        /* 文件可能刚好被删，忽略 */
      }
      return { name, abs, tag: path.basename(file), mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/** 凑够最近 n 行：实时文件不够时，往前翻归档补齐（避免刚切分完看起来突然没日志了） */
function readLastLinesWithHistory(file: string, n: number): string[] {
  let lines = readLastLines(file, n);
  const archives = listArchives(file); // 新的在前
  for (const { abs } of archives) {
    if (lines.length >= n) break;
    const need = n - lines.length;
    lines = readAllLines(abs).slice(-need).concat(lines);
  }
  return lines;
}

/** 从一行日志里提取时间戳（配合 pm2 的 log_date_format），提取不到返回 null */
function extractTime(line: string): number | null {
  const m = line.match(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?)/);
  if (!m) return null;
  const t = Date.parse(m[1].replace(' ', 'T'));
  return Number.isNaN(t) ? null : t;
}

interface MergedLine {
  tag: string;
  line: string;
  time: number | null;
  fileIdx: number;
  idx: number;
}

/** 汇总所有文件最近的日志行，按时间排序后只保留最近 n 条（跨文件合计，而非每个文件各 n 条） */
function readMergedTail(files: string[], n: number): MergedLine[] {
  const merged: MergedLine[] = [];
  files.forEach((file, fileIdx) => {
    const tag = path.basename(file);
    let lastTime: number | null = null;
    readLastLinesWithHistory(file, n).forEach((line, idx) => {
      // 没有时间戳的行（如多行堆栈续行）沿用同文件上一行的时间，跟在其后而不是被甩到最前
      const time = extractTime(line) ?? lastTime;
      if (time != null) lastTime = time;
      merged.push({ tag, line, time, fileIdx, idx });
    });
  });
  merged.sort((a, b) => {
    if (a.time != null && b.time != null) return a.time - b.time || a.fileIdx - b.fileIdx || a.idx - b.idx;
    if (a.time == null && b.time == null) {
      return a.fileIdx - b.fileIdx || a.idx - b.idx;
    }
    // 一边有时间一边没有（整份日志都没时间戳的极端情况），退化为按原始顺序
    return a.time == null ? -1 : 1;
  });
  return merged.slice(-n);
}

/** CRC32 查表（zip 格式要求，Node 内置 zlib 不直接提供 crc32，自己算） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** JS Date -> DOS 日期/时间（zip 头部字段要求的格式） */
function toDosTime(date: Date): { time: number; dosDate: number } {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dosDate = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, dosDate };
}

interface WalkedFile {
  abs: string;
  rel: string;
}

/** 递归收集目录下所有文件，返回相对路径列表 */
function walkFiles(dir: string, base: string = dir): WalkedFile[] {
  const out: WalkedFile[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(abs, base));
    } else if (entry.isFile()) {
      out.push({ abs, rel: path.relative(base, abs).split(path.sep).join('/') });
    }
  }
  return out;
}

/** 用内置 zlib（deflate raw）手写一个最小可用的 zip 打包器，避免引入第三方依赖 */
function buildZip(dir: string, skip: (rel: string) => boolean = () => false): Buffer {
  const files = walkFiles(dir).filter((f) => !skip(f.rel));
  const chunks: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let offset = 0;

  for (const { abs, rel } of files) {
    const content = fs.readFileSync(abs);
    const { time, dosDate } = toDosTime(fs.statSync(abs).mtime);
    const crc = crc32(content);
    const compressed = zlib.deflateRawSync(content);
    const nameBuf = Buffer.from(rel, 'utf8');

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(8, 8); // method: deflate
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra length

    chunks.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(8, 10); // method
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // local header offset

    centralRecords.push(Buffer.concat([centralHeader, nameBuf]));
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(files.length, 8); // entries this disk
  end.writeUInt16LE(files.length, 10); // total entries
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16); // central dir offset
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, centralDir, end]);
}

/** 监听单个文件的增量内容 */
function watchFile(file: string) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    size = 0;
  }

  const tag = path.basename(file);

  let reading = false;

  const onChange = () => {
    // fs.watch 和轮询可能同时触发；正在读时直接跳过，避免重复读同一段
    if (reading) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return;
    }
    // 日志轮转：文件被截断，重头读
    if (stat.size < size) size = 0;
    if (stat.size <= size) return;

    const start = size;
    const end = stat.size;
    // 立即推进 size，防止后续 onChange 再读同一段（读取是异步的）
    size = end;
    reading = true;

    const stream = fs.createReadStream(file, { start, end: end - 1 });
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString('utf8');
    });
    stream.on('end', () => {
      reading = false;
      buf
        .split(/\r?\n/)
        .filter((l) => l.length > 0)
        .forEach((l) => broadcast(`[${tag}] ${l}`));
    });
    stream.on('error', () => {
      reading = false;
      // 读失败则回退 size，下次重试这段
      if (size === end) size = start;
    });
  };

  // fs.watch 在某些平台对追加不灵敏，配合轮询兜底
  try {
    fs.watch(file, { persistent: true }, onChange);
  } catch {
    /* 文件可能还不存在，靠轮询 */
  }
  setInterval(onChange, 1000);
}

const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nonoka Logs</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 ui-monospace, Consolas, Menlo, monospace;
         background: #0d1117; color: #c9d1d9; }
  header { position: sticky; top: 0; display: flex; gap: 12px; align-items: center;
           padding: 10px 14px; background: #161b22; border-bottom: 1px solid #30363d; }
  header b { color: #58a6ff; }
  header .sp { flex: 1; }
  header button, header input, header select { font: inherit; color: #c9d1d9; background: #21262d;
           border: 1px solid #30363d; border-radius: 6px; padding: 4px 10px; }
  header button { cursor: pointer; }
  #status { font-size: 12px; }
  #status.ok { color: #3fb950; }
  #status.off { color: #f85149; }
  #log { padding: 8px 14px; white-space: pre-wrap; word-break: break-word; }
  #log .err { color: #ff7b72; }
  #log .line:hover { background: #161b22; }
</style>
</head>
<body>
<header>
  <b>Nonoka</b> 日志
  <span id="status" class="off">● 连接中…</span>
  <span class="sp"></span>
  <input id="filter" placeholder="过滤关键字…" />
  <select id="archiveSelect"><option value="">实时</option></select>
  <button id="update">更新代码</button>
  <button id="memoryBackup">下载记忆备份</button>
  <button id="autoscroll">自动滚动: 开</button>
  <button id="clear">清屏</button>
</header>
<div id="log"></div>
<script>
  const logEl = document.getElementById('log');
  const statusEl = document.getElementById('status');
  const filterEl = document.getElementById('filter');
  const autoBtn = document.getElementById('autoscroll');
  let auto = true, filter = '';
  const token = new URLSearchParams(location.search).get('token') || '';

  autoBtn.onclick = () => { auto = !auto; autoBtn.textContent = '自动滚动: ' + (auto ? '开' : '关'); };
  document.getElementById('clear').onclick = () => { logEl.innerHTML = ''; };

  const updateBtn = document.getElementById('update');
  updateBtn.onclick = async () => {
    if (!confirm('确定要执行 git pull 并 reload 机器人吗？')) return;
    updateBtn.disabled = true;
    const old = updateBtn.textContent;
    updateBtn.textContent = '更新中…';
    try {
      const res = await fetch('/update' + (token ? '?token=' + encodeURIComponent(token) : ''), { method: 'POST' });
      if (!res.ok) alert('触发失败: ' + res.status + ' ' + (await res.text()));
    } catch (e) {
      alert('触发失败: ' + e.message);
    } finally {
      // 进度看日志流即可，稍后恢复按钮
      setTimeout(() => { updateBtn.disabled = false; updateBtn.textContent = old; }, 5000);
    }
  };
  const memoryBtn = document.getElementById('memoryBackup');
  memoryBtn.onclick = () => {
    const url = '/memory-archive' + (token ? '?token=' + encodeURIComponent(token) : '');
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  filterEl.oninput = () => {
    filter = filterEl.value.toLowerCase();
    for (const div of logEl.children) {
      div.style.display = (!filter || div.dataset.text.includes(filter)) ? '' : 'none';
    }
  };

  function append(text) {
    const div = document.createElement('div');
    div.className = 'line' + (/\\[error\\.log\\]|error|fail|exception/i.test(text) ? ' err' : '');
    div.textContent = text;
    div.dataset.text = text.toLowerCase();
    if (filter && !div.dataset.text.includes(filter)) div.style.display = 'none';
    logEl.appendChild(div);
    while (logEl.childElementCount > 5000) logEl.removeChild(logEl.firstChild);
    if (auto) window.scrollTo(0, document.body.scrollHeight);
  }

  /** 静态展示一份归档日志的全部内容（不受 5000 行裁剪限制，只读不追加） */
  function renderArchive(lines) {
    logEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const text of lines) {
      const div = document.createElement('div');
      div.className = 'line' + (/error|fail|exception/i.test(text) ? ' err' : '');
      div.textContent = text;
      div.dataset.text = text.toLowerCase();
      if (filter && !div.dataset.text.includes(filter)) div.style.display = 'none';
      frag.appendChild(div);
    }
    logEl.appendChild(frag);
    window.scrollTo(0, document.body.scrollHeight);
  }

  let es = null;
  function connect() {
    es = new EventSource('/stream' + (token ? '?token=' + encodeURIComponent(token) : ''));
    es.onopen = () => { statusEl.textContent = '● 已连接'; statusEl.className = 'ok'; };
    es.onmessage = (e) => append(e.data.replace(/\\\\n/g, '\\n'));
    es.onerror = () => { statusEl.textContent = '● 断开，重连中…'; statusEl.className = 'off'; };
  }

  const archiveSelect = document.getElementById('archiveSelect');
  async function loadArchives() {
    try {
      const res = await fetch('/archives' + (token ? '?token=' + encodeURIComponent(token) : ''));
      const list = await res.json();
      const cur = archiveSelect.value;
      archiveSelect.innerHTML = '<option value="">实时</option>';
      for (const a of list) {
        const opt = document.createElement('option');
        opt.value = a.name;
        opt.textContent = '[' + a.tag + '] ' + a.name;
        archiveSelect.appendChild(opt);
      }
      archiveSelect.value = cur;
    } catch {
      /* 归档列表加载失败不影响实时日志，忽略 */
    }
  }
  archiveSelect.onchange = async () => {
    const name = archiveSelect.value;
    if (!name) {
      logEl.innerHTML = '';
      if (!es) connect();
      return;
    }
    if (es) { es.close(); es = null; }
    statusEl.textContent = '● 历史日志（只读）';
    statusEl.className = 'off';
    try {
      const res = await fetch('/archive?file=' + encodeURIComponent(name) + (token ? '&token=' + encodeURIComponent(token) : ''));
      if (!res.ok) { alert('加载失败: ' + res.status + ' ' + (await res.text())); return; }
      const text = await res.text();
      renderArchive(text.split(/\\r?\\n/).filter(Boolean));
    } catch (e) {
      alert('加载失败: ' + e.message);
    }
  };

  loadArchives();
  connect();
</script>
</body>
</html>`;

function checkAuth(req: http.IncomingMessage): boolean {
  if (!TOKEN) return true;
  const url = new URL(req.url ?? '', 'http://x');
  return url.searchParams.get('token') === TOKEN;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '', 'http://x');

  if (url.pathname === '/update') {
    if (!checkAuth(req)) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end('method not allowed');
      return;
    }
    doUpdate(() => { });
    // 立即返回，具体进度通过日志流实时查看
    res.writeHead(202, { 'Content-Type': 'text/plain; charset=utf-8' }).end('更新已触发，请查看日志');
    return;
  }

  if (url.pathname === '/memory-archive') {
    if (!checkAuth(req)) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    if (!fs.existsSync(MEMORY_DIR)) {
      res.writeHead(404).end('data/memory 目录不存在');
      return;
    }
    let zipBuf: Buffer;
    try {
      // 备份目录动辄几百 MB，整个读进内存打包会撑爆，要备份自己去服务器上拿
      zipBuf = buildZip(MEMORY_DIR, (rel) => rel.startsWith('backups/'));
    } catch (err) {
      res.writeHead(500).end(`打包失败: ${err}`);
      return;
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="memory-${stamp}.zip"`,
      'Content-Length': zipBuf.length,
    });
    res.end(zipBuf);
    return;
  }

  if (url.pathname === '/archives') {
    if (!checkAuth(req)) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    const list = FILES.flatMap(listArchives)
      .sort((a, b) => b.mtime - a.mtime)
      .map(({ name, tag, mtime }) => ({ name, tag, mtime }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(list));
    return;
  }

  if (url.pathname === '/archive') {
    if (!checkAuth(req)) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    const name = url.searchParams.get('file') || '';
    // 只允许读取 listArchives 枚举出来的归档文件，防止路径穿越
    const found = FILES.flatMap(listArchives).find((a) => a.name === name);
    if (!found) {
      res.writeHead(404).end('未找到该归档日志');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(readAllLines(found.abs).join('\n'));
    return;
  }

  if (url.pathname === '/stream') {
    if (!checkAuth(req)) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');

    // 回放所有文件最近的日志，按时间合并，跨文件合计只取最近 TAIL_LINES 条
    for (const { tag, line } of readMergedTail(FILES, TAIL_LINES)) {
      res.write(`data: [${tag}] ${line.replace(/\n/g, '\\n')}\n\n`);
    }

    clients.add(res);
    const ka = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ka);
      clients.delete(res);
    });
    return;
  }

  // 主页
  if (url.pathname === '/') {
    if (!checkAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('需要 token，请用 ?token=xxx 访问');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
    return;
  }

  res.writeHead(404).end('not found');
});

// ========== 记忆库定期备份 ==========

const DB_FILE = path.join(MEMORY_DIR, 'nonoka.db');
const BACKUP_DIR = path.join(MEMORY_DIR, 'backups');
const BACKUP_DAYS = Number(process.env.LOG_DB_BACKUP_DAYS ?? 10);
const BACKUP_KEEP = Math.max(1, Number(process.env.LOG_DB_BACKUP_KEEP ?? 3));
/** 自动备份的文件名，时间戳写在名字里：按名字判断是否到期，拷贝/同步改了 mtime 也不受影响 */
const AUTO_BACKUP_RE = /^nonoka-auto-(\d{8})-(\d{6})\.db$/;

function autoBackups(): { name: string, time: number }[] {
  let names: string[];
  try {
    names = fs.readdirSync(BACKUP_DIR);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const m = AUTO_BACKUP_RE.exec(name);
    if (!m) return [];
    const [d, t] = [m[1], m[2]];
    const time = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4)}`).getTime();
    return [{ name, time }];
  }).sort((a, b) => b.time - a.time);
}

/** 到期就备份一次。VACUUM INTO 在只读连接上生成一致的压缩快照，不锁机器人的写入，WAL 里的数据也会带上 */
function backupIfDue() {
  if (!(BACKUP_DAYS > 0) || !fs.existsSync(DB_FILE)) return;
  const latest = autoBackups()[0];
  if (latest && Date.now() - latest.time < BACKUP_DAYS * 86400000) return;

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const target = path.join(BACKUP_DIR, `nonoka-auto-${stamp}.db`);
  // 先写临时名再改名，中途失败不会留下一份看着像成功的残缺备份
  const tmp = `${target}.tmp`;
  let db: Database.Database | null = null;
  try {
    db = new Database(DB_FILE, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 10000');
    db.prepare('VACUUM INTO ?').run(tmp);
    fs.renameSync(tmp, target);
    autoBackups().slice(BACKUP_KEEP).forEach((b) => fs.rmSync(path.join(BACKUP_DIR, b.name), { force: true }));
    console.log(`[log-server] 记忆库已备份：${target}（${(fs.statSync(target).size / 1048576).toFixed(1)} MB）`);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    console.error(`[log-server] 记忆库备份失败：${err}`);
  } finally {
    db?.close();
  }
}

FILES.forEach(watchFile);
// 启动后稍等再查，避开和机器人同时启动时的迁移；之后每小时看一次是否到期
setTimeout(backupIfDue, 60 * 1000);
setInterval(backupIfDue, 60 * 60 * 1000);
server.listen(PORT, HOST, () => {
  console.log(`[log-server] http://${HOST}:${PORT}  tailing: ${FILES.join(', ')}`);
  if (!TOKEN) console.log('[log-server] 警告：未设置 LOG_TOKEN，任何人可访问，建议设置');
});
