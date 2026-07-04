/**
 * 轻量日志网页服务：tail PM2 的日志文件，用 SSE 实时推到浏览器。
 * 纯 Node 内置模块，不加任何依赖。独立于机器人进程运行（机器人崩了也能看日志）。
 *
 * 用法：
 *   node scripts/log-server.cjs
 * 环境变量：
 *   LOG_PORT   监听端口，默认 9615
 *   LOG_HOST   绑定地址，默认 0.0.0.0（对外可访问）
 *   LOG_TOKEN  访问令牌，建议设置；设置后需用 ?token=xxx 访问
 *   LOG_FILES  要 tail 的文件，逗号分隔，默认 logs/nonoka.log
 *   LOG_TAIL   初次连接回放的行数，默认 300
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.LOG_PORT || 9615);
const HOST = process.env.LOG_HOST || '0.0.0.0';
const TOKEN = process.env.LOG_TOKEN || '';
const TAIL_LINES = Number(process.env.LOG_TAIL || 300);
const FILES = (process.env.LOG_FILES || 'logs/out.log,logs/error.log')
  .split(',')
  .map((f) => f.trim())
  .filter(Boolean)
  .map((f) => path.resolve(__dirname, '..', f));

/** 当前连接的 SSE 客户端 */
const clients = new Set();

/** 广播一条日志到所有客户端 */
function broadcast(line) {
  const payload = `data: ${line.replace(/\n/g, '\\n')}\n\n`;
  for (const res of clients) res.write(payload);
}

/** 读取文件最后 n 行（用于初次连接回放） */
function readLastLines(file, n) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split(/\r?\n/);
    return lines.slice(-n - 1, -1); // 去掉结尾空行
  } catch {
    return [];
  }
}

/** 从一行日志里提取时间戳（配合 pm2 的 log_date_format），提取不到返回 null */
function extractTime(line) {
  const m = line.match(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?)/);
  if (!m) return null;
  const t = Date.parse(m[1].replace(' ', 'T'));
  return Number.isNaN(t) ? null : t;
}

/** 汇总所有文件最近的日志行，按时间排序后只保留最近 n 条（跨文件合计，而非每个文件各 n 条） */
function readMergedTail(files, n) {
  const merged = [];
  files.forEach((file, fileIdx) => {
    const tag = path.basename(file);
    let lastTime = null;
    readLastLines(file, n).forEach((line, idx) => {
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

/** 监听单个文件的增量内容 */
function watchFile(file) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    size = 0;
  }

  const tag = path.basename(file);

  const onChange = () => {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return;
    }
    // 日志轮转：文件被截断，重头读
    if (stat.size < size) size = 0;
    if (stat.size === size) return;

    const stream = fs.createReadStream(file, { start: size, end: stat.size });
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString('utf8');
    });
    stream.on('end', () => {
      size = stat.size;
      buf
        .split(/\r?\n/)
        .filter((l) => l.length > 0)
        .forEach((l) => broadcast(`[${tag}] ${l}`));
    });
    stream.on('error', () => { });
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
  header button, header input { font: inherit; color: #c9d1d9; background: #21262d;
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

  function connect() {
    const es = new EventSource('/stream' + (token ? '?token=' + encodeURIComponent(token) : ''));
    es.onopen = () => { statusEl.textContent = '● 已连接'; statusEl.className = 'ok'; };
    es.onmessage = (e) => append(e.data.replace(/\\\\n/g, '\\n'));
    es.onerror = () => { statusEl.textContent = '● 断开，重连中…'; statusEl.className = 'off'; };
  }
  connect();
</script>
</body>
</html>`;

function checkAuth(req) {
  if (!TOKEN) return true;
  const url = new URL(req.url, 'http://x');
  return url.searchParams.get('token') === TOKEN;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

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

FILES.forEach(watchFile);
server.listen(PORT, HOST, () => {
  console.log(`[log-server] http://${HOST}:${PORT}  tailing: ${FILES.join(', ')}`);
  if (!TOKEN) console.log('[log-server] 警告：未设置 LOG_TOKEN，任何人可访问，建议设置');
});
