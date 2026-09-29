import Axios from 'axios';
import { printError } from '@/utils/print';
import { getImgCode } from '@/utils/msgCode';
import { sleep } from '@/utils/function';
import {
  UA, getCookie, prepareSession, signWbi,
} from './session';

export interface Post {
  title: string;
  link: string;
  description: string;
  images: string[];
  pubDate: number;
  dylink: string;
}

interface MajorInfo {
  title: string;
  text: string;
  images: string[];
  url: string;
  emojiNodes: any[];
}

const FEATURES = 'itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote';

/** 空间页前端上报的渲染指纹，缺了更容易触发 -352 */
const DM_PARAMS = {
  dm_img_list: '[]',
  dm_img_str: 'V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ',
  dm_cover_img_str: 'QU5HTEUgKEludGVsLCBJbnRlbChSKSBVSEQgR3JhcGhpY3MgNjMwICgweDAwMDAzRTlCKSBEaXJlY3QzRDExIHZzXzVfMCBwc181XzAsIEQzRDExKUdvb2dsZSBJbmMuIChJbnRlbC',
  dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
};

const DESC_LIMIT = 150;

const fullUrl = (url?: string) => (url?.startsWith('//') ? `https:${url}` : url ?? '');

async function fetchSpaceFeed(uid: string): Promise<{ items?: any[], reason?: string }> {
  const query = signWbi({
    host_mid: uid, platform: 'web', features: FEATURES, ...DM_PARAMS,
  });
  const res = await Axios.get(`https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?${query}`, {
    headers: {
      cookie: getCookie(),
      'User-Agent': UA,
      Referer: `https://space.bilibili.com/${uid}/dynamic`,
      Origin: 'https://space.bilibili.com',
    },
    timeout: 15000,
    validateStatus: () => true,
  });
  const body = res.data;
  if (typeof body !== 'object') return { reason: `HTTP ${res.status}` };
  if (body.code !== 0) return { reason: `code ${body.code} ${body.message}` };
  // 被风控时也是 code 0，只是列表为空、has_more 为 false，和真没动态分不开，一律当失败
  if (!body.data?.items?.length) return { reason: '列表为空（疑似风控）' };
  return { items: body.data.items };
}

function parseMajor(major: any): MajorInfo {
  const info: MajorInfo = {
    title: '', text: '', images: [], url: '', emojiNodes: [],
  };
  switch (major?.type) {
    case 'MAJOR_TYPE_ARCHIVE': {
      const a = major.archive;
      Object.assign(info, {
        title: a.title, text: a.desc, images: [a.cover], url: `视频地址：https://www.bilibili.com/video/${a.bvid}`,
      });
      break;
    }
    case 'MAJOR_TYPE_OPUS': {
      const o = major.opus;
      Object.assign(info, {
        title: o.title ?? '', text: o.summary?.text, images: (o.pics ?? []).map((p: any) => p.url), emojiNodes: o.summary?.rich_text_nodes ?? [],
      });
      break;
    }
    case 'MAJOR_TYPE_DRAW':
      info.images = (major.draw.items ?? []).map((i: any) => i.src);
      break;
    case 'MAJOR_TYPE_ARTICLE': {
      const a = major.article;
      Object.assign(info, {
        title: a.title, text: a.desc, images: a.covers ?? [], url: `专栏地址：https://www.bilibili.com/read/cv${a.id}`,
      });
      break;
    }
    case 'MAJOR_TYPE_LIVE_RCMD': {
      const live = JSON.parse(major.live_rcmd.content).live_play_info;
      Object.assign(info, {
        title: live.title, images: [live.cover], url: `直播间地址：https://live.bilibili.com/${live.room_id}`,
      });
      break;
    }
    case 'MAJOR_TYPE_NONE':
      info.text = major.none?.tips ?? '';
      break;
    default: {
      // live / pgc / music / common / courses 等结构都是 title + cover + jump_url
      const m = major?.[major.type?.replace('MAJOR_TYPE_', '').toLowerCase()];
      if (m) {
        Object.assign(info, {
          title: m.title ?? '', text: m.desc ?? m.sub_title ?? '', images: m.cover ? [m.cover] : [], url: m.jump_url ? `地址：${fullUrl(m.jump_url)}` : '',
        });
      }
    }
  }
  return info;
}

function parseContent(item: any) {
  const dyn = item.modules?.module_dynamic ?? {};
  const major = parseMajor(dyn.major);
  const emojiNodes = [...(dyn.desc?.rich_text_nodes ?? []), ...major.emojiNodes];

  let text = [dyn.desc?.text, major.text].filter(Boolean).join('\n').trim();
  if (text.length > DESC_LIMIT) text = `${text.substring(0, DESC_LIMIT)}...`;
  emojiNodes
    .filter((n: any) => n.type === 'RICH_TEXT_NODE_TYPE_EMOJI' && n.emoji?.icon_url)
    .forEach((n: any) => { text = text.split(n.text).join(getImgCode(`${n.emoji.icon_url}@48w_48h.png`)); });

  return {
    name: item.modules?.module_author?.name ?? '',
    major,
    text,
  };
}

function toPost(uid: string, item: any): Post {
  const self = parseContent(item);
  let description = self.text;
  let { images } = self.major;

  if (item.orig) {
    const orig = parseContent(item.orig);
    const origTitle = orig.major.title ? `${orig.major.title}\n` : '';
    description += orig.name ? `\n//@${orig.name}: ${origTitle}${orig.text}` : `\n${orig.text}`;
    images = images.concat(orig.major.images);
  }
  if (self.major.url) description += `\n${self.major.url}`;

  const { title: rawTitle } = self.major;
  let title = `【${self.name} 发新动态啦！】`;
  if (rawTitle) title = rawTitle.startsWith('【') ? rawTitle : `【${rawTitle}】`;

  return {
    title,
    link: `https://space.bilibili.com/${uid}/dynamic`,
    description,
    images: images.filter(Boolean).map(fullUrl),
    pubDate: (item.modules?.module_author?.pub_ts ?? 0) * 1000,
    dylink: `https://t.bilibili.com/${item.id_str}`,
  };
}

export default async function getBiliDynamic(uid: string): Promise<Post | undefined> {
  try {
    await prepareSession();
    let result = await fetchSpaceFeed(uid);
    if (!result.items) {
      await sleep(3000);
      result = await fetchSpaceFeed(uid);
    }
    if (!result.items) {
      printError(`[Bilibili] 获取 ${uid} 动态失败: ${result.reason}`);
      return undefined;
    }
    // 置顶动态排在第一条，按发布时间取最新的
    const latest = result.items.reduce((a, b) => (
      (b.modules?.module_author?.pub_ts ?? 0) > (a.modules?.module_author?.pub_ts ?? 0) ? b : a
    ));
    return toPost(uid, latest);
  } catch (e) {
    printError(`[Bilibili] 获取 ${uid} 动态出错: ${e.message}`);
    return undefined;
  }
}
