import fs from 'fs';
import path from 'path';
import axios from 'axios';

export const PICTURE_DIR = path.resolve('data/picture');


/** 缓存的关键词列表 */
let cachedKeywords: string[] | null = null;

/** 获取所有已注册的关键词（即 data/picture 下的子目录名），带缓存 */
export function getKeywords(): string[] {
  if (cachedKeywords !== null) return cachedKeywords;
  if (!fs.existsSync(PICTURE_DIR)) return [];
  cachedKeywords = fs.readdirSync(PICTURE_DIR).filter((f) => fs.statSync(path.join(PICTURE_DIR, f)).isDirectory());
  return cachedKeywords;
}

/** 加图后刷新关键词缓存 */
export function refreshKeywords(): void {
  cachedKeywords = null;
}

/** 从指定关键词目录中随机取一张图片，返回绝对路径 */
export function getRandomPicture(keyword: string): string | null {
  const dir = path.join(PICTURE_DIR, keyword);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  if (files.length === 0) return null;
  const file = files[Math.floor(Math.random() * files.length)];
  return path.resolve(dir, file);
}

/** 下载图片到本地 (随机文件名) */
export async function downloadImage(url: string, destDir: string): Promise<string> {
  fs.mkdirSync(destDir, { recursive: true });
  const ext = '.jpg';
  const filename = `${Date.now()}_${Math.floor(Math.random() * 10000)}${ext}`;
  const destPath = path.join(destDir, filename);
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  fs.writeFileSync(destPath, response.data);
  return destPath;
}

/** 已发送图片 message_id → 本地路径，只保留最近 SENT_CACHE_SIZE 条（Map 按插入顺序淘汰） */
const SENT_CACHE_SIZE = 500;
const sentPictures = new Map<number, string>();

export function recordSentPicture(messageId: number, picPath: string): void {
  sentPictures.set(messageId, picPath);
  if (sentPictures.size > SENT_CACHE_SIZE) {
    sentPictures.delete(sentPictures.keys().next().value!);
  }
}

/** 按 message_id 删除 bot 发出的图片，返回所属关键词；查不到或文件已不存在返回 null */
export function deleteSentPicture(messageId: number): string | null {
  const picPath = sentPictures.get(messageId);
  if (!picPath || !fs.existsSync(picPath)) return null;

  fs.unlinkSync(picPath);
  sentPictures.delete(messageId);
  // 删空的关键词目录一并移除，否则关键词仍会被匹配
  const dir = path.dirname(picPath);
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  refreshKeywords();
  return path.basename(dir);
}
