import Axios from 'axios';
import Cheerio from 'cheerio';
import { botConfig } from '@/core/nnkConfig';
import { getImgCode } from '@/utils/msgCode';
import { printError } from '@/utils/print';

enum SnDBEnum {
  ALL = 999,
  PIXIV = 5,
  DANBOORU = 9,
  BOOK = 18,
  ANIME = 21,
}

interface ISaucenaoResult {
  header: {
    similarity: string,
    thumbnail: string,
    index_name: string
  },
  data: {
    ext_urls: string[],
    title: string,
    pixiv_id: number,
    member_name: string,
    member_id?: string,
    author_name: string,
    jp_name: string,
    creator?: string,
    source?: string,
  }
}

interface ISaucenaoResponse {
  header: any,
  results: ISaucenaoResult[]
}

/**
 * saucenao搜索
 *
 * @param {string} imgURL 图片地址
 */
export default async function saucenaoSearch(imgURL: string) {
  let res: ISaucenaoResult;
  const ret = await saucenaoFetch(imgURL);
  if (ret === null) {
    return {
      success: false,
      msg: '',
    };
  }
  if (ret.data?.results && ret.data?.results.length > 0) {
    res = ret.data.results[0] || {};
  } else {
    printError('[Saucenao Error] API Error');
    return {
      success: false,
      msg: '',
    };
  }

  // 解析对象结构
  const {
    header: {
      similarity,
      thumbnail,
    } = {},
    data: {
      ext_urls: extUrls = [],
      title,
      pixiv_id: pixivId,
      member_name,
      member_id,
      author_name,
      source,
      creator,
      jp_name,
    } = {},
  } = res;

  let isAnime = false;
  let isBook = false;
  let url = extUrls[0] || '';

  // url处理
  if (pixivId) {
    url = `https://pixiv.net/i/${pixivId}`;
  } else {
    // url有多个时优先处理逻辑
    const pidRegExpRes = /pixiv.+illust_id=([0-9]+)/.exec(url);
    if (extUrls.length > 0) {
      for (const u of extUrls) {
        if (pidRegExpRes) {
          url = `https://pixiv.net/i/${pidRegExpRes[1]}`;
          break;
        }
        if (u.indexOf('danbooru') !== -1) {
          url = u;
          break;
        }
      }
    }
    url = url.replace('http://', 'https://');
  }

  // danbooru和konachan特殊处理，拿到源url
  if (url.includes('danbooru')) {
    const danbooruSourceUrl = await getDanbooruSource(url);
    if (danbooruSourceUrl && danbooruSourceUrl.length > 0) {
      url = danbooruSourceUrl;
    }
  } else if (url.includes('konachan')) {
    const konachanSourceUrl = await getKonachanSource(url);
    if (konachanSourceUrl && konachanSourceUrl.length > 0) {
      url = konachanSourceUrl;
    }
  }

  // 结果类型判断
  isAnime = url.indexOf('anidb.net') !== -1;
  if (jp_name && jp_name.length > 0) {
    isBook = true;
  }

  // 标题处理
  let displayTitle = '';
  if (title) {
    if (member_name || author_name) {
      displayTitle = `「${title}」/「${member_name || author_name}」`;
    } else {
      displayTitle = `「${title}」`;
    }
  } else if (jp_name) {
    displayTitle = jp_name;
  } else if (source) {
    displayTitle = source;
  } else {
    displayTitle = isAnime ? '[AniDB]' : '[NnkDB]';
  }

  // 生成消息文本
  const msgArr = [`${displayTitle}\n相似度达到了${similarity}%`];
  if (thumbnail) {
    msgArr.push(getImgCode(thumbnail));
  }
  msgArr.push(url);
  if (creator) {
    msgArr.push(`作者: ${creator}`);
  }
  if (member_id) {
    msgArr.push(`作者主页: https://www.pixiv.net/u/${member_id}`);
  }
  // msg = getShareCode(url, displayTitle, contentText, thumbnail);
  const msg = msgArr.join('\n');

  return {
    success: true,
    msg,
    isAnime,
    isBook,
    similarity,
    details: {
      jp_name,
      thumbnail,
    },
  };
}


/**
 * saucenao请求
 */
function saucenaoFetch(imgURL: string) {
  const params = {
    api_key: botConfig.apiKeys.saucenao,
    db: SnDBEnum.ALL, // 搜索的DB
    output_type: 2, // API返回方式，2=JSON
    numres: 1, // 结果数量
    url: imgURL,
  };
  return Axios.get<ISaucenaoResponse>('https://saucenao.com/search.php', {
    params,
    responseType: 'json',
    timeout: 8000,
  }).catch((error) => {
    printError(`[Saucenao Error] Fetch Error: ${error.message}`);
    return null;
  });
}

/**
 * 从danbooru获取源url
 */
async function getDanbooruSource(url: string) {
  const ret = await Axios.get(url, {
    responseType: 'text',
    timeout: 8000,
  }).catch((error) => {
    printError(`[Danbooru Error] Fetch Error: ${error.message}`);
    return null;
  });
  const $ = Cheerio.load(ret?.data || '');
  const source = $('#content .image-container').attr('data-normalized-source');
  return source;
}

/**
 * 从konachan获取源url
 */
async function getKonachanSource(url: string) {
  const ret = await Axios.get(url, {
    responseType: 'text',
    timeout: 8000,
  }).catch((error) => {
    printError(`[Konachan Error] Fetch Error: ${error.message}`);
    return null;
  });
  const $ = Cheerio.load(ret?.data || '');
  let source: string | undefined;
  $('#stats li').each((i, e) => {
    if (/^Source:/.exec($(e).text())) {
      source = $(e).find('a').attr('href');
    }
  });
  return source;
}
