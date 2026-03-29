import OpenAI from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources';
import yorubot from '@/core/yoruBot';
import { printError, printLog } from '@/utils/print';
import { getImgs, hasImage } from '@/utils/function';
import Axios from 'axios';
import { SYSTEM_PROMPT, TRANSLATE_PROMPT } from './prompt';

const client = new OpenAI({
  apiKey: yorubot.config.aiReply.apiKey,
  baseURL: yorubot.config.aiReply.baseUrl,
});


export function generateUserMessageParam(rawText: string, shouldCleanImg = false): ChatCompletionMessageParam {
  const text = rawText.replace(/\[CQ:face,.*\]/g, '[表情]')
    .replace(/\[CQ:json,data=\{[\s\S]*?"title":"([^"]+)"[\s\S]*?\}\]/, '分享了文章《$1》')
    .replace(/\[CQ:forward,.*\]/g, '[聊天记录]');
  if (hasImage(text)) {
    if (shouldCleanImg) {
      // 需要清理图片
      const cleanText = text.replace(/\[CQ:image,[^\]]+\]/g, '[图片]').trim();
      return {
        role: 'user',
        content: cleanText,
      };
    }
    const img = getImgs(text, true)[0];
    const imgUrl = img.url || '';
    const imgSize = Number(img.file_size || 0);
    if (img.summary === '[动画表情]' || imgSize < 120 * 1024) {
      // 包含表情标签，或者图片小于120kb认为是表情，降成纯文本
      const cleanText = text.replace(/\[CQ:image,[^\]]+\]/g, '[表情]').trim();
      return {
        role: 'user',
        content: cleanText,
      };
    }
    const plainText = text.replace(/\[CQ:image,.*\]/g, '[图片]');
    return {
      role: 'user',
      content: [
        { type: 'text', text: plainText || '[图片]' },
        {
          type: 'image_url',
          image_url: {
            url: imgUrl,
          },
        },
      ],
    };
  }
  return {
    role: 'user',
    content: text,
  };
}


export function generateAssistantMessageParam(text: string): ChatCompletionMessageParam {
  return {
    role: 'assistant',
    content: text,
  };
}

export async function getAiReply(messageParam: ChatCompletionMessageParam[]) {
  const systemMsg: ChatCompletionMessageParam = {
    role: 'system',
    content: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      } as any,
    ],
  };

  const messagesToAPI: ChatCompletionMessageParam[] = [systemMsg, ...messageParam];

  printLog('[TEST] messagesToAPI');
  console.log(messagesToAPI);

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
    return response.choices[0].message.content as string;
  }

  return null;
}


export async function translateText(text: string) {
  const ret = await Axios.post(`${yorubot.config.aiReply.baseUrl}/chat/completions`, {
    model: 'deepseek-v3.2-exp',
    messages: [
      { role: 'user', content: TRANSLATE_PROMPT + text },
    ],
  }, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${yorubot.config.aiReply.apiKey}`,
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
