import { getImgCode, getVideoCode } from '@/utils/msgCode';
import { getTweetPost } from './tweet';
import { createScreenshot } from './screenshot';

/** 根据推文 id 生成要发送的消息（截图 + 媒体 + 链接），视频存在时拆分为第二条消息 */
export async function createMsgFromTweetId(tweetId: string) {
  // 获取详细信息
  const tweetData = await getTweetPost(tweetId);
  if (!tweetData) return;
  // 生成推文图片
  const dataUrl = await createScreenshot(tweetData);
  if (!dataUrl) return;

  const msgTextArr = [] as string[];
  msgTextArr.push(getImgCode(dataUrl));
  // 图片和视频最多各取3个
  (tweetData.imgUrls ?? []).slice(0, 3).forEach((url) => msgTextArr.push(getImgCode(url)));
  const videoTextArr = (tweetData.videoUrls ?? []).slice(0, 3).map((url) => getVideoCode(url));

  msgTextArr.push(`推文链接：${tweetData.link}`);
  const textMsg = msgTextArr.join('\n');
  const videoMsg = videoTextArr.join('\n');
  if (videoTextArr.length > 0) {
    return [textMsg, videoMsg];
  }
  return [textMsg];
}
