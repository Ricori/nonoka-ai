import { SECURITY_PROMPT, SYSTEM_PROMPT } from '@/service/llm/prompt';
import { FormattedMessage } from '@/types/message';
import { printError, printLog } from '@/utils/print';
import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import Axios from 'axios';
import nnkbot from '@/core/nnkBot';
import { LLM_MODELS, LLM_PARAMS } from './config';

const client = new Anthropic({
  baseURL: nnkbot.config.aiReply.authropicBaseUrl,
  apiKey: nnkbot.config.aiReply.authropicKey,
});

export async function getAnthropicLLMReply(formattedMessage: FormattedMessage[]) {
  const lastImgIndex = formattedMessage.reduce((last, msg, i) => (msg.imgUrl ? i : last), -1);
  const messages: MessageParam[] = await Promise.all(formattedMessage.map(async (msg, i) => {
    if (msg.imgUrl && i === lastImgIndex) {
      // 节省 token，只处理最后一张图
      try {
        const imgResp = await Axios.get<ArrayBuffer>(msg.imgUrl, { responseType: 'arraybuffer' });
        const contentType = imgResp.headers['content-type'] as string || 'image/jpeg';
        const base64 = Buffer.from(imgResp.data).toString('base64');
        const textBlock = {
          type: 'text' as const,
          text: msg.message,
        };
        const imageBlock = {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: (contentType || 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: base64 },
        };
        return { role: msg.role, content: [textBlock, imageBlock] };
      } catch {
        // image fetch failed, fall through to text-only
        printLog('[AiReply Error][Claude] image fetch failed, fall through to text-only');
      }
    }
    return { role: msg.role, content: msg.message };
  }));

  const response = await client.messages.create({
    model: LLM_MODELS.anthropicReply,
    system: SYSTEM_PROMPT + SECURITY_PROMPT,
    messages,
    temperature: LLM_PARAMS.anthropicReply.temperature,
    max_tokens: LLM_PARAMS.anthropicReply.maxTokens,
  }).catch((e: Error) => { printError(`[AiReply Error][Claude] ${e}`); return null; });

  // printLog('[Claude TEST] res', response);

  const firstBlock = response?.content?.[0];
  const text = firstBlock?.type === 'text' ? firstBlock.text : undefined;
  if (text) {
    if (text.includes('kiro') || text.includes('Kiro') || text.includes('Claude')) {
      return null;
    }
    return text as string;
  }
  return null;
}
