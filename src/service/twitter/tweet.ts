import Axios from 'axios';
import { printError } from '@/utils/print';
import nnkbot from '@/core/nnkBot';
import { translateText } from '@/service/llm';

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

export async function getLatestTweetsBatch(usernames: string[]) {
  const nnkServiceConfig = nnkbot.config.nonokaService;
  const nnkURL = `${nnkServiceConfig.baseUrl}/tweets/batch?apikey=${nnkServiceConfig.apiKey}`;

  try {
    const ret = await Axios.post(nnkURL, { usernames }, { timeout: 52000 });
    if (!ret.data) return null;
    if (ret.data.success && ret.data.users?.length > 0) {
      const userList = ret.data.users as { username: string, latest?: string | null }[];
      return userList.map((user) => {
        const tweetId = getTweetId(user.latest);
        if (!tweetId) {
          printError(`[NonokaService] getLatestTweetsBatch API: ${user.username} scrape failed.`);
          return null;
        }
        const time = getTimestampFromTweetId(tweetId);
        return {
          username: user.username,
          tweetId,
          time,
        };
      }).filter((item): item is NonNullable<typeof item> => item !== null);
    }
    return null;
  } catch (e) {
    printError(`[NonokaService] getLatestTweetsBatch API Error: ${e.message}`);
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
  const userProfile: string = apiResponse.user_profile_image_url?.replace('pbs.twimg.com', 'cdn.nonoka.online/x/pbs') || '';
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
    let mediaUrl: string = media.url || '';
    if (media.type === 'image') {
      mediaUrl = mediaUrl.replace('pbs.twimg.com', 'cdn.nonoka.online/x/pbs');
      imgUrls.push(mediaUrl);
    } else if (media.type === 'video' || media.type === 'gif') {
      mediaUrl = mediaUrl.replace('video.twimg.com', 'cdn.nonoka.online/x/video');
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

