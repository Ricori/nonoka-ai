import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources';
import nnkbot from '@/core/nnkBot';
import { printError, printLog } from '@/utils/print';
import Axios from 'axios';
import type { FormattedMessage } from '@/types/message';
import {
  SYSTEM_PROMPT, SECURITY_PROMPT, TRANSLATE_PROMPT, getSummarizePrompt,
} from './prompt';

const client = new OpenAI({
  apiKey: nnkbot.config.aiReply.apiKey,
  baseURL: nnkbot.config.aiReply.baseUrl,
});


export async function getLLMReply(formattedMessage: FormattedMessage[]) {
  const systemMsg: ChatCompletionMessageParam = {
    role: 'system',
    content: [
      {
        type: 'text',
        text: SYSTEM_PROMPT + SECURITY_PROMPT,
        cache_control: { type: 'ephemeral' },
      } as any,
    ],
  };

  const lastImgIndex = formattedMessage.map((msg) => !!msg.imgUrl).lastIndexOf(true);
  const chatCompletionMessages = formattedMessage.map((msg, index) => {
    let content: ChatCompletionMessageParam['content'] = msg.message;
    if (msg.imgUrl) {
      const isLastImgObj = index === lastImgIndex;
      content = [
        {
          type: 'text',
          text: msg.message,
          ...(isLastImgObj ? { cache_control: { type: 'ephemeral' } } : {}),
        },
        {
          type: 'image_url',
          image_url: {
            url: msg.imgUrl,
            detail: 'low',
          },
        },
      ];
    } else if (msg.cacheControl) {
      content = [{
        type: 'text',
        text: msg.message,
        cache_control: { type: 'ephemeral' },
      } as any];
    }
    return { role: msg.role, content } as ChatCompletionMessageParam;
  });

  const messagesToAPI: ChatCompletionMessageParam[] = [systemMsg, ...chatCompletionMessages];
  // printLog('[TEST] messagesToAPI');
  // console.log(JSON.stringify(messagesToAPI, null, 2));

  let response = await client.chat.completions.create(
    {
      model: 'kimi-k2.5',
      messages: messagesToAPI,
      temperature: 0.8,
      max_tokens: 150,
    },
    { timeout: 20000 },
  ).catch((e) => { printError(`[AiReply Error] ${e}`); return null; });

  if (!response?.choices?.[0]?.message?.content) {
    // 多半是远程图片拉取失败，去掉图片消息后重试
    const messagesNoImg: ChatCompletionMessageParam[] = messagesToAPI.map((msg) => {
      if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter((p) => p.type === 'text');
        const text = textParts.map((p) => (p as { type: 'text'; text: string }).text).join('');
        return { ...msg, content: text || '[图片]' };
      }
      return msg;
    });
    response = await client.chat.completions.create(
      {
        model: 'kimi-k2.5',
        messages: messagesNoImg,
        temperature: 0.8,
        max_tokens: 150,
      },
      { timeout: 20000 },
    ).catch((e) => { printError(`[AiReply Retry Error] ${e}`); return null; });
  }

  if (response?.choices?.[0]?.message?.content) {
    // printLog('请求缓存 Token');
    // console.log(response.usage?.prompt_tokens_details);
    return response.choices[0].message.content as string;
  }

  return null;
}


/** 用 LLM 将用户近期消息归纳为不超过 6 条核心特征短句 */
export async function summarizeUserTraits(
  nickName: string,
  messages: string[],
  existingTraits: string[],
): Promise<string[]> {
  const prompt = getSummarizePrompt(nickName, messages, existingTraits);

  const response = await client.chat.completions.create({
    model: 'qwen-turbo-1101',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 120,
  }, { timeout: 15000 }).catch((e) => { printError(`[AiReply Summarize Error] ${e}`); return null; });

  const content = response?.choices?.[0]?.message?.content ?? '';

  const results = [...content.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (results.length > 0) {
    return results;
  }

  return existingTraits;
}

export async function translateText(text: string) {
  const ret = await Axios.post(`${nnkbot.config.aiReply.baseUrl}/chat/completions`, {
    model: 'deepseek-v3.2-exp',
    messages: [
      { role: 'user', content: TRANSLATE_PROMPT + text },
    ],
  }, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${nnkbot.config.aiReply.apiKey}`,
    },
  }).catch((e) => {
    printError(`[Aliyun Error] Fetch Error: ${e.message}`);
    return null;
  });
  if (ret?.data?.choices?.[0]?.message?.content) {
    return ret.data.choices[0].message.content;
  }
  return null;
}
