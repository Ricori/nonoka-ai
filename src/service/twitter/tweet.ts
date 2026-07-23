import Axios from 'axios';
import { printError } from '@/utils/print';
import { botConfig } from '@/core/nnkConfig';
import { translateText } from '@/service/llm';
import { rewriteToCDN } from '@/service/cdn';

export interface TweetPost {
  username: string;
  userScreenName: string;
  userProfile: string;
  time: number;
  link: string;
  tweetText: string;
  translatedText: string;
  imgUrls: string[];
  videoUrls: string[];
}
function getTweetId(url?: string | null) {
  if (!url) return null;
  const m = url.match(/status\/(\d+)/);
  return m ? m[1] : null;
}
function getTimestampFromTweetId(id: string) {
  // 逆向推特的Snowflake算法：右移22位（即除以2^22）再加纪元偏移
  return Number(BigInt(id) / 4194304n) + 1288834974657;
}

export interface LatestTweetInfo {
  username: string;
  tweetId: string;
  time: number;
}

export interface CachedTweetsResult {
  /** 服务端最近一轮落库的最新推文 */
  tweets: LatestTweetInfo[];
  /** 距服务端下一轮数据落库还有多少秒，用于对齐下次取数时间 */
  nextReadyInS: number;
  /** 本轮数据的落库时刻（服务端 epoch 秒） */
  updatedAt: number | null;
}

// 服务端未给出就绪时间时的兜底间隔
const DEFAULT_NEXT_READY_S = 240;

/**
 * 读取服务端定时任务落库的最新推文。
 */
export async function getCachedLatestTweets(usernames: string[]): Promise<CachedTweetsResult | null> {
  const { baseUrl, apiKey } = botConfig.nonokaService;
  const nnkURL = `${baseUrl}/tweets/cached?apikey=${apiKey}`;

  try {
    const { data } = await Axios.post(nnkURL, { usernames }, { timeout: 15000 });
    if (!data?.success) return null;

    const userList = (data.users ?? []) as { username: string, latest?: string | null, error?: string }[];
    const tweets = userList.map((user) => {
      const tweetId = getTweetId(user.latest);
      if (!tweetId) {
        // 该用户本轮抓取失败，定时任务下一轮会重试，跳过即可
        if (data.updated_at) {
          printError(`[NonokaService] getCachedLatestTweets: ${user.username} unavailable. ${user.error ?? ''}`);
        }
        return null;
      }
      return {
        username: user.username,
        tweetId,
        time: getTimestampFromTweetId(tweetId),
      };
    }).filter((item): item is LatestTweetInfo => item !== null);

    return {
      tweets,
      nextReadyInS: typeof data.next_ready_in_s === 'number' ? data.next_ready_in_s : DEFAULT_NEXT_READY_S,
      updatedAt: data.updated_at ?? null,
    };
  } catch (e) {
    printError(`[NonokaService] getCachedLatestTweets API Error: ${e.message}`);
  }
  return null;
}

export async function getTweetPost(tweetId: string, translate = true) {
  const ret2 = await Axios.get(`https://api.vxtwitter.com/tt/status/${tweetId}`, { timeout: 15000 }).catch((e) => {
    printError(`[Vxtwitter Error] Fetch Error: ${e.message}`);
    return null;
  });
  if (ret2?.data) {
    if (typeof ret2.data === 'string') {
      printError('[Vxtwitter Error] API Error.');
      return undefined;
    }
    const post = await resolveData(ret2.data, translate);
    return post;
  }
  return undefined;
}

async function resolveData(apiResponse: Record<any, any>, translate: boolean) {
  const username: string = apiResponse.user_name || '';
  const tweetURL: string = apiResponse.tweetURL || '';
  const time: number = new Date(apiResponse.date || '').getTime();
  const userScreenName: string = apiResponse.user_screen_name || '';
  const userProfile: string = rewriteToCDN(apiResponse.user_profile_image_url || '');
  const imgUrls: string[] = [];
  const videoUrls: string[] = [];

  let tweetText = '';
  let translatedText = '';
  if (apiResponse.text) {
    tweetText = apiResponse.text;
  }
  if (tweetText && translate) {
    translatedText = await translateText(tweetText) ?? '';
  }

  for (const media of apiResponse.media_extended ?? []) {
    const mediaUrl = rewriteToCDN(media.url || '');
    if (media.type === 'image') {
      imgUrls.push(mediaUrl);
    } else if (media.type === 'video' || media.type === 'gif') {
      videoUrls.push(mediaUrl);
    }
  }

  const post = {
    username,
    userScreenName,
    time,
    link: tweetURL,
    tweetText,
    translatedText,
    imgUrls,
    videoUrls,
    userProfile,
  };
  return post;
}

