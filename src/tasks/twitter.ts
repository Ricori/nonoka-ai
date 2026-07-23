import { SimpleIntervalJob, AsyncTask } from 'toad-scheduler';
import nnkbot from '@/core/nnkBot';
import nnkStorage from '@/core/nnkStorage';
import { printError } from '@/utils/print';
import { getCachedLatestTweets } from '@/service/twitter/tweet';
import { createMsgFromTweetId } from '@/service/twitter/message';
import nnkSchedule, { NonokaJob } from '@/core/nnkSchedule';

// 批量接口连续错误次数
let consecutiveFailCount = 0;
// 单条推文生成消息的失败重试上限
const MAX_TWEET_FAIL = 3;
// 每个用户当前待推送推文的失败记录
const tweetFailRecords = new Map<string, { tweetId: string, failCount: number }>();

async function pushLatestTweetForUser(username: string, groupIds: number[], latestTweet: { tweetId: string, time: number }) {
  const preTime = nnkStorage.getTwitterLatestTweetTime(username);
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
      nnkStorage.setTwitterLatestTweetTime(username, latestTweet.time);
      printError(`[twitterTask] Give up tweet ${latestTweet.tweetId} (${username}) after ${failCount} fails.`);
    } else {
      tweetFailRecords.set(username, { tweetId: latestTweet.tweetId, failCount });
    }
    return;
  }

  // 推送成功后再更新最新推特时间
  tweetFailRecords.delete(username);
  nnkStorage.setTwitterLatestTweetTime(username, latestTweet.time);
  groupIds.forEach((groupId) => {
    msgArr.forEach((msg) => nnkbot.sendGroupMsg(groupId, msg));
  });
}

async function checkLatestTweet() {
  const groupConfig = nnkbot.config.tweetPush.config;
  const twitterUsernames = Object.keys(groupConfig);
  const result = await getCachedLatestTweets(twitterUsernames);

  // 无论成败都先排下一次，避免中途异常导致任务停摆
  scheduleNext(result?.nextReadyInS);

  // updatedAt 为空说明服务端还没跑完第一轮，不算失败
  if (!result || (result.tweets.length === 0 && result.updatedAt)) {
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
  if (!result.updatedAt) return;
  consecutiveFailCount = 0;

  for (const u of twitterUsernames) {
    const groupIds = groupConfig[u];
    const latestTweet = result.tweets.find((item) => item.username === u);
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


// 服务端一轮抓取的周期，与其定时任务保持一致
const ROUND_INTERVAL = 240 * 1000;
// 落库完成后再等这么久才取，留出落库写入与网络的余量，防止读到上一轮的旧数据
const ALIGN_DELAY = 30 * 1000;
// 取数失败时的重试间隔（毫秒）：不必等满一轮
const RETRY_INTERVAL = 60 * 1000;
// 轮询节拍（秒）：只做时间判断，真正取数由 nextRunAt 控制
const TICK_SECONDS = 10;
// 下次允许取数的时间戳；0 表示尚未对齐，启动后首个节拍立即取一次完成对齐
let nextRunAt = 0;

function isNight() {
  const hour = new Date().getHours();
  // 深夜 1--7 点跳过一轮，等效 8 分钟一次
  return hour >= 1 && hour < 7;
}

/**
 * 按服务端上报的落库节奏排下一次取数。
 * nextReadyInS 缺省表示本次请求失败，退化成固定间隔重试，下次成功时自动重新对齐。
 */
function scheduleNext(nextReadyInS?: number) {
  if (nextReadyInS === undefined) {
    nextRunAt = Date.now() + RETRY_INTERVAL;
    return;
  }
  const skip = isNight() ? ROUND_INTERVAL : 0;
  nextRunAt = Date.now() + nextReadyInS * 1000 + ALIGN_DELAY + skip;
}

const task = new AsyncTask('twitterTask', async () => {
  if (Date.now() < nextRunAt) return;

  const botIsConnect = nnkbot.getIsBotConnecting();
  if (!botIsConnect) return;
  const config = nnkbot.config.tweetPush;
  if (!config.enable || !nnkbot.config.nonokaService.apiKey) return;
  return checkLatestTweet();
});


const TwitterPushJob: NonokaJob = {
  job: new SimpleIntervalJob({ seconds: TICK_SECONDS }, task, { id: 'twitterPush', preventOverrun: true }),
  // 启动bot时将用户推文最新时间设置为现在，防止立即推送
  init: () => {
    nextRunAt = 0;
    Object.keys(nnkbot.config.tweetPush.config).forEach((username: string) => {
      nnkStorage.setTwitterLatestTweetTime(username, new Date().getTime());
    });
  },
};

export default TwitterPushJob;
