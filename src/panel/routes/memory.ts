import http from 'http';
import { botConfig, updateBotConfig } from '@/config';
import aliasIndex from '@/memory/identity/aliasIndex';
import { getConsolidationBacklog, listConsolidationRuns } from '@/memory/consolidate';
import { enqueueEmbedding } from '@/memory/embedQueue';
import memoryStore, { type MemoryKind, type MemoryPatch } from '@/memory/store';
import groupProfile from '@/chat/storage/groupProfile';
import { printLog } from '@/utils/print';
import { readJsonBody, sendJson } from '../http';

const KINDS: MemoryKind[] = ['trait', 'episode', 'relation', 'alias'];

/** 一条记忆的文本上限 */
const MAX_TEXT_LEN = 200;

/** 群环境描述上限 */
const MAX_PROFILE_LEN = 500;

/** 主动插话概率的缩放上限 */
const MAX_CHANCE_SCALE = 3;

function parseKind(v: unknown): MemoryKind | null {
  return typeof v === 'string' && (KINDS as string[]).includes(v) ? v as MemoryKind : null;
}

function parseText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const text = v.trim();
  return text && text.length <= MAX_TEXT_LEN ? text : null;
}

/** 缺省或非法一律回落到 0.9：人工写的条目应比 LLM 抽的更可信 */
function parseConfidence(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.9;
}

function parseId(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 合并有聊天记录的群和已有档案的群，方便给新群建档 */
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

/** 记忆黑名单写入：统一经 updateBotConfig 落盘并热生效 */
function saveBlackUserIds(ids: number[]) {
  updateBotConfig((current) => ({
    ...current,
    aiReply: {
      ...current.aiReply,
      memory: { ...current.aiReply.memory, blackUserIds: ids },
    },
  }));
}

function listBlacklist() {
  return (botConfig.aiReply.memory?.blackUserIds ?? []).map((userId) => ({
    userId,
    nick: memoryStore.getNickName(userId, null),
    count: memoryStore.listUserMemories(userId).length,
  }));
}

/** alias 立刻并进昵称索引，返回 false 表示这人还没在日志里露过面，需等重启 */
function syncAlias(kind: MemoryKind, userId: number, text: string): boolean {
  aliasIndex.invalidate();
  return kind !== 'alias' || aliasIndex.noteManualAlias(userId, text);
}

/** 处理记忆与群档案接口，鉴权由调用方完成 */
export async function handleMemoryRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
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
      backlog: getConsolidationBacklog(),
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

    const ids = new Set(botConfig.aiReply.memory?.blackUserIds ?? []);
    const blocked = body.blocked !== false;
    if (blocked) ids.add(userId);
    else ids.delete(userId);
    saveBlackUserIds([...ids].sort((a, b) => a - b));

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
