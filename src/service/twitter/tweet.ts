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

export interface LatestTweetsResult {
  /** 最新推文 */
  tweets: LatestTweetInfo[];
  /** 服务端本次抓取是否失败。失败时 tweets 必为空，调用方应计入连续失败 */
  failed: boolean;
  /** 服务端抓取失败、退回了旧数据兜底。数据仍可用，只是不新鲜 */
  stale: boolean;
  /** 服务端建议隔多久再来取（秒）。常态 240，深夜 480，故障时退避 */
  nextReadyInS: number;
}

// 服务端没给出建议间隔时的兜底
const DEFAULT_NEXT_READY_S = 240;

/**
 * 取这批用户的最新推文。
 *
 * 服务端是请求触发的实时抓取，拿到的就是此刻的数据。取数节奏由服务端通过
 * next_ready_in_s 下发，这边只管跟随，不必自己判断时段或退避。
 */
export async function getLatestTweets(usernames: string[]): Promise<LatestTweetsResult | null> {
  const { baseUrl, apiKey } = botConfig.nonokaService;
  const nnkURL = `${baseUrl}/tweets/latest?apikey=${apiKey}`;

  try {
    // 服务端把抓取放在请求路径里，超时要留足它的抓取预算，不能按只读缓存给
    const { data } = await Axios.post(nnkURL, { usernames }, { timeout: 30000 });
    if (!data?.success) return null;

    const nextReadyInS = typeof data.next_ready_in_s === 'number' ? data.next_ready_in_s : DEFAULT_NEXT_READY_S;

    // 服务端抓取失败也是 200，靠 status 区分：这样它建议的退避间隔仍能带回来
    if (data.status !== 'success') {
      printError(`[NonokaService] getLatestTweets: upstream failed. ${data.error ?? ''}`);
      return {
        tweets: [], failed: true, stale: false, nextReadyInS,
      };
    }
    if (data.stale) {
      printError('[NonokaService] getLatestTweets: 上游降级返回旧数据（stale）。');
    }

    const userList = (data.users ?? []) as { username: string, latest?: string | null }[];
    // latest 为空表示该账号没出现在本次列表流里。盯的账号可以安静好几天，这是常态而非故障，静默跳过即可
    const tweets = userList.map((user) => {
      const tweetId = getTweetId(user.latest);
      if (!tweetId) return null;
      return {
        username: user.username,
        tweetId,
        time: getTimestampFromTweetId(tweetId),
      };
    }).filter((item): item is LatestTweetInfo => item !== null);

    return {
      tweets, failed: false, stale: Boolean(data.stale), nextReadyInS,
    };
  } catch (e) {
    printError(`[NonokaService] getLatestTweets API Error: ${e.message}`);
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

