import { SECURITY_PROMPT, SYSTEM_PROMPT } from "@/service/llm/prompt";
import { FormattedMessage } from "@/types/message";
import { printError } from "@/utils/print";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import Axios from "axios";

const TEST_DATA = [
  {
    "role": "user",
    "userId": 515302066,
    "isMentionMe": false,
    "message": "[伊波千果]说：可爱"
  },
  {
    "role": "user",
    "userId": 515302066,
    "isMentionMe": true,
    "message": "[伊波千果]提到我说：你好可爱"
  }
] as FormattedMessage[];

const client = new Anthropic({
  baseURL: '',
  apiKey: '',
});

async function getLLMReply(formattedMessage: FormattedMessage[]) {
  const messages: MessageParam[] = await Promise.all(formattedMessage.map(async (msg) => {
    if (msg.imgUrl) {
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
      }
    }
    return { role: msg.role, content: msg.message };
  }));

  // printLog('[TEST] messages');
  // console.log(JSON.stringify(messages, null, 2));

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    system: SYSTEM_PROMPT + SECURITY_PROMPT,
    messages,
    temperature: 0.8,
    max_tokens: 150,
  }).catch((e: Error) => { printError(`[AiReply Error] ${e}`); return null; });

  console.log(response);
  if (response?.content?.[0].text) {
    return response.content[0].text as string;
  }

  return null;
}


export async function testAI() {
  const text = await getLLMReply(TEST_DATA);
  console.log(text)
}
