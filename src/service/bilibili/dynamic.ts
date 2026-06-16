import Axios from 'axios';
import { printLog } from '@/utils/print';
import { getImgCode } from '@/utils/msgCode';

interface CardItem {
  desc: any;
  card: any;
  extend_json: any;
  extra: any;
  display: any;
}
interface RssItem {
  title: string;
  author?: string;
  category?: string | string[];
  link: string;
  description: string;
  guid?: string;
  pubDate?: number;
  images?: string[];
  enclosure_url?: string;
  enclosure_length?: string;
  enclosure_type?: string;
}
export interface Post {
  title: string;
  link: string;
  description: string;
  images: string[];
  pubDate: number;
  dylink: string;
}

export default async function getBiliDynamic(uid: string, myBiliCookie: string) {
  const result = (await Axios.get('https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/space_history', {
    params: {
      host_uid: uid,
    },
    headers: {
      cookie: myBiliCookie,
    },
  }).catch((err) => {
    printLog(`[Service Error] GetBiliDynamic API Error: ${err.message}`);
  }) ?? {}).data;

  if (result && result.data && result.data.cards?.length > 0) {
    const card = result.data.cards[0] as CardItem;
    const uname = card.desc?.user_profile?.info?.uname || '';
    const item = getItem(card);

    let title = '';
    if (item?.title) {
      if (item.title.startsWith('【')) {
        title = item.title;
      } else {
        title = `【${item.title}】`;
      }
    } else {
      title = `【${uname} 发新动态啦！】`;
    }

    const post = {
      title,
      link: `https://space.bilibili.com/${uid}/#/dynamic`,
      description: item?.description || '',
      images: item?.images ?? [],
      pubDate: item?.pubDate ?? 0,
      dylink: item?.link ?? '',
    } as Post;

    return post;
  }

  return undefined;
}



/*
注意1：以下均以card为根对象
注意2：直接动态没有origin，转发动态有origin
注意3：转发动态格式统一为：
    - user.uname: 用户名
    - item.content: 正文
    - item.tips: 原动态结果(例如：源动态已被作者删除、图文资源已失效)
    - origin: 与原动态一致
注意4：本总结并不保证完善，而且未来B站可能会修改接口，因此仅供参考
B站的动态种类繁多，大致可以总结为以下几种：
desc.type
转发：type = 1
- 文字动态 type = 4
    - user.uname: 用户名
    - item.content: 正文
- 图文动态 type = 2
    - user.name: 用户名
    - item.title: 标题
    - item.description: 简介
    - item.pictures: { img_src: String }[] 图片数组，图片地址在每项的 img_src 中
- 视频动态 type = 8
    - aid: av号（以card为根对象没有bv号）
    - owner.name :用户名
    - pic: 封面
    - title: 视频标题
    - desc: 视频简介
- 专栏动态 type = 64
    - author.name: 用户名
    - image_urls: String[] 封面数组
    - id: cv号
    - title: 标题
    - summary: 简介
- 音频动态 type = 256
    - id: auId 音频id
    - upper: 上传的用户名称
    - title: 音频标题
    - author: 音频作者
    - cover: 音频封面
- 投票动态
    - user.uname: 用户名
    - item.content: 正文
- 活动专题页 type = 2048
    - user.uname 用户名
    - vest.content 正文
    - sketch.title 活动标题
    - sketch.desc_text 活动简介
    - sketch.cover_url 活动封面
    - sketch.target_url 活动地址
- 番剧/电视剧/电影等专题页
    - cover 单集封面
    - index_title 单集标题
    - url 视频地址
    - apiSeasonInfo.title 番剧名称
    - apiSeasonInfo.cover 番剧封面
- 直播间动态
    - roomid 直播间id
    - uname 用户名
    - title 直播间标题
    - cover 直播间封面
- 付费课程
    - id 课程编号
    - cover 封面
    - title 标题
    - subtitle 副标题
    - up_info.name 用户名
    - up_id 用户Id
    - update_info 更新状态
    - url 地址
*/


function getItem(item: any) {
  let card;
  try {
    card = JSON.parse(item.card || {});
  } catch {
    return;
  }
  const itemData = card.item || card;
  const { origin } = card;
  // img
  let images: string[] = [];
  const getImgs = (data: any) => {
    const imgs: string[] = [];
    // 动态图片
    if (data.pictures) {
      for (let i = 0; i < data.pictures.length; i++) {
        imgs.push(data.pictures[i].img_src);
      }
    }
    // 专栏封面
    if (data.image_urls) {
      for (let i = 0; i < data.image_urls.length; i++) {
        imgs.push(data.image_urls[i]);
      }
    }
    // 视频封面
    if (data.pic) {
      imgs.push(data.pic);
    }
    // 音频/番剧/直播间封面
    if (data.cover) {
      imgs.push(data.cover);
    }
    // 专题页封面
    if (data?.sketch?.cover_url) {
      imgs.push(data.sketch.cover_url);
    }
    return imgs;
  };

  images = images.concat(getImgs(itemData));

  if (origin) {
    images = images.concat(getImgs(origin.item || origin));
  }
  // link
  let link = '';
  if (itemData.dynamic_id_str) {
    link = `https://t.bilibili.com/${itemData.dynamic_id_str}`;
  } else if (item?.desc?.dynamic_id_str) {
    link = `https://t.bilibili.com/${item.desc.dynamic_id_str}`;
  }
  const getTitle = (data: any) => data.title || '';
  const getDes = (data: any) => {
    if (!data) {
      return '';
    }
    let des = data.desc || data.description || data.content || data.summary || (data?.vest?.content ? data.vest.content : '') + (data?.sketch ? `\n${data.sketch?.title}\n${data.sketch?.desc_text}` : '') || data.intro || data.update_info || '';

    if (des.length > 150) {
      des = `${des.substring(0, 150)}...`;
    }
    if (item?.display?.emoji_info) {
      const emoji = item?.display?.emoji_info?.emoji_details;
      emoji?.forEach((e: any) => {
        des = des.replace(
          new RegExp(`\\${e.text}`, 'g'),
          getImgCode(`${e.url}@48w_48h.png`),
        );
      });
    }

    return des;
  };
  const getOriginDes = (data: any) => {
    if (!data) {
      return '';
    }
    let text = '';
    if (data?.apiSeasonInfo?.title) {
      text += `\n//转发自: ${data.apiSeasonInfo.title}`;
    }
    if (data?.index_title) {
      text += `\n${data.index_title}`;
    }
    return text;
  };
  const getOriginName = (data: any) => data.uname || data.author?.name || data.upper || data.user?.uname || data.user?.name || data?.owner?.name || data?.up_info?.name || '';
  const getOriginTitle = (data: any) => {
    if (!data) {
      return '';
    }
    let title = '';
    if (data?.title) {
      title += `${data.title}\n`;
    }
    if (data?.subtitle) {
      title += `${data.subtitle}\n`;
    }
    return title;
  };
  const getUrl = (data: any) => {
    if (!data) {
      return '';
    }
    // const type: number = item?.desc?.type;
    if (data.aid) {
      const bvid = item?.desc?.bvid || item?.desc?.origin?.bvid;
      return `\n视频地址：https://www.bilibili.com/video/${bvid}`;
    }
    if (data.image_urls) {
      return `\n专栏地址：https://www.bilibili.com/read/cv${data?.id}`;
    }
    if (data.upper) {
      return `\n音频地址：https://www.bilibili.com/audio/au${data?.id}`;
    }
    if (data.roomid) {
      return `\n直播间地址：https://live.bilibili.com/${data?.roomid}`;
    }
    if (data.sketch) {
      return `\n活动地址：${data?.sketch?.target_url}`;
    }
    if (data.url) {
      return `\n地址：${data?.url}`;
    }
    return '';
  };

  const des = getDes(itemData);

  let originDes = '';
  if (origin && getOriginName(origin)) {
    originDes = `\n//@${getOriginName(origin)}: ${getOriginTitle(origin.item || origin)}${getDes(origin.item || origin)}`;
  } else {
    originDes = getOriginDes(origin);
  }

  return {
    title: getTitle(itemData),
    link,
    description: `${des}${originDes}${getUrl(itemData)}`,
    images,
    pubDate: Number(item.desc.timestamp * 1000),
  } as RssItem;
}
