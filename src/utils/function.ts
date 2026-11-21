import { extractCQCodes, hasCQCode } from './msgCode';

/** 返回文本数组中随机文本 */
export function randomText(textArr: string[]) {
  const i = Math.floor(Math.random() * textArr.length);
  return textArr[i];
}

/** 判断消息是否有图片 */
export function hasImage(msg: string) {
  // 残缺的图片 CQ 码解析不出图，不算有图，调用方可放心取 getImgs(msg)[0]
  return hasCQCode(msg, 'image') && getImgs(msg).length > 0;
}

/** 从消息中提取图片 */
export function getImgs(msg: string, extra = false) {
  const cqimgs = extractCQCodes(msg).filter((cq) => cq.type === 'image');
  return cqimgs.map((cq) => {
    const data = cq.pickData(extra ? ['file', 'url', 'file_size', 'summary', 'sub_type'] : ['file', 'url']);
    return data as { file: string, url: string, file_size?: string, summary?: string, sub_type?: string };
  });
}

/** 判断消息是否回复消息 */
export function hasReply(msg: string) {
  return hasCQCode(msg, 'reply');
}

/** 从消息中提取回复 reply id */
export function getReplyMsgId(msg: string) {
  const reply = extractCQCodes(msg).find((cq) => cq.type === 'reply');
  return reply?.data.get('id') || 0;
}

/** sleep */
export function sleep(ms: number) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** 根据字数计算人类打字延迟毫秒数 */
export function calculateTypingDelay(text: string): number {
  const baseDelay = 500;
  const timePerChar = 120;
  const jitter = Math.floor(Math.random() * 600) - 300;
  return Math.max(baseDelay + (text.length * timePerChar) + jitter, 500);
}
