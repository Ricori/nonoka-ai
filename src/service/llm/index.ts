import Axios from 'axios';
import { botConfig } from '@/core/nnkConfig';
import { printError } from '@/utils/print';
import type { FormattedMessage } from '@/types/message';

/**
 * LLM 这里只负责把请求转发给 nonoka API 服务
 */

// 服务端 claude 单次 35s，超时会重试一次，最坏 70s，留足余量
const REPLY_TIMEOUT = 90000;
const COMMON_TIMEOUT = 50000;

function getServiceUrl(path: string) {
  const { baseUrl, apiKey } = botConfig.nonokaService;
  return `${baseUrl}${path}?apikey=${apiKey}`;
}

/** context 为当前群聊环境描述，服务端会作为 system 附加段落注入 */
export async function getLLMReply(
  formattedMessage: FormattedMessage[],
  context?: string,
): Promise<string | null> {
  const messages = formattedMessage.map(({
    role, message, imgUrl, cacheControl,
  }) => ({
    role, message, imgUrl, cacheControl,
  }));

  const ret = await Axios.post(getServiceUrl('/llm/reply'), { messages, context }, {
    timeout: REPLY_TIMEOUT,
  }).catch((e) => {
    printError(`[LLM reply error] ${e.message}`);
    return null;
  });

  return ret?.data?.text ?? null;
}

/** 将用户近期消息归纳为不超过 6 条核心特征短句 */
export async function summarizeUserTraits(
  nickName: string,
  messages: string[],
  existingTraits: string[],
): Promise<string[]> {
  const ret = await Axios.post(getServiceUrl('/llm/summarize'), {
    nickName, messages, existingTraits,
  }, {
    timeout: COMMON_TIMEOUT,
  }).catch((e) => {
    printError(`[LLM summarize error] ${e.message}`);
    return null;
  });

  const traits = ret?.data?.traits;
  if (Array.isArray(traits) && traits.length > 0) {
    return traits;
  }
  return existingTraits;
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
