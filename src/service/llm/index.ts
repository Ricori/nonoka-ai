import Axios from 'axios';
import { botConfig } from '@/core/nnkConfig';
import { printError } from '@/utils/print';
import type { FormattedMessage } from '@/types/message';

/**
 * LLM 这里只负责把请求转发给 nonoka API 服务
 */

// 服务端可能先识图再调用回复模型，单次请求最多等待 100s
const REPLY_TIMEOUT = 100000;
const COMMON_TIMEOUT = 50000;

/** 工具轮也可能先识图并触发模型重试，单请求超时与普通回复保持一致。 */
const TOOL_ROUND_TIMEOUT = 100000;

function getServiceUrl(path: string) {
  const { baseUrl, apiKey } = botConfig.nonokaService;
  return `${baseUrl}${path}?apikey=${apiKey}`;
}

/** 只保留服务端认的字段，别把 userId、isMentionMe 这些本地状态发出去 */
function toDTO(formattedMessage: FormattedMessage[]) {
  return formattedMessage.map(({ role, message, imgUrl }) => ({ role, message, imgUrl }));
}

/** context 为当前群聊环境描述，服务端会作为 system 附加段落注入 */
export async function getLLMReply(
  formattedMessage: FormattedMessage[],
  context?: string,
): Promise<string | null> {
  const data = await postReply({ messages: toDTO(formattedMessage), context }, REPLY_TIMEOUT);
  return data?.text ?? null;
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: object;
}

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

interface ToolRound {
  use: ToolUse[];
  results: { id: string, content: string }[];
}

/** 本地执行一次工具调用，返回给模型看的文本 */
export type ToolRunner = (name: string, input: unknown) => Promise<string>;

/** 发一次 /llm/reply，可能拿到文本，也可能拿到「要调工具」 */
async function postReply(body: object, timeout: number) {
  const ret = await Axios.post(getServiceUrl('/llm/reply'), body, { timeout }).catch((e) => {
    printError(`[LLM reply error] ${e.message}`);
    return null;
  });
  return ret?.data ?? null;
}

/**
 * 带工具的回复。工具循环跑在 bot 这边——记忆数据都在本地
 * 服务端无状态，所以每轮都要把之前的 tool_use 和执行结果一起带回去重建对话。
 * maxRounds 为 0 时只发一轮且不许调工具
 */
export async function getLLMReplyWithTools(
  formattedMessage: FormattedMessage[],
  context: string | undefined,
  tools: ToolDef[],
  runTool: ToolRunner,
  maxRounds: number,
): Promise<string | null> {
  const messages = toDTO(formattedMessage);
  const rounds: ToolRound[] = [];

  for (let round = 0; round <= maxRounds; round++) {
    const canUseTools = round < maxRounds;
    const data = await postReply({
      messages,
      context,
      // 最后一轮抽掉 tools，既逼模型必须出文本
      ...(canUseTools ? { tools } : {}),
      ...(rounds.length ? { toolRounds: rounds } : {}),
    }, canUseTools ? TOOL_ROUND_TIMEOUT : REPLY_TIMEOUT);

    if (!data) return null;
    if (data.stopReason !== 'tool_use') return data.text ?? null;

    const toolUse: ToolUse[] = Array.isArray(data.toolUse) ? data.toolUse : [];
    if (toolUse.length === 0) return null;

    // 模型一轮可能要调多个工具，全部执行完再一起回传
    const results = await Promise.all(toolUse.map(async (u) => ({
      id: u.id,
      content: await runTool(u.name, u.input).catch(() => '查询出错了，这次没有拿到结果。'),
    })));
    rounds.push({ use: toolUse, results });
  }

  return null;
}

export interface MemoryOpDTO {
  op: 'ADD' | 'UPDATE' | 'DELETE';
  id?: number;
  kind?: string;
  text?: string;
  confidence?: number;
}

/**
 * 抽取新记忆并与已有条目调和，返回对档案的增删改操作。
 *
 * 失败返回 null，和「确实没有变化」的空数组区分开——
 * 前者要把这批消息放回缓冲区重试，后者不能重试
 */
export async function extractMemory(
  nickName: string,
  messages: string[],
  existing: { id: number, kind: string, text: string, pinned: boolean }[],
): Promise<MemoryOpDTO[] | null> {
  const ret = await Axios.post(getServiceUrl('/llm/memory/extract'), {
    nickName, messages, existing,
  }, {
    timeout: COMMON_TIMEOUT,
  }).catch((e) => {
    printError(`[LLM memory extract error] ${e.message}`);
    return null;
  });

  const ops = ret?.data?.ops;
  return Array.isArray(ops) ? ops : null;
}

export interface EmbedResult {
  vectors: number[][];
  /** 产出这批向量的模型。旧版服务不返回，为 null */
  model: string | null;
}

/**
 * 文本向量化。维度不写死，由调用方从返回值推断；
 * 模型名要跟着向量一起入库，不同模型的向量不能互相比
 */
export async function embedTexts(texts: string[]): Promise<EmbedResult | null> {
  if (texts.length === 0) return { vectors: [], model: null };

  const ret = await Axios.post(getServiceUrl('/llm/embed'), { texts }, {
    timeout: COMMON_TIMEOUT,
  }).catch((e) => {
    printError(`[LLM embed error] ${e.message}`);
    return null;
  });

  const vectors = ret?.data?.vectors;
  if (!Array.isArray(vectors) || vectors.length !== texts.length) return null;
  return { vectors, model: typeof ret?.data?.model === 'string' ? ret.data.model : null };
}

/** 调用LLM翻译 */
export async function translateText(text: string, lang = 'cn'): Promise<string | null> {
  const ret = await Axios.post(getServiceUrl('/llm/translate'), { text, lang }, {
    timeout: COMMON_TIMEOUT,
  }).catch((e) => {
    printError(`[LLM translate error] ${e.message}`);
    return null;
  });

  return ret?.data?.text ?? null;
}
