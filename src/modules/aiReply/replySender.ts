import { calculateTypingDelay, sleep } from '@/utils/function';
import { processStickerTag } from './stickerMap';

/** 处理表情标签，按 '||' 分段并模拟打字延迟逐条发送 AI 回复文本（群聊/私聊共用） */
export async function sendSegmentedReply(aiReplyText: string, send: (msg: string) => void) {
  const messages = processStickerTag(aiReplyText)
    .split('||')
    .map((msg) => msg.trim())
    .filter((msg) => msg.length > 0);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (i > 0) {
      const delay = calculateTypingDelay(msg);
      await sleep(delay);
    }
    send(msg);
  }
}
