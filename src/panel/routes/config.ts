import http from 'http';
import bot from '@/bot';
import { botConfig, updateBotConfig } from '@/config';
import messageStorage from '@/chat/storage/message';
import { printLog } from '@/utils/print';
import { readJsonBody, sendJson } from '../http';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function parseIdList(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const nums = v.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n <= 0)) return null;
  return [...new Set(nums)];
}

/** 只暴露面板可编辑的 AI 回复配置，不泄露 wsConfig / nonokaService / apiKeys */
function redactConfig() {
  const {
    enable, blackList, initiativeList, voiceList = [],
  } = botConfig.aiReply;
  return {
    botConfig: {
      aiReply: {
        enable,
        blackList,
        initiativeList,
        voiceList,
      },
    },
  };
}

/** 处理运行状态、AI 回复配置与会话缓存清理接口 */
export async function handleConfigRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname === '/api/status' && req.method === 'GET') {
    sendJson(res, 200, { ws: bot.getConnectingState() });
    return true;
  }

  if (url.pathname === '/api/config' && req.method === 'GET') {
    sendJson(res, 200, redactConfig());
    return true;
  }

  if (url.pathname === '/api/config' && req.method === 'POST') {
    const body = await readJsonBody(req, res);
    if (!body) return true;

    const bc = isPlainObject(body.botConfig) ? body.botConfig : null;
    const ar = bc && isPlainObject(bc.aiReply) ? bc.aiReply : null;
    if (!ar || typeof ar.enable !== 'boolean') {
      sendJson(res, 400, { error: 'invalid config shape' });
      return true;
    }

    const blackList = parseIdList(ar.blackList);
    const initiativeList = parseIdList(ar.initiativeList);
    const voiceList = parseIdList(ar.voiceList ?? []);
    if (!blackList || !initiativeList || !voiceList) {
      sendJson(res, 400, { error: '群号列表必须为正整数数组' });
      return true;
    }

    // 只覆写面板管理的字段，保留 config.json 里单独配置的 memory / imageGen / search
    updateBotConfig((current) => ({
      ...current,
      aiReply: {
        ...current.aiReply,
        enable: ar.enable as boolean,
        blackList,
        initiativeList,
        voiceList,
      },
    }));
    printLog('[AdminPanel] 配置已通过管理面板更新');
    sendJson(res, 200, { ok: true, ...redactConfig() });
    return true;
  }

  if (url.pathname === '/api/chat/clean' && req.method === 'POST') {
    messageStorage.cleanChatConversations();
    printLog('[AdminPanel] 已手动清理内存会话缓存');
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
