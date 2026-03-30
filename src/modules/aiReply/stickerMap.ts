import { getImgCode } from '@/utils/msgCode';
import path from 'path';

const STICKER_DIR = path.resolve('data/sticker');

// 定义表情路径映射
const STICKER_MAP: Record<string, string> = {
  得意: 'deyi.gif',
  好耶: 'haoye.jpg',
  惊讶: 'jinya.gif',
  可怜: 'kelian.gif',
  没办法: 'meifa.jpg',
  没意见: 'meiyijian.jpg',
  难办: 'nanban.jpg',
  挠头: 'naotou.jpg',
  完了: 'wanle.png',
  围观: 'weiguan.jpg',
};

// 匹配 [表情: 关键词] 格式
const regex = /\[表情:\s*(.*?)\]/g;

/**
 * 转换表情标签文本
 */
export function processStickerTag(text: string): string {
  return text.replace(regex, (match, keyword) => {
    // 75%概率直接删除表情
    if (Math.random() < 0.75) {
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
