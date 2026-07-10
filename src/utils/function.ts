import { extractCQCodes, hasCQCode, transformCQCodes } from './msgCode';

/** 返回文本数组中随机文本 */
export function randomText(textArr: string[]) {
  const i = Math.floor(Math.random() * textArr.length);
  return textArr[i];
}

/** 判断消息是否有图片
 * @param {string} msg 消息
 * @returns 有则返回true
 */
export function hasImage(msg: string) {
  return hasCQCode(msg, 'image');
}


/** 从消息中提取图片
 * @param {string} msg cqtext
 * @param {boolean} extra 是否提取额外信息
 * @returns 图片URL数组
 */
export function getImgs(msg: string, extra = false) {
  const cqimgs = extractCQCodes(msg).filter((cq) => cq.type === 'image');
  return cqimgs.map((cq) => {
    const data = cq.pickData(extra ? ['file', 'url', 'file_size', 'summary'] : ['file', 'url']);
    return data as { file: string, url: string, file_size?: string, summary?: string };
  });
}

/** 判断消息是否回复消息
 * @param {string} msg 消息
 * @returns 有则返回true
 */
export function hasReply(msg: string) {
  return hasCQCode(msg, 'reply');
}

/** 判断消息中是否有@人
 * @param {string} msg 消息
 * @returns 有则返回true
 */
export function hasAt(msg: string) {
  return hasCQCode(msg, 'at');
}

/** 从消息中提取回复reply id
 * @param {string} msg
 */
export function getReplyMsgId(msg: string) {
  const reply = extractCQCodes(msg).find((cq) => cq.type === 'reply');
  return reply?.data.get('id') || 0;
}

/** 从消息中提取回复forward id
 * @param {string} msg
 */
export function getForwardMessageId(msg: string) {
  const forward = extractCQCodes(msg).find((cq) => cq.type === 'forward');
  return forward?.data.get('id') || 0;
}

/** 从消息中去除@和replay文本
 * @param {string} msg
 */
export function cleanAt(msg: string) {
  return transformCQCodes(msg, (cq) => (cq.type === 'at' || cq.type === 'reply' ? '' : null)).trimStart();
}


/** 去除首尾指定字符
 */
export function trimChar(str: string | null, char: string) {
  if (!str) return '';
  // 转义特殊字符
  const escapedChar = char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reg = new RegExp(`^${escapedChar}+|${escapedChar}+$`, 'g');
  return str.replace(reg, '');
}

/** sleep */
export function sleep(ms: number) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }

/**
 * 根据字数计算人类打字时间
 * @param text 要发送的文本
 * @returns 延迟毫秒数
 */
export function calculateTypingDelay(text: string): number {
  const baseDelay = 500; // 基础延迟
  const timePerChar = 120; // 假设人类每打一个字需要 120ms
  const jitter = Math.floor(Math.random() * 600) - 300; // 随机波动
  return Math.max(baseDelay + (text.length * timePerChar) + jitter, 500);
}
