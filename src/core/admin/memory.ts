import http from 'http';
import { botConfig, saveConfigToDisk } from '@/core/nnkConfig';
import aliasIndex from '@/modules/aiReply/history/aliasIndex';
import { getConsolidationBacklog, listConsolidationRuns } from '@/modules/aiReply/memory/consolidate';
import { enqueueEmbedding } from '@/modules/aiReply/memory/embedQueue';
import memoryStore, { type MemoryKind, type MemoryPatch } from '@/modules/aiReply/memory/store';
import groupProfile from '@/modules/aiReply/storage/groupProfile';
import { printLog } from '@/utils/print';
import { readJsonBody, sendJson } from './http';

/**
 * 管理面板的记忆编辑页。
 *
 * 直接在数据库里改 memory 表是不行的：memory_fts 存的是 segment() 分词后的结果、
 * 向量存在 embedding 表，手改的条目召不回来。所以这里所有写入都走 MemoryStore，
 * 由它同步全文索引，向量交给 embedQueue 重排。
 */

const KINDS: MemoryKind[] = ['trait', 'episode', 'relation', 'alias'];

/** 一条记忆的文本上限。档案行是要塞进 prompt 的，太长会挤掉别人 */
const MAX_TEXT_LEN = 200;

/** 群环境描述整段注入 system，比单条记忆宽松些，但也不能没有边 */
const MAX_PROFILE_LEN = 500;

/** 主动插话概率的缩放上限。再往上就是刷屏了，手滑多打个 0 得挡住 */
const MAX_CHANCE_SCALE = 3;

const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nonoka 记忆管理</title>
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
  main { max-width: 1000px; margin: 0 auto; padding: 16px; }
  section { background: #161b22; border: 1px solid #30363d; border-radius: 8px;
            padding: 14px 16px; margin-bottom: 14px; }
  section h2 { margin: 0 0 10px; font-size: 15px; color: #58a6ff; }
  .row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
  .hint { color: #6e7681; font-size: 12px; }
  input[type=text], input[type=number], select, textarea {
    font: inherit; color: #c9d1d9; background: #0d1117; border: 1px solid #30363d;
    border-radius: 6px; padding: 6px 10px;
  }
  input[type=text] { flex: 1; min-width: 160px; }
  textarea { width: 100%; min-height: 76px; resize: vertical; }
  label.lbl { width: 92px; flex-shrink: 0; color: #8b949e; }
  input[type=checkbox] { width: 18px; height: 18px; }
  button { font: inherit; color: #c9d1d9; background: #21262d; border: 1px solid #30363d;
           border-radius: 6px; padding: 6px 14px; cursor: pointer; }
  button:hover { background: #30363d; }
  button.primary { background: #238636; border-color: #2ea043; color: #fff; }
  button.primary:hover { background: #2ea043; }
  button.danger { background: #21262d; border-color: #f85149; color: #f85149; }
  button.danger:hover { background: #da3633; color: #fff; }
  .users { display: flex; flex-wrap: wrap; gap: 8px; }
  .user { text-align: left; line-height: 1.4; }
  .user.on { border-color: #58a6ff; background: #1f6feb33; }
  .user small { display: block; color: #6e7681; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; min-width: 860px; }
  th { text-align: left; font-weight: normal; color: #6e7681; font-size: 12px; padding: 0 6px 6px; }
  td { padding: 4px 6px; vertical-align: middle; }
  td.id, td.meta, td.ops { white-space: nowrap; }
  td.id { color: #6e7681; }
  td.meta { color: #6e7681; font-size: 12px; }
  td.ops button { padding: 6px 10px; }
  tr.dirty td.id { color: #d29922; }
  .empty { color: #6e7681; padding: 8px 0; }
  tr.evidence-row td { padding: 0 6px 10px; }
  .evidence { max-height: 420px; overflow: auto; padding: 10px 12px; background: #0d1117;
              border: 1px solid #30363d; border-radius: 6px; }
  .evidence-batch + .evidence-batch { margin-top: 12px; padding-top: 12px; border-top: 1px solid #30363d; }
  .evidence-head { color: #8b949e; font-size: 12px; margin-bottom: 6px; }
  .evidence-message { display: grid; grid-template-columns: 110px 1fr; gap: 10px; padding: 4px 0; }
  .evidence-message .msg-id { color: #6e7681; font-size: 12px; white-space: nowrap; }
  .evidence-message .raw { white-space: pre-wrap; overflow-wrap: anywhere; }
  .backlog { font-size: 18px; color: #58a6ff; }
  .run-list { margin-top: 8px; }
  .run { display: grid; grid-template-columns: 150px 64px 1fr; gap: 10px; padding: 5px 0;
         border-top: 1px solid #21262d; }
  .run-time, .run-detail { color: #8b949e; font-size: 12px; }
  .run-status.success { color: #3fb950; }
  .run-status.failed { color: #f85149; }
  .run-status.running { color: #d29922; }
</style>
</head>
<body>
<header>
  <b>Nonoka</b> 记忆管理
  <span class="sp"></span>
  <span id="status"></span>
  <a id="backLink" href="#">← 配置面板</a>
</header>
<main>
  <section>
    <h2>群档案</h2>
    <div class="row">
      <label class="lbl">群</label>
      <select id="groupSel" style="flex:1"></select>
    </div>
    <div class="row">
      <label class="lbl">插话系数</label>
      <input type="number" id="chanceScale" step="0.1" min="0" max="3" style="width:90px">
      <span class="hint">1 为默认，0 表示完全不主动插话，上限 3</span>
    </div>
    <div class="row" style="align-items:flex-start">
      <label class="lbl">群环境描述</label>
      <textarea id="profileText" placeholder="这个群是什么氛围、聊什么、能不能放开玩笑。整段注入 system"></textarea>
    </div>
    <div class="row">
      <span class="sp" style="flex:1"></span>
      <span class="hint" id="groupMeta"></span>
      <button id="saveGroup" class="primary">保存群档案</button>
    </div>
  </section>

  <section>
    <div class="row">
      <h2 style="margin:0">Topic 巩固状态</h2>
      <span style="flex:1"></span>
      <button id="refreshConsolidation">刷新</button>
    </div>
    <div id="backlog" class="backlog">加载中…</div>
    <div id="backlogMeta" class="hint"></div>
    <div id="runList" class="run-list"></div>
  </section>

  <section>
    <h2>找人</h2>
    <div class="row">
      <input type="text" id="q" placeholder="QQ 号 / 昵称 / 别名，留空看档案最多的人">
      <button id="search" class="primary">搜索</button>
    </div>
    <div class="users" id="users"></div>
  </section>

  <section id="itemsSection" style="display:none">
    <div class="row">
      <h2 id="who" style="margin:0"></h2>
      <span style="flex:1"></span>
      <button id="toggleBlock" class="danger">加入记忆黑名单</button>
    </div>
    <div class="scroll">
      <table>
        <thead><tr>
          <th style="width:52px">id</th><th style="width:110px">类型</th><th>内容</th>
          <th style="width:80px">置信度</th><th style="width:52px">钉住</th>
          <th style="width:150px">印证 / 最近</th><th style="width:190px"></th>
        </tr></thead>
        <tbody id="items"></tbody>
      </table>
    </div>
    <div class="row" style="margin-top:12px">
      <select id="newKind"></select>
      <input type="text" id="newText" placeholder="新增一条，例如：千果的室友">
      <label class="hint">钉住 <input type="checkbox" id="newPinned" checked></label>
      <button id="add" class="primary">新增</button>
    </div>
    <div class="hint">
      钉住的条目 LLM 不会改也不会淘汰，人工写的建议都钉上。
      relation 排在印象之前注入，alias 决定别人叫这个外号时能不能认出他。
    </div>
  </section>

  <section>
    <div class="row">
      <h2 style="margin:0">记忆黑名单</h2>
      <span style="flex:1"></span>
      <input type="text" id="blockInput" placeholder="QQ 号" style="flex:0 0 160px;min-width:0">
      <button id="blockAdd" class="primary">加入</button>
    </div>
    <div class="hint" style="margin-bottom:10px">
      名单内的人不再抽取、更新记忆。已经存下的条目原样保留，照常注入和召回，
      要清干净得在上面逐条删。改完立刻生效，不用重启。
    </div>
    <div class="users" id="blocked"></div>
  </section>
</main>
<script>
  const token = new URLSearchParams(location.search).get('token') || '';
  const KINDS = ['trait', 'episode', 'relation', 'alias'];
  const KIND_LABEL = { trait: 'trait 印象', episode: 'episode 事件', relation: 'relation 关系', alias: 'alias 别名' };
  let currentUser = null;
  let blocked = new Set();

  document.getElementById('backLink').href = '/?token=' + encodeURIComponent(token);

  function api(pathname, opts) {
    const url = pathname + (pathname.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
    return fetch(url, opts).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      return data;
    });
  }

  function post(pathname, payload) {
    return api(pathname, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
  }

  function setStatus(text, ok) {
    const el = document.getElementById('status');
    el.textContent = text;
    el.className = ok ? 'ok' : 'err';
  }

  function fmtDate(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function fmtTime(ms) {
    return new Date(ms).toLocaleString('zh-CN', { hour12: false });
  }

  function renderEvidence(box, batches) {
    box.textContent = '';
    if (!batches.length) {
      box.className = 'empty';
      box.textContent = '暂无原话证据（旧记忆或管理员手动添加的记忆不会自动补证据）';
      return;
    }

    batches.forEach((batch) => {
      const wrap = document.createElement('div');
      wrap.className = 'evidence-batch';

      const head = document.createElement('div');
      head.className = 'evidence-head';
      const range = batch.observedFrom === batch.observedTo
        ? fmtTime(batch.observedFrom)
        : fmtTime(batch.observedFrom) + ' ～ ' + fmtTime(batch.observedTo);
      head.textContent = '证据批次 #' + batch.batchId + ' · ' + range
        + ' · 来源群 ' + (batch.groupIds.length ? batch.groupIds.join('、') : '未知');
      wrap.appendChild(head);

      batch.messages.forEach((message, i) => {
        const line = document.createElement('div');
        line.className = 'evidence-message';
        const id = document.createElement('span');
        id.className = 'msg-id';
        id.textContent = batch.messageIds[i] ? '消息 #' + batch.messageIds[i] : '消息 ID 未记录';
        const raw = document.createElement('span');
        raw.className = 'raw';
        raw.textContent = message;
        line.appendChild(id);
        line.appendChild(raw);
        wrap.appendChild(line);
      });
      box.appendChild(wrap);
    });
  }

  function toggleEvidence(it, tr, button) {
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('evidence-row') && next.dataset.memoryId === String(it.id)) {
      next.hidden = !next.hidden;
      button.textContent = next.hidden ? '原话' : '收起';
      return;
    }

    const evidenceRow = document.createElement('tr');
    evidenceRow.className = 'evidence-row';
    evidenceRow.dataset.memoryId = String(it.id);
    const td = document.createElement('td');
    td.colSpan = 7;
    const box = document.createElement('div');
    box.className = 'evidence';
    box.textContent = '加载原话中…';
    td.appendChild(box);
    evidenceRow.appendChild(td);
    tr.after(evidenceRow);
    button.textContent = '收起';

    api('/api/memory/evidence?id=' + it.id)
      .then((d) => renderEvidence(box, d.evidence))
      .catch((e) => {
        box.className = 'empty';
        box.textContent = '原话加载失败：' + e.message;
      });
  }

  function kindSelect(value) {
    const sel = document.createElement('select');
    KINDS.forEach((k) => {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = KIND_LABEL[k];
      sel.appendChild(opt);
    });
    sel.value = value || 'trait';
    return sel;
  }

  function renderUsers(list) {
    const box = document.getElementById('users');
    box.textContent = '';
    if (!list.length) {
      const p = document.createElement('div');
      p.className = 'empty';
      p.textContent = '没找到人';
      box.appendChild(p);
      return;
    }
    list.forEach((u) => {
      const btn = document.createElement('button');
      btn.className = 'user';
      btn.textContent = (u.nick || '(无昵称)') + ' · ' + u.count + ' 条';
      const small = document.createElement('small');
      small.textContent = u.userId + (u.aliases.length ? ' · ' + u.aliases.join('、') : '');
      btn.appendChild(small);
      btn.onclick = () => {
        box.querySelectorAll('.user').forEach((e) => e.classList.remove('on'));
        btn.classList.add('on');
        loadItems(u);
      };
      box.appendChild(btn);
    });
  }

  function renderItems(items) {
    const tbody = document.getElementById('items');
    tbody.textContent = '';
    if (!items.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.className = 'empty';
      td.textContent = '这个人还没有任何记忆条目';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    items.forEach((it) => {
      const tr = document.createElement('tr');
      const cell = (cls) => {
        const td = document.createElement('td');
        if (cls) td.className = cls;
        tr.appendChild(td);
        return td;
      };

      cell('id').textContent = '#' + it.id;

      const sel = kindSelect(it.kind);
      cell().appendChild(sel);

      const text = document.createElement('input');
      text.type = 'text';
      text.value = it.text;
      if (it.source) text.title = '来源：' + it.source;
      cell().appendChild(text);

      const conf = document.createElement('input');
      conf.type = 'number';
      conf.step = '0.05';
      conf.min = '0';
      conf.max = '1';
      conf.style.width = '72px';
      conf.value = it.confidence;
      cell().appendChild(conf);

      const pin = document.createElement('input');
      pin.type = 'checkbox';
      pin.checked = it.pinned;
      cell().appendChild(pin);

      const quarantined = (it.kind === 'alias' || it.kind === 'relation') && !it.verified && !it.pinned;
      cell('meta').textContent = quarantined ? '未确认，已隔离' : it.hits + ' 次 · ' + fmtDate(it.lastSeen);

      const ops = cell('ops');
      const evidence = document.createElement('button');
      evidence.textContent = '原话';
      evidence.onclick = () => toggleEvidence(it, tr, evidence);
      const save = document.createElement('button');
      save.textContent = quarantined ? '确认并保存' : '保存';
      save.onclick = () => {
        setStatus('保存中…', true);
        post('/api/memory/update', {
          id: it.id,
          kind: sel.value,
          text: text.value,
          confidence: Number(conf.value),
          pinned: pin.checked,
        }).then(() => { setStatus('#' + it.id + ' 已保存', true); reloadItems(); })
          .catch((e) => setStatus('保存失败: ' + e.message, false));
      };
      const del = document.createElement('button');
      del.textContent = '删除';
      del.className = 'danger';
      del.onclick = () => {
        if (!confirm('删除 #' + it.id + '「' + it.text + '」？')) return;
        post('/api/memory/delete', { id: it.id })
          .then(() => { setStatus('#' + it.id + ' 已删除', true); reloadItems(); })
          .catch((e) => setStatus('删除失败: ' + e.message, false));
      };
      ops.appendChild(evidence);
      ops.appendChild(document.createTextNode(' '));
      ops.appendChild(save);
      ops.appendChild(document.createTextNode(' '));
      ops.appendChild(del);

      [sel, text, conf, pin].forEach((el) => {
        el.addEventListener('input', () => tr.classList.add('dirty'));
      });

      tbody.appendChild(tr);
    });
  }

  function loadItems(user) {
    currentUser = user;
    document.getElementById('itemsSection').style.display = '';
    document.getElementById('who').textContent = (user.nick || '(无昵称)') + ' · ' + user.userId;
    syncBlockButton();
    reloadItems();
  }

  // 当前选中的人在不在黑名单里，决定按钮是「加入」还是「解除」
  function syncBlockButton() {
    if (!currentUser) return;
    const btn = document.getElementById('toggleBlock');
    const on = blocked.has(currentUser.userId);
    btn.textContent = on ? '解除记忆黑名单' : '加入记忆黑名单';
    btn.className = on ? '' : 'danger';
  }

  function renderBlocked(list) {
    blocked = new Set(list.map((u) => u.userId));
    const box = document.getElementById('blocked');
    box.textContent = '';

    if (!list.length) {
      const p = document.createElement('div');
      p.className = 'empty';
      p.textContent = '黑名单是空的，所有人的记忆都照常更新';
      box.appendChild(p);
    }

    list.forEach((u) => {
      const btn = document.createElement('button');
      btn.className = 'user';
      btn.title = '点一下移出黑名单';
      btn.textContent = (u.nick || '(无昵称)') + ' · 解除';
      const small = document.createElement('small');
      small.textContent = u.userId + ' · 保留 ' + u.count + ' 条记忆';
      btn.appendChild(small);
      btn.onclick = () => setBlocked(u.userId, false);
      box.appendChild(btn);
    });

    syncBlockButton();
  }

  function setBlocked(userId, on) {
    setStatus('保存中…', true);
    post('/api/memory/blacklist', { userId: userId, blocked: on }).then((d) => {
      renderBlocked(d.users);
      setStatus(userId + (on ? ' 已加入黑名单，之后不再更新他的记忆' : ' 已移出黑名单'), true);
    }).catch((e) => setStatus('保存失败: ' + e.message, false));
  }

  function loadBlacklist() {
    api('/api/memory/blacklist')
      .then((d) => renderBlocked(d.users))
      .catch((e) => setStatus('黑名单加载失败: ' + e.message, false));
  }

  function addBlocked() {
    const input = document.getElementById('blockInput');
    const userId = Number(input.value.trim());
    if (!Number.isInteger(userId) || userId <= 0) {
      setStatus('QQ 号得是正整数', false);
      return;
    }
    input.value = '';
    setBlocked(userId, true);
  }

  function reloadItems() {
    if (!currentUser) return;
    api('/api/memory/items?userId=' + currentUser.userId)
      .then((d) => renderItems(d.items))
      .catch((e) => setStatus('加载失败: ' + e.message, false));
  }

  function search() {
    setStatus('搜索中…', true);
    api('/api/memory/users?q=' + encodeURIComponent(document.getElementById('q').value))
      .then((d) => { renderUsers(d.users); setStatus('找到 ' + d.users.length + ' 人', true); })
      .catch((e) => setStatus('搜索失败: ' + e.message, false));
  }

  function fmtDateKey(key) {
    if (!key) return '无';
    const s = String(key);
    return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  }

  function loadConsolidation() {
    const backlog = document.getElementById('backlog');
    const meta = document.getElementById('backlogMeta');
    const list = document.getElementById('runList');
    backlog.textContent = '加载中…';
    meta.textContent = '';
    list.textContent = '';

    api('/api/memory/consolidation').then((data) => {
      const b = data.backlog;
      backlog.textContent = b.days + ' 天 / ' + b.chunks + ' 段 / 约 ' + b.lines + ' 行待处理';
      meta.textContent = b.oldestDate ? '最早积压：' + fmtDateKey(b.oldestDate) : '当前没有 Topic 积压';

      if (!data.runs.length) {
        list.className = 'empty';
        list.textContent = '还没有定时巩固运行记录';
        return;
      }
      list.className = 'run-list';
      data.runs.forEach((run) => {
        const row = document.createElement('div');
        row.className = 'run';
        const time = document.createElement('span');
        time.className = 'run-time';
        time.textContent = fmtTime(run.startedAt);
        const status = document.createElement('span');
        status.className = 'run-status ' + run.status;
        status.textContent = run.status === 'success' ? '成功' : run.status === 'failed' ? '失败' : '运行中';
        const detail = document.createElement('span');
        detail.className = 'run-detail';
        const after = run.pendingChunksAfter === null ? '?' : run.pendingChunksAfter;
        detail.textContent = '积压 ' + run.pendingChunksBefore + ' → ' + after + ' 段'
          + ' · 处理 ' + run.processedDays + ' 天 / ' + run.topics + ' Topic'
          + ' · 向量 ' + run.embedded + ' · 淘汰 ' + run.evicted
          + (run.error ? ' · ' + run.error : '');
        row.appendChild(time);
        row.appendChild(status);
        row.appendChild(detail);
        list.appendChild(row);
      });
    }).catch((e) => {
      backlog.textContent = '巩固状态加载失败';
      meta.textContent = e.message;
    });
  }

  let groups = [];

  function fillGroup() {
    const g = groups[document.getElementById('groupSel').selectedIndex];
    if (!g) return;
    document.getElementById('chanceScale').value = g.chanceScale;
    document.getElementById('profileText').value = g.profileText;
    document.getElementById('groupMeta').textContent = g.updatedAt
      ? '上次修改 ' + fmtDate(g.updatedAt)
      : '还没有档案文件';
  }

  function loadGroups() {
    const sel = document.getElementById('groupSel');
    // 保存后要重新拉一遍列表，这里记住选的是哪个群，否则会被打回第一项
    const keep = groups[sel.selectedIndex] && groups[sel.selectedIndex].groupId;

    api('/api/memory/groups').then((d) => {
      groups = d.groups;
      sel.textContent = '';
      groups.forEach((g) => {
        const opt = document.createElement('option');
        opt.textContent = g.groupId + (g.updatedAt ? ' · 有档案' : ' · 无档案')
          + (g.lines ? ' · ' + g.lines + ' 条记录' : '');
        sel.appendChild(opt);
      });
      const at = groups.findIndex((g) => g.groupId === keep);
      if (at >= 0) sel.selectedIndex = at;
      fillGroup();
    }).catch((e) => setStatus('群档案加载失败: ' + e.message, false));
  }

  document.getElementById('groupSel').onchange = fillGroup;
  document.getElementById('refreshConsolidation').onclick = loadConsolidation;
  document.getElementById('saveGroup').onclick = () => {
    const g = groups[document.getElementById('groupSel').selectedIndex];
    if (!g) return;
    setStatus('保存中…', true);
    post('/api/memory/group', {
      groupId: g.groupId,
      chanceScale: Number(document.getElementById('chanceScale').value),
      profileText: document.getElementById('profileText').value,
    }).then(() => { setStatus(g.groupId + ' 档案已保存', true); loadGroups(); })
      .catch((e) => setStatus('保存失败: ' + e.message, false));
  };

  document.getElementById('newKind').replaceWith(Object.assign(kindSelect('trait'), { id: 'newKind' }));
  document.getElementById('search').onclick = search;
  document.getElementById('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });

  document.getElementById('add').onclick = () => {
    const text = document.getElementById('newText');
    if (!text.value.trim() || !currentUser) return;
    post('/api/memory/add', {
      userId: currentUser.userId,
      kind: document.getElementById('newKind').value,
      text: text.value,
      pinned: document.getElementById('newPinned').checked,
    }).then((d) => {
      text.value = '';
      setStatus(d.aliasPending ? '已新增，但这人没在日志里出现过，别名要等重启才生效' : '已新增', true);
      reloadItems();
    }).catch((e) => setStatus('新增失败: ' + e.message, false));
  };

  document.getElementById('toggleBlock').onclick = () => {
    if (currentUser) setBlocked(currentUser.userId, !blocked.has(currentUser.userId));
  };
  document.getElementById('blockAdd').onclick = addBlocked;
  document.getElementById('blockInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addBlocked(); });

  loadConsolidation();
  loadGroups();
  loadBlacklist();
  search();
</script>
</body>
</html>`;

function parseKind(v: unknown): MemoryKind | null {
  return typeof v === 'string' && (KINDS as string[]).includes(v) ? v as MemoryKind : null;
}

function parseText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const text = v.trim();
  return text && text.length <= MAX_TEXT_LEN ? text : null;
}

/** 缺省或非法一律回落到 0.9：人工写的条目本来就该比 LLM 抽的更可信 */
function parseConfidence(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.9;
}

function parseId(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 有聊天记录的群 + 已经写过档案的群，并起来给面板。
 * 只列前者会漏掉刚建档还没说过话的群，只列后者就没法给新群建档
 */
function listGroupProfiles() {
  const known = memoryStore.listGroups();
  const profiled = new Map(groupProfile.listProfiles().map((p) => [p.groupId, p]));

  const rows = known.map((g) => ({
    ...g,
    ...(profiled.get(g.groupId) ?? { chanceScale: 1, profileText: '', updatedAt: 0 }),
  }));

  profiled.forEach((p, groupId) => {
    if (!known.some((g) => g.groupId === groupId)) rows.push({ ...p, lines: 0, lastDate: 0 });
  });

  return rows;
}

/**
 * 记忆黑名单的读写。抽取侧每条消息现读 botConfig，所以改完这里立刻生效；
 * 同时落盘，重启后还在
 */
function saveBlackUserIds(ids: number[]) {
  // memory 整块在 config.json 里可以省略，第一次拉黑时按需补出来，别把 toolRounds 冲掉
  botConfig.aiReply.memory = { ...botConfig.aiReply.memory, blackUserIds: ids };
  saveConfigToDisk();
}

/** 黑名单成员，带昵称和还留着多少条记忆，给面板显示 */
function listBlacklist() {
  return (botConfig.aiReply.memory?.blackUserIds ?? []).map((userId) => ({
    userId,
    nick: memoryStore.getNickName(userId, null),
    count: memoryStore.listUserMemories(userId).length,
  }));
}

/** alias 立刻并进昵称索引，返回 false 表示这人还没在日志里露过面，只能等重启 */
function syncAlias(kind: MemoryKind, userId: number, text: string): boolean {
  aliasIndex.invalidate();
  return kind !== 'alias' || aliasIndex.noteManualAlias(userId, text);
}

/** 处理记忆页和它的接口，鉴权由调用方做完。返回是否命中路由 */
export async function handleMemoryRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname === '/memory' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return true;
  }

  if (url.pathname === '/api/memory/users' && req.method === 'GET') {
    sendJson(res, 200, { users: memoryStore.searchUsers(url.searchParams.get('q') ?? '') });
    return true;
  }

  if (url.pathname === '/api/memory/groups' && req.method === 'GET') {
    sendJson(res, 200, { groups: listGroupProfiles() });
    return true;
  }

  if (url.pathname === '/api/memory/group' && req.method === 'POST') {
    const body = await readJsonBody(req, res);
    if (!body) return true;

    const groupId = parseId(body.groupId);
    const scale = Number(body.chanceScale);
    const text = typeof body.profileText === 'string' ? body.profileText.trim() : null;
    if (!groupId || !Number.isFinite(scale) || scale < 0 || scale > MAX_CHANCE_SCALE || text === null) {
      sendJson(res, 400, { error: `群号非法，或插话系数不在 0~${MAX_CHANCE_SCALE}` });
      return true;
    }
    if (text.length > MAX_PROFILE_LEN) {
      sendJson(res, 400, { error: `群环境描述最多 ${MAX_PROFILE_LEN} 字` });
      return true;
    }

    // 写完就生效：getProfile 按 mtime 判缓存，不用重启也不用通知 bot
    sendJson(res, 200, { profile: groupProfile.saveProfile(groupId, scale, text) });
    printLog(`[AdminPanel] 群 ${groupId} 档案已更新`);
    return true;
  }

  if (url.pathname === '/api/memory/items' && req.method === 'GET') {
    const userId = parseId(url.searchParams.get('userId'));
    if (!userId) sendJson(res, 400, { error: 'invalid userId' });
    else sendJson(res, 200, { items: memoryStore.listUserMemories(userId) });
    return true;
  }

  if (url.pathname === '/api/memory/consolidation' && req.method === 'GET') {
    sendJson(res, 200, {
      backlog: getConsolidationBacklog(botConfig.aiReply.initiativeList),
      runs: listConsolidationRuns(),
    });
    return true;
  }

  if (url.pathname === '/api/memory/blacklist' && req.method === 'GET') {
    sendJson(res, 200, { users: listBlacklist() });
    return true;
  }

  if (url.pathname === '/api/memory/blacklist' && req.method === 'POST') {
    const body = await readJsonBody(req, res);
    if (!body) return true;

    const userId = parseId(body.userId);
    if (!userId) {
      sendJson(res, 400, { error: 'QQ 号非法' });
      return true;
    }

    // 用 Set 去重，排序后再写，免得 config.json 每存一次顺序都变、diff 没法看
    const ids = new Set(botConfig.aiReply.memory?.blackUserIds ?? []);
    const blocked = body.blocked !== false;
    if (blocked) ids.add(userId);
    else ids.delete(userId);
    saveBlackUserIds([...ids].sort((a, b) => a - b));

    // 抽取侧攒着的消息不用在这里清：下一条消息进 onMessage 就会连缓冲区一起丢掉，
    // 已经在路上的那批也会在写库前再查一次黑名单
    printLog(`[AdminPanel] ${blocked ? '拉黑' : '解除'}记忆黑名单：${userId}`);
    sendJson(res, 200, { users: listBlacklist() });
    return true;
  }

  if (url.pathname === '/api/memory/evidence' && req.method === 'GET') {
    const id = parseId(url.searchParams.get('id'));
    if (!id) sendJson(res, 400, { error: 'invalid memory id' });
    else if (!memoryStore.getMemory(id)) sendJson(res, 404, { error: '记忆不存在或已删除' });
    else sendJson(res, 200, { evidence: memoryStore.listMemoryEvidence(id) });
    return true;
  }

  if (url.pathname === '/api/memory/add' && req.method === 'POST') {
    const body = await readJsonBody(req, res);
    if (!body) return true;

    const userId = parseId(body.userId);
    const kind = parseKind(body.kind);
    const text = parseText(body.text);
    if (!userId || !kind || !text) {
      sendJson(res, 400, { error: `userId / kind 非法，或内容为空、超过 ${MAX_TEXT_LEN} 字` });
      return true;
    }

    const id = memoryStore.addMemory({
      ownerId: userId,
      kind,
      text,
      confidence: parseConfidence(body.confidence),
      pinned: body.pinned !== false,
      source: '管理面板',
    });
    enqueueEmbedding([id]);
    printLog(`[AdminPanel] 新增记忆 #${id}（${userId} / ${kind}）：${text}`);

    sendJson(res, 200, { id, aliasPending: !syncAlias(kind, userId, text) });
    return true;
  }

  if (url.pathname === '/api/memory/update' && req.method === 'POST') {
    const body = await readJsonBody(req, res);
    if (!body) return true;

    const id = parseId(body.id);
    const kind = parseKind(body.kind);
    const text = parseText(body.text);
    if (!id || !kind || !text) {
      sendJson(res, 400, { error: `id / kind 非法，或内容为空、超过 ${MAX_TEXT_LEN} 字` });
      return true;
    }

    const patch: MemoryPatch = {
      kind, text, confidence: parseConfidence(body.confidence), pinned: body.pinned === true,
    };
    const { ok, textChanged } = memoryStore.updateMemory(id, patch);
    if (!ok) {
      sendJson(res, 404, { error: '条目不存在或已被删除' });
      return true;
    }

    if (textChanged) enqueueEmbedding([id]);
    const item = memoryStore.getMemory(id);
    printLog(`[AdminPanel] 修改记忆 #${id}：${text}`);

    sendJson(res, 200, { ok: true, aliasPending: !item || !syncAlias(kind, item.ownerId, text) });
    return true;
  }

  if (url.pathname === '/api/memory/delete' && req.method === 'POST') {
    const body = await readJsonBody(req, res);
    if (!body) return true;

    const id = parseId(body.id);
    if (!id) {
      sendJson(res, 400, { error: 'invalid id' });
      return true;
    }

    if (!memoryStore.removeMemory(id)) sendJson(res, 404, { error: '条目不存在或已被删除' });
    else {
      aliasIndex.invalidate();
      printLog(`[AdminPanel] 删除记忆 #${id}`);
      sendJson(res, 200, { ok: true });
    }
    return true;
  }

  return false;
}
