import { getImgCode } from '@/utils/msgCode';
import path from 'path';

const STICKER_DIR = path.resolve('data/sticker');

// 定义表情路径映射
const STICKER_MAP: Record<string, string> = {
  乖巧: 'maomao.jpg',
  疑问: 'yiwen.jpg',
  好: 'hao.png',
  不行: 'no.jpg',
  没事吧: 'meishiba.png',
  救救: 'jiu.png',
  得意: 'deyi.jpg',
  这是假的: 'jia.png',
  好耶: 'haoye.png',
  惊讶: 'jinya.gif',
  可怜: 'kelian.gif',
  哭哭: 'ku.gif',
  完了: 'wanle.png',
  走了: 'zoule.png',
};

// 匹配 [表情: 关键词] 格式
const regex = /\[表情:\s*(.*?)\]/g;

/**
 * 转换表情标签文本
 */
export function processStickerTag(text: string): string {
  return text.replace(regex, (match, keyword) => {
    // 20%概率直接删除表情
    if (Math.random() < 0.2) {
      return '';
    }

    const imgName = STICKER_MAP[keyword.trim()];
    if (imgName) {
      const picPath = path.resolve(STICKER_DIR, imgName);
      const fileUri = `file:///${picPath.replace(/\\/g, '/')}`;
      return getImgCode(fileUri, true);
    }
    // 如果没找到对应的图就返回或空
    return '';
  });
}
