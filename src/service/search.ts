import Axios from 'axios';
import { botConfig } from '@/config';
import { printError } from '@/utils/print';

/**
 * 联网搜索。和 LLM 一样只负责转发给 nonoka API 服务，
 * 搜索上游和它的 key 都只存在服务端——bot 跑在墙内，出口必须借服务端的
 */

/** 服务端那侧给了 12s，这里留点余量给网络往返 */
const SEARCH_TIMEOUT = 15000;

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  /** 发布日期，只有新闻类结果才有 */
  date?: string;
  /** 站点域名 */
  site?: string;
}

export interface SearchResult {
  /** 上游直接给出的一句话答案，可能没有 */
  answer?: string;
  hits: SearchHit[];
}

export interface SearchOptions {
  count?: number;
  /** 'news' 时只搜新闻，默认 general */
  topic?: string;
  /** day / week / month / year，不填不限时间 */
  timeRange?: string;
}

function getServiceUrl(path: string) {
  const { baseUrl, apiKey } = botConfig.nonokaService;
  return `${baseUrl}${path}?apikey=${apiKey}`;
}

/**
 * 搜一次。失败返回 null，与「搜到了但没结果」的空 hits 区分开——
 * 前者要告诉模型是查询出错，后者是确实没搜到，两种说法不一样
 */
export async function searchWeb(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult | null> {
  const ret = await Axios.post(getServiceUrl('/search'), { query, ...options }, {
    timeout: SEARCH_TIMEOUT,
  }).catch((e) => {
    printError(`[Search error] ${e.message}`);
    return null;
  });

  const results = ret?.data?.results;
  if (!Array.isArray(results)) return null;
  return { answer: ret?.data?.answer, hits: results };
}
