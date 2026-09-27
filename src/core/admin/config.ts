import fs from 'fs';
import http from 'http';
import path from 'path';
import { printLog } from '@/utils/print';
import { BotConfig, NonokaConfig } from '@/types/config';
import { NonokaCore } from '../nnkCore';
import { readBody } from './http';

const CONFIG_PATH = path.resolve('config.json');

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 校验管理面板提交的配置结构，避免把 config.json 写坏 */
function validateConfig(v: unknown): v is NonokaConfig {
  if (!isPlainObject(v)) return false;
  const { wsConfig, botConfig } = v as Record<string, unknown>;
  if (!isPlainObject(wsConfig) || typeof wsConfig.host !== 'string' || typeof wsConfig.port !== 'number') return false;
  if (!isPlainObject(botConfig)) return false;
  const requiredKeys = [
    'admin', 'autoAddFriend', 'nonokaService', 'apiKeys', 'repeater',
    'biliDynamicPush', 'tweetPush', 'ytLivePush', 'aiReply', 'hPic',
  ];
  return requiredKeys.every((k) => k in botConfig);
}

function readConfigFile(): NonokaConfig {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

/**
 * wsConfig（WebSocket 连接地址/端口）、nonokaService（服务地址/密钥）与 apiKeys（第三方密钥）
 * 不允许通过管理面板读取或修改，仅能直接编辑 config.json
 */
function redactConfig(config: NonokaConfig) {
  const { nonokaService, apiKeys, ...restBotConfig } = config.botConfig;
  return { botConfig: restBotConfig };
}

function writeConfigFile(config: NonokaConfig) {
  const tmpPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, CONFIG_PATH);
}

const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nonoka 管理面板</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.6 ui-monospace, Consolas, Menlo, monospace;
         background: #0d1117; color: #c9d1d9; }
  header { position: sticky; top: 0; z-index: 10; display: flex; gap: 12px; align-items: center;
           padding: 12px 16px; background: #161b22; border-bottom: 1px solid #30363d; }
  header b { color: #58a6ff; }
  header .sp { flex: 1; }
  header a { color: #8b949e; text-decoration: none; }
  header a:hover { color: #58a6ff; }
  #status { font-size: 13px; }
  #status.ok { color: #3fb950; }
  #status.err { color: #f85149; }
  main { max-width: 860px; margin: 0 auto; padding: 16px; }
  section { background: #161b22; border: 1px solid #30363d; border-radius: 8px;
            padding: 14px 16px; margin-bottom: 14px; }
  section h2 { margin: 0 0 10px; font-size: 15px; color: #58a6ff; }
  .row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
  .row label { width: 160px; flex-shrink: 0; color: #8b949e; }
  .row .hint { color: #6e7681; font-size: 12px; }
  input[type=text], input[type=password], input[type=number], textarea {
    font: inherit; color: #c9d1d9; background: #0d1117; border: 1px solid #30363d;
    border-radius: 6px; padding: 6px 10px; flex: 1; min-width: 200px;
  }
  textarea { min-height: 60px; width: 100%; resize: vertical; }
  input[type=checkbox] { width: 18px; height: 18px; }
  button { font: inherit; color: #c9d1d9; background: #21262d; border: 1px solid #30363d;
           border-radius: 6px; padding: 6px 14px; cursor: pointer; }
  button:hover { background: #30363d; }
  button.primary { background: #238636; border-color: #2ea043; color: #fff; }
  button.primary:hover { background: #2ea043; }
  button.danger { background: #da3633; border-color: #f85149; color: #fff; }
  table { width: 100%; border-collapse: collapse; }
  table td { padding: 4px 4px; }
  table td.op { width: 40px; }
  details summary { cursor: pointer; color: #8b949e; margin-bottom: 8px; }
  .eye { cursor: pointer; user-select: none; }
</style>
</head>
<body>
<header>
  <b>Nonoka</b> 管理面板
  <span class="sp"></span>
  <span id="status"></span>
  <a id="memoryLink" href="#">记忆管理 →</a>
  <button id="reload">刷新</button>
  <button id="save" class="primary">保存并生效</button>
</header>
<main>
  <section>
    <h2>基础设置</h2>
    <div class="row"><label>管理员 QQ</label><input type="text" id="admin" placeholder="用逗号分隔，例如 123,456"></div>
    <div class="row"><label>自动同意加好友</label><input type="checkbox" id="autoAddFriend"></div>
    <div class="row"><span class="hint">Nonoka 服务地址 / 密钥不通过本面板读取或修改，请直接编辑 config.json</span></div>
  </section>

  <section>
    <h2>复读机</h2>
    <div class="row"><label>启用</label><input type="checkbox" id="repeaterEnable"></div>
    <div class="row"><label>黑名单群号</label><input type="text" id="repeaterBlackList" placeholder="用逗号分隔"></div>
  </section>

  <section>
    <h2>B 站动态推送</h2>
    <div class="row"><label>启用</label><input type="checkbox" id="biliEnable"></div>
    <div class="row"><label>Cookie</label><textarea id="biliCookie"></textarea></div>
    <div class="row"><label style="align-self:flex-start">推送配置</label>
      <div style="flex:1">
        <table id="biliConfigTable"></table>
        <button type="button" id="biliConfigAdd">+ 添加 UID</button>
        <div class="hint">左：B站 UID，右：要推送的群号（逗号分隔）</div>
      </div>
    </div>
  </section>

  <section>
    <h2>推特推送</h2>
    <div class="row"><label>启用</label><input type="checkbox" id="tweetEnable"></div>
    <div class="row"><label style="align-self:flex-start">推送配置</label>
      <div style="flex:1">
        <table id="tweetConfigTable"></table>
        <button type="button" id="tweetConfigAdd">+ 添加用户名</button>
        <div class="hint">左：推特用户名，右：要推送的群号（逗号分隔）</div>
      </div>
    </div>
  </section>

  <section>
    <h2>YouTube 开播推送</h2>
    <div class="row"><label>启用</label><input type="checkbox" id="ytEnable"></div>
    <div class="row"><label style="align-self:flex-start">推送配置</label>
      <div style="flex:1">
        <table id="ytConfigTable"></table>
        <button type="button" id="ytConfigAdd">+ 添加频道 ID</button>
        <div class="hint">左：YouTube 频道 ID（形如 UCxxxxxxxx），右：要推送的群号（逗号分隔）</div>
      </div>
    </div>
  </section>

  <section>
    <h2>AI 回复</h2>
    <div class="row"><label>启用</label><input type="checkbox" id="aiEnable"></div>
    <div class="row"><label>黑名单群号</label><input type="text" id="aiBlackList" placeholder="用逗号分隔"></div>
    <div class="row"><label>主动发言群号</label><input type="text" id="aiInitiativeList" placeholder="用逗号分隔"></div>
  </section>

  <section>
    <h2>瑟图功能</h2>
    <div class="row"><label>启用</label><input type="checkbox" id="hPicEnable"></div>
    <div class="row"><label>白名单群号</label><input type="text" id="hPicWhiteList" placeholder="用逗号分隔，留空则不限制"></div>
    <div class="row"><label>允许 R18</label><input type="checkbox" id="hPicR18"></div>
  </section>

  <section>
    <span class="hint">WebSocket 连接设置（host / port）不通过本面板读取或修改，请直接编辑 config.json</span>
  </section>
</main>
<script>
  const token = new URLSearchParams(location.search).get('token') || '';
  document.getElementById('memoryLink').href = '/memory?token=' + encodeURIComponent(token);

  function api(pathname, opts) {
    const url = pathname + (pathname.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
    return fetch(url, opts).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      return data;
    });
  }

  function setStatus(text, ok) {
    const el = document.getElementById('status');
    el.textContent = text;
    el.className = ok ? 'ok' : 'err';
  }

  function parseNumList(text) {
    return (text || '').split(/[,，\\s]+/).map((s) => s.trim()).filter(Boolean)
      .map(Number).filter((n) => !Number.isNaN(n));
  }

  function buildMapTable(tableEl, map) {
    tableEl.innerHTML = '';
    Object.entries(map || {}).forEach(([key, groups]) => addMapRow(tableEl, key, (groups || []).join(',')));
  }

  function addMapRow(tableEl, key, groupsText) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td><input type="text" class="mkey" value="' + (key || '').replace(/"/g, '&quot;') + '" placeholder="key"></td>' +
      '<td><input type="text" class="mval" value="' + (groupsText || '').replace(/"/g, '&quot;') + '" placeholder="群号，逗号分隔"></td>' +
      '<td class="op"><button type="button" class="rm">✕</button></td>';
    tr.querySelector('.rm').onclick = () => tr.remove();
    tableEl.appendChild(tr);
  }

  function readMapTable(tableEl) {
    const result = {};
    tableEl.querySelectorAll('tr').forEach((tr) => {
      const key = tr.querySelector('.mkey').value.trim();
      if (!key) return;
      result[key] = parseNumList(tr.querySelector('.mval').value);
    });
    return result;
  }

  let current = null;

  function fill(cfg) {
    current = cfg;
    const bc = cfg.botConfig;
    document.getElementById('admin').value = (bc.admin || []).join(',');
    document.getElementById('autoAddFriend').checked = !!bc.autoAddFriend;

    document.getElementById('repeaterEnable').checked = !!bc.repeater.enable;
    document.getElementById('repeaterBlackList').value = (bc.repeater.blackList || []).join(',');

    document.getElementById('biliEnable').checked = !!bc.biliDynamicPush.enable;
    document.getElementById('biliCookie').value = bc.biliDynamicPush.cookie || '';
    buildMapTable(document.getElementById('biliConfigTable'), bc.biliDynamicPush.config);

    document.getElementById('tweetEnable').checked = !!bc.tweetPush.enable;
    buildMapTable(document.getElementById('tweetConfigTable'), bc.tweetPush.config);

    document.getElementById('ytEnable').checked = !!bc.ytLivePush.enable;
    buildMapTable(document.getElementById('ytConfigTable'), bc.ytLivePush.config);

    document.getElementById('aiEnable').checked = !!bc.aiReply.enable;
    document.getElementById('aiBlackList').value = (bc.aiReply.blackList || []).join(',');
    document.getElementById('aiInitiativeList').value = (bc.aiReply.initiativeList || []).join(',');

    document.getElementById('hPicEnable').checked = !!bc.hPic.enable;
    document.getElementById('hPicWhiteList').value = (bc.hPic.whiteGroupIds || []).join(',');
    document.getElementById('hPicR18').checked = !!bc.hPic.enableR18;
  }

  function collect() {
    return {
      botConfig: {
        admin: parseNumList(document.getElementById('admin').value),
        autoAddFriend: document.getElementById('autoAddFriend').checked,
        repeater: {
          enable: document.getElementById('repeaterEnable').checked,
          blackList: parseNumList(document.getElementById('repeaterBlackList').value),
        },
        biliDynamicPush: {
          enable: document.getElementById('biliEnable').checked,
          config: readMapTable(document.getElementById('biliConfigTable')),
          cookie: document.getElementById('biliCookie').value,
        },
        tweetPush: {
          enable: document.getElementById('tweetEnable').checked,
          config: readMapTable(document.getElementById('tweetConfigTable')),
        },
        ytLivePush: {
          enable: document.getElementById('ytEnable').checked,
          config: readMapTable(document.getElementById('ytConfigTable')),
        },
        aiReply: {
          enable: document.getElementById('aiEnable').checked,
          blackList: parseNumList(document.getElementById('aiBlackList').value),
          initiativeList: parseNumList(document.getElementById('aiInitiativeList').value),
        },
        hPic: {
          enable: document.getElementById('hPicEnable').checked,
          whiteGroupIds: parseNumList(document.getElementById('hPicWhiteList').value),
          enableR18: document.getElementById('hPicR18').checked,
        },
      },
    };
  }

  document.getElementById('biliConfigAdd').onclick = () => addMapRow(document.getElementById('biliConfigTable'), '', '');
  document.getElementById('tweetConfigAdd').onclick = () => addMapRow(document.getElementById('tweetConfigTable'), '', '');
  document.getElementById('ytConfigAdd').onclick = () => addMapRow(document.getElementById('ytConfigTable'), '', '');

  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('eye')) {
      const input = document.getElementById(e.target.dataset.for);
      input.type = input.type === 'password' ? 'text' : 'password';
    }
  });

  function load() {
    setStatus('加载中…', true);
    api('/api/config').then((cfg) => { fill(cfg); setStatus('已加载', true); })
      .catch((e) => setStatus('加载失败: ' + e.message, false));
  }

  document.getElementById('reload').onclick = load;
  document.getElementById('save').onclick = () => {
    setStatus('保存中…', true);
    api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collect()) })
      .then(() => setStatus('已保存并生效', true))
      .catch((e) => setStatus('保存失败: ' + e.message, false));
  };

  load();
</script>
</body>
</html>`;

/** 处理配置页和它的接口，鉴权由调用方做完。返回是否命中路由 */
export async function handleConfigRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  bot: NonokaCore,
): Promise<boolean> {
  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return true;
  }

  if (url.pathname === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(redactConfig(readConfigFile())));
    return true;
  }

  if (url.pathname === '/api/config' && req.method === 'POST') {
    let body: string;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'body too large' }));
      return true;
    }

    let submitted: unknown;
    try {
      submitted = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid json' }));
      return true;
    }

    if (!isPlainObject(submitted) || !isPlainObject(submitted.botConfig)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid config shape' }));
      return true;
    }

    // wsConfig、nonokaService 与 apiKeys 不允许通过管理面板读取或修改，无论提交了什么，都强制沿用磁盘上的现有值；
    // 先展开 existing.botConfig，保留面板未管理的配置节，避免保存时被丢弃
    const existing = readConfigFile();
    const submittedBotConfig = submitted.botConfig as Partial<BotConfig>;
    const parsed = {
      ...submitted,
      wsConfig: existing.wsConfig,
      botConfig: {
        ...existing.botConfig,
        ...submittedBotConfig,
        // aiReply 还得再合一层：面板只管 enable/黑名单/主动列表，
        // 直接覆盖会把只在 config.json 里配的 memory、imageGen、search 整块抹掉
        aiReply: { ...existing.botConfig.aiReply, ...submittedBotConfig.aiReply },
        nonokaService: existing.botConfig.nonokaService,
        apiKeys: existing.botConfig.apiKeys,
      },
    };

    if (!validateConfig(parsed)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid config shape' }));
      return true;
    }

    writeConfigFile(parsed);
    Object.assign(bot.config, parsed.botConfig);
    printLog('[AdminPanel] 配置已通过管理面板更新');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  return false;
}
