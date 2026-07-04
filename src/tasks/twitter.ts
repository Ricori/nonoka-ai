import { SimpleIntervalJob, AsyncTask } from 'toad-scheduler';
import nnkbot from '@/core/nnkBot';
import nnkStorage from '@/core/nnkStorage';
import { printError } from '@/utils/print';
import { getImgCode, getVideoCode } from '@/utils/msgCode';
import { getLatestTweetsBatch, getTweetPost } from '@/service/twitter/tweet';
import { createScreenshot } from '@/service/twitter/screenshot';
import nnkSchedule from '@/core/nnkSchedule';

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

// 批量接口连续错误次数
let consecutiveFailCount = 0;
// 单条推文生成消息的失败重试上限
const MAX_TWEET_FAIL = 3;
// 每个用户当前待推送推文的失败记录
const tweetFailRecords = new Map<string, { tweetId: string, failCount: number }>();

async function pushLatestTweetForUser(username: string, groupIds: number[], latestTweet: { tweetId: string, time: number }) {
  const preTime = nnkStorage.getTwitterLastestTweetTime(username);
  // 没有新推特
  if (latestTweet.time <= preTime) return;

  const msgArr = await createMsgFromTweetId(latestTweet.tweetId).catch((err) => {
    printError(`[twitterTask] createMsg Error (${username}): ${err}`);
    return undefined;
  });

  if (!msgArr || msgArr.length === 0) {
    // 生成失败，记录失败次数，下轮重试；超过上限则放弃该条推文
    const record = tweetFailRecords.get(username);
    const failCount = (record?.tweetId === latestTweet.tweetId ? record.failCount : 0) + 1;
    if (failCount >= MAX_TWEET_FAIL) {
      tweetFailRecords.delete(username);
      nnkStorage.setTwitterLastestTweetTime(username, latestTweet.time);
      printError(`[twitterTask] Give up tweet ${latestTweet.tweetId} (${username}) after ${failCount} fails.`);
    } else {
      tweetFailRecords.set(username, { tweetId: latestTweet.tweetId, failCount });
    }
    return;
  }

  // 推送成功后再更新最新推特时间
  tweetFailRecords.delete(username);
  nnkStorage.setTwitterLastestTweetTime(username, latestTweet.time);
  groupIds.forEach((groupId) => {
    msgArr.forEach((msg) => nnkbot.sendGroupMsg(groupId, msg));
  });
}

async function checkLatestTweet() {
  const groupConfig = nnkbot.config.tweetPush.config;
  const twitterUsernames = Object.keys(groupConfig);
  const latestTweetsBatch = await getLatestTweetsBatch(twitterUsernames);

  if (!latestTweetsBatch || latestTweetsBatch.length === 0) {
    consecutiveFailCount++;
    if (consecutiveFailCount === 10) {
      // 连续错误10次，停止任务
      nnkSchedule.stopById('twitterPush');
      nnkbot.sendPrivateMsg(nnkbot.config.admin[0], 'Failed 10x. Stop twitter push task.');
      return;
    }
    if (consecutiveFailCount % 5 === 0) {
      printError(`[GetLatestTweet Warn] Failed x${consecutiveFailCount}.`);
      nnkbot.sendPrivateMsg(nnkbot.config.admin[0], `GetLatestTweet failed x${consecutiveFailCount}.`);
    }
    return;
  }
  consecutiveFailCount = 0;

  for (const u of twitterUsernames) {
    const groupIds = groupConfig[u];
    const latestTweet = latestTweetsBatch.find((item) => item.username === u);
    if (Array.isArray(groupIds) && latestTweet) {
      try {
        await pushLatestTweetForUser(u, groupIds, latestTweet);
      } catch (err) {
        // 单个用户出错不影响其他用户
        printError(`[twitterTask] Error (${u}): ${err}`);
      }
    }
  }
}


const task = new AsyncTask('twitterTask', async () => {
  const botIsConnect = nnkbot.getIsBotConnecting();
  if (!botIsConnect) return;
  const config = nnkbot.config.tweetPush;
  if (!config.enable || !nnkbot.config.nonokaService.apiKey) return;
  return checkLatestTweet();
});


const TwitterPushJob = new SimpleIntervalJob({ seconds: 240 }, task, { id: 'twitterPush', preventOverrun: true });

// 启动bot时将用户推文最新时间设置为现在，防止立即推送
Object.keys(nnkbot.config.tweetPush.config).forEach((username: string) => {
  nnkStorage.setTwitterLastestTweetTime(username, new Date().getTime());
});


export default TwitterPushJob;
