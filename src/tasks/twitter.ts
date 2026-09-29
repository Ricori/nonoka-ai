import { SimpleIntervalJob, AsyncTask } from 'toad-scheduler';
import nnkbot from '@/core/nnkBot';
import nnkStorage from '@/core/nnkStorage';
import { printError } from '@/utils/print';
import { getLatestTweets } from '@/service/twitter/tweet';
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
  const result = await getLatestTweets(twitterUsernames);

  // 无论成败都先排下一次，避免中途异常导致任务停摆
  scheduleNext(result?.nextReadyInS);

  // 成功但一条都没有是正常的，只有服务端明说抓取失败才算失败
  if (!result || result.failed) {
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


// 请求本身就抛了（网络不通、服务端 5xx）时的重试间隔（毫秒）
const RETRY_INTERVAL = 60 * 1000;
// 轮询节拍（秒）：只做时间判断，真正取数由 nextRunAt 控制
const TICK_SECONDS = 10;
// 下次允许取数的时间戳；0 表示启动后首个节拍立即取一次
let nextRunAt = 0;

/**
 * 按服务端建议的节奏排下一次取数。
 * 节奏完全跟随服务端（含其深夜降频与故障退避），这边不自行判断时段；
 * nextReadyInS 缺省表示连响应都没拿到，退化成固定间隔重试，下次成功时自动重新跟上。
 */
function scheduleNext(nextReadyInS?: number) {
  nextRunAt = Date.now() + (nextReadyInS === undefined ? RETRY_INTERVAL : nextReadyInS * 1000);
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
