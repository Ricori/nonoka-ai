import { printLog } from '@/utils/print';
import type { ToolDef } from '@/service/llm';
import aliasIndex from '../history/aliasIndex';
import { recallChat, recallMemory } from './retrieve';
import memoryStore from './store';
import { HISTORY_DAYS } from './policy';

/**
 * 给模型用的召回工具。
 *
 * 参数收的是**名字**不是 QQ 号——模型不知道 userId，但知道群友昵称，
 * 由 `aliasIndex.resolve()` 把名字解析成 userId，直接复用已经调好的认人逻辑
 */

/** 一次工具调用最多返回几条，多了会把上下文撑爆 */
const TOOL_LIMIT = 5;

/** 名字解析不出人时的兜底文案，得让模型知道是没认出人而不是没记录 */
const UNKNOWN_NAME = (name: string) => `没有找到叫「${name}」的群友，可能是名字记错了。`;

/**
 * 单条召回结果的长度上限。群友粘的长公告是一条消息，
 * 整段塞回去会把上下文吃光，截断到够判断相关性即可
 */
const MAX_HIT_CHARS = 120;

function truncate(text: string): string {
  return text.length > MAX_HIT_CHARS ? `${text.slice(0, MAX_HIT_CHARS)}…` : text;
}

export const MEMORY_TOOLS: ToolDef[] = [
  {
    name: 'recall_memory',
    description: '查你对群友的长期印象和档案（他是谁、在做什么、喜欢什么、和你什么关系）。'
      + '当话题涉及某个群友本人、或者有人问「XX是谁」「XX怎么样了」时用。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查什么，用自然语言描述，例如「专业和学校」「喜欢的游戏」' },
        about: { type: 'string', description: '要查哪位群友的档案，填群里对他的称呼。不填就在所有人里找' },
        overview: { type: 'boolean', description: '仅在需要整体人物介绍时设 true；查询学校、工作等具体事实时不要开启' },
      },
      required: ['query'],
    },
  },
  {
    name: 'recall_chat',
    description: '翻群里以前说过的话。当话题让你想确认「这事之前是不是聊过」「谁提过这个」，'
      + '或者有人提到过去的事而你需要具体内容时用。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要找什么内容，用自然语言描述，例如「上次说的那家拉面店」' },
        speaker: { type: 'string', description: '限定是谁说的，填群里对他的称呼。不填就查所有人' },
        days: { type: 'number', description: '往前翻多少天，默认及上限均为 45。更早的原文已归档，不保证记得' },
      },
      required: ['query'],
    },
  },
];

/** 名字 -> userId。认不出返回空数组 */
function resolveName(groupId: number, name: string): number[] {
  return aliasIndex.resolve(groupId, name, true);
}

function formatChat(hits: Awaited<ReturnType<typeof recallChat>>): string {
  if (hits.length === 0) return '没有找到相关的历史记录。';
  // 带上日期和说话人，让模型知道这是谁什么时候说的，才好化用
  return hits.map((h) => `${h.date} 命中：${truncate(h.text)}${h.context?.length
    ? `\n  相邻上下文（各自说话人，不代表命中者观点）：${h.context.map(truncate).join(' / ')}` : ''}`).join('\n');
}

function formatMemory(groupId: number, hits: Awaited<ReturnType<typeof recallMemory>>): string {
  if (hits.length === 0) return '没有找到相关的档案。';
  return hits.map((h) => {
    const nick = memoryStore.getNickName(h.ownerId, groupId);
    return `${nick ? `[${nick}] ` : ''}${h.text}`;
  }).join('\n');
}

/** 本地执行一次工具调用，任何情况都返回一段给模型看的文本，不抛异常 */
export async function runMemoryTool(groupId: number, name: string, rawInput: unknown): Promise<string> {
  const input = (rawInput ?? {}) as { query?: string, about?: string, speaker?: string, days?: number, overview?: boolean };
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  // 每条出口都要留日志：只在成功时打印的话，「认不出名字」这种失败在日志里是隐形的
  if (!query) {
    printLog(`[MemoryTool] ${name} -> 缺少 query`);
    return '缺少 query 参数。';
  }

  try {
    if (name === 'recall_memory') {
      const about = input.about?.trim();
      const aboutUserIds = about ? resolveName(groupId, about) : undefined;
      if (about && aboutUserIds!.length === 0) {
        printLog(`[MemoryTool] recall_memory(${query}, about=${about}) -> 名字未解析`);
        return UNKNOWN_NAME(about);
      }
      if (aboutUserIds && aboutUserIds.length > 1) return '这个称呼对应多位群友，请提供完整昵称，暂不混合他们的档案。';

      const hits = await recallMemory(groupId, {
        query, aboutUserIds, limit: TOOL_LIMIT, overview: input.overview === true,
      });
      printLog(`[MemoryTool] recall_memory(${query}${about ? `, about=${about}` : ''}) -> ${hits.length} 条`);
      return formatMemory(groupId, hits);
    }

    if (name === 'recall_chat') {
      const speaker = input.speaker?.trim();
      const speakerIds = speaker ? resolveName(groupId, speaker) : undefined;
      if (speaker && speakerIds!.length === 0) {
        printLog(`[MemoryTool] recall_chat(${query}, speaker=${speaker}) -> 名字未解析`);
        return UNKNOWN_NAME(speaker);
      }
      if (speakerIds && speakerIds.length > 1) return '这个称呼对应多位群友，请提供完整昵称。';

      const days = typeof input.days === 'number' && input.days > 0 ? Math.min(input.days, HISTORY_DAYS) : undefined;
      const hits = await recallChat(groupId, {
        query, speakerIds, days, limit: TOOL_LIMIT,
      });
      printLog(`[MemoryTool] recall_chat(${query}${speaker ? `, speaker=${speaker}` : ''}) -> ${hits.length} 条`);
      return formatChat(hits);
    }

    printLog(`[MemoryTool] 未知的工具 ${name}`);
    return `未知的工具 ${name}。`;
  } catch (e) {
    // 工具挂了不该让整轮回复失败，告诉模型查不到就行
    printLog(`[MemoryTool] ${name} 执行失败: ${e}`);
    return '查询出错了，这次没有拿到结果。';
  }
}
