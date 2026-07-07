import Axios from 'axios';
import nnkbot from '@/core/nnkBot';
import { printError } from '@/utils/print';
import type { FormattedMessage } from '@/types/message';

/**
 * LLM 这里只负责把请求转发给 nonoka API 服务
 */

// claude 失败会在服务端回退 kimi 并可能去图重试，留足余量
const REPLY_TIMEOUT = 90000;
const COMMON_TIMEOUT = 40000;

function getServiceUrl(path: string) {
  const { baseUrl, apiKey } = nnkbot.config.nonokaService;
  return `${baseUrl}${path}?apikey=${apiKey}`;
}

export async function getLLMReply(formattedMessage: FormattedMessage[]): Promise<string | null> {
  const messages = formattedMessage.map(({
    role, message, imgUrl, cacheControl,
  }) => ({
    role, message, imgUrl, cacheControl,
  }));

  const ret = await Axios.post(getServiceUrl('/llm/reply'), { messages }, {
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
