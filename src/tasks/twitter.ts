import { SimpleIntervalJob, AsyncTask } from 'toad-scheduler';
import nnkbot from '@/core/nnkBot';
import nnkStorage from '@/core/nnkStorage';
import { printLog } from '@/utils/print';
import { getImgCode, getVideoCode } from '@/utils/msgCode';
import { getLatestTweet, getTweetPost } from '@/service/twitter/tweet';
import { createScreenshot } from '@/service/twitter/screenshot';

export async function createMsgFromTweetId(tweetId: string) {
  // 获取详细信息
  const tweetData = await getTweetPost(tweetId);
  if (!tweetData) return;
  // 生成推文图片
  const dataUrl = await createScreenshot(tweetData);
  if (!dataUrl) return;

  const msgTextArr = [] as string[];
  const videoTextArr = [] as string[];
  msgTextArr.push(getImgCode(dataUrl));
  const images = tweetData.imgUrls ?? [];
  for (let i = 0; i < images.length; i += 1) {
    msgTextArr.push(getImgCode(images[i]));
    if (i > 1) {
      break;
    }
  }
  const videos = tweetData.videoUrls ?? [];
  for (let i = 0; i < videos.length; i += 1) {
    videoTextArr.push(getVideoCode(videos[i]));
    if (i > 1) {
      break;
    }
  }

  msgTextArr.push(`推文链接：${tweetData.link}`);
  const textMsg = msgTextArr.join('\n');
  const videoMsg = videoTextArr.join('\n');
  if (videoTextArr.length > 0) {
    return [textMsg, videoMsg];
  }
  return [textMsg];
}

async function checkLastestTweet(
  { username, groupIds }: { username: string, groupIds: number[] },
) {
  try {
    const latestTweet = await getLatestTweet(username);
    if (!latestTweet || !latestTweet.time) return;
    const preTime = nnkStorage.getTwitterLastestTweetTime(username);
    const newTime = latestTweet.time;

    // 有新推特
    if (newTime > preTime) {
      // 设置最新推特时间
      nnkStorage.setTwitterLastestTweetTime(username, newTime);

      const msgArr = await createMsgFromTweetId(latestTweet.tweetId);
      if (!msgArr || msgArr.length === 0) return;

      groupIds.forEach((groupId) => {
        for (const msg of msgArr) {
          nnkbot.sendGroupMsg(groupId, msg);
        }
      });
    }
  } catch (err) {
    printLog(`[twiiterTask] Error: ${err}`);
  }
}


const task = new AsyncTask('twitterTask', async () => {
  const botIsConnect = nnkbot.getIsBotConnecting();
  const config = nnkbot.config.tweetPush;
  if (!config.enable || !nnkbot.config.nonokaService.apiKey) return;
  if (botIsConnect) {
    Object.keys(config.config).forEach((username: string, i: number) => {
      if (Array.isArray(config.config[username])) {
        setTimeout(() => checkLastestTweet({
          username,
          groupIds: config.config[username],
        }), i * 10000);
      }
    });
  }
});


const TwitterPushJob = new SimpleIntervalJob({ seconds: 200 }, task, { id: 'twitterPush' });

// 启动bot时将用户推文最新时间设置为现在，防止立即推送
Object.keys(nnkbot.config.tweetPush.config).forEach((username: string) => {
  nnkStorage.setTwitterLastestTweetTime(username, new Date().getTime());
});


export default TwitterPushJob;
