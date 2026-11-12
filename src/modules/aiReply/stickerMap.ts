import { getImgCode } from '@/utils/msgCode';
import path from 'path';

const STICKER_DIR = path.resolve('data/sticker');

// 定义表情路径映射
const STICKER_MAP: Record<string, string> = {
  得意: 'deyi.jpg',
  观察: 'guancha.gif',
  害羞: 'haixiu.jpg',
  好: 'hao.png',
  我没意见: 'hao2.jpg',
  惊讶: 'jinya.gif',
  救救: 'jiu.png',
  可怜: 'kelian.gif',
  哭哭: 'kuku2.gif',
  乖巧: 'maomao.jpg',
  没办法: 'meibanfa.jpg',
  ohno: 'ohno.jpg',
  贫穷: 'pinqiong.jpg',
  完了: 'wanle.png',
  疑问: 'yiwen.jpg',
};

// 匹配 [表情: 关键词] 格式
const regex = /\[表情:\s*(.*?)\]/g;

/**
 * 转换表情标签文本
 */
export function processStickerTag(text: string): string {
  return text.replace(regex, (match, keyword) => {
    // 50%概率直接删除表情
    if (Math.random() < 0.5) {
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
