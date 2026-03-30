import { generateUserMessageParam, } from '@/service/ai/message';
import { SYSTEM_PROMPT } from '@/service/llm/prompt';
import Axios from 'axios';

export async function testAI() {
  const systemMsg = {
    role: 'system',
    content: SYSTEM_PROMPT,
  };
  const messageParam = generateUserMessageParam('这是啥');

  const ret = await Axios.post(``, {
    model: 'gemini-3.1-pro',
    messages: [
      systemMsg,
      {
        role: 'user',
        content: [
          { type: 'text', text: '[图片]' },
          {
            type: 'image_url',
            image_url: {
              url: 'https://ww2.sinaimg.cn/mw690/006lXEh9gy1huamcufv9aj30zk1be460.jpg',
            },
          },
        ],
      },
      messageParam,
    ],
    temperature: 0.8,
    //max_tokens: 300,
  }, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer sk-`,
    },
  }).catch((e) => {
    console.log(`[Error] Fetch Error: ${e.message}`);
    return null;
  });

  if (ret?.data?.choices?.[0]?.message?.content) {
    console.log(ret.data.choices[0].message);

  } else {
    console.log(ret?.data);
  }

  return null;

}
