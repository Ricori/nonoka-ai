import Axios from 'axios';
import { printError } from '@/utils/print';
import yorubot from '@/core/yoruBot';
import { translateText } from '@/service/llm';

export interface TweetPost {
  username: string;
  userScreenName: string;
  userPofile: string;
  time: number;
  link: string;
  tweetText: string;
  translatedText: string;
  imgUrls: string[];
  videoUrls: string[];
}
function getTweetId(url: string) {
  const m = url.match(/status\/(\d+)/);
  return m ? m[1] : null;
}
function getTimestampFromTweetId(id: string) {
  // 逆向推特的Snowflake算法
  let temp = BigInt(id).toString(2);
  temp = temp.slice(0, temp.length - 22);
  return parseInt(temp, 2) + 1288834974657;
}

let consecutiveFailCount = 0;

export async function getLatestTweet(username: string) {
  const yoruServiceConfig = yorubot.config.yoruService;
  const yoruURL = `${yoruServiceConfig.baseUrl}/tweets/top/${username}?apikey=${yoruServiceConfig.apiKey}`;

  for (let i = 0; i < 2; i++) {
    try {
      const ret = await Axios.get(yoruURL, { timeout: 15000 });
      if (ret?.data?.success === false) {
        throw new Error('[yoru-service] getLatestTweet API Error.');
      }
      if (ret?.data && ret.data.list?.length > 0) {
        const urlList = ret.data.list;
        const tweetId = getTweetId(urlList[0]);
        if (!tweetId) return undefined;
        const time = getTimestampFromTweetId(tweetId);
        return {
          tweetId,
          time,
        };
      }
      return undefined;
    } catch (e: any) {
      const errorMsg = `[GetLatestTweet Warn] ${e.message}`;
      if (i === 1) {
        consecutiveFailCount++;
        if (consecutiveFailCount % 5 === 0) {
          printError(`${errorMsg} - All attempts failed x${consecutiveFailCount}.`);
          yorubot.sendPrivateMsg(yorubot.config.admin[0], `GetLatestTweet All attempts failed x${consecutiveFailCount}. reason: ${e.message}`);
        }
        return undefined;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 1000);
      });
    }
  }

  return undefined;
}

export async function getTweetPost(tweetId: string, translate = true) {
  const ret2 = await Axios.get(`https://api.vxtwitter.com/tt/status/${tweetId}`, { timeout: 15000 }).catch((e) => {
    printError(`[Vxtwitter Error] Fetch Error: ${e.message}`);
    return null;
  });
  if (ret2?.data) {
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
  const userPofile: string = apiResponse.user_profile_image_url?.replace('pbs.twimg.com', 'pbs-twimg-cdn.kvv.me');
  const imgUrls: string[] = [];
  const videoUrls: string[] = [];

  let tweetText = '';
  let translatedText = '';
  if (apiResponse.text) {
    tweetText = apiResponse.text;
  }
  if (tweetText && translate) {
    translatedText = await translateText(tweetText);
  }

  for (const [_i, media] of apiResponse.media_extended.entries()) {
    let mediaUrl: string = media.url || '';
    if (media.type === 'image') {
      mediaUrl = mediaUrl.replace('pbs.twimg.com', 'pbs-twimg-cdn.kvv.me');
      imgUrls.push(mediaUrl);
    } else if (media.type === 'video' || media.type === 'gif') {
      mediaUrl = mediaUrl.replace('video.twimg.com', 'video-twimg-cdn.kvv.me');
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
    userPofile,
  };
  return post;
}

