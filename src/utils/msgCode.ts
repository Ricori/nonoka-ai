import _ from 'lodash';

/**
 * 转义
 * @param {string} str 欲转义的字符串
 * @param {boolean} [insideCQ=false] 字符串是否放在CQ码内
 */
export const escape = (str: string, insideCQ = false) => {
  const result = str.replace(/&/g, '&amp;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');
  if (!insideCQ) return result;
  return result
    .replace(/,/g, '&#44;')
    .replace(/(\ud83c[\udf00-\udfff])|(\ud83d[\udc00-\ude4f\ude80-\udeff])|[\u2600-\u2B55]/g, ' ');
};
/**
 * 反转义
 * @param {string} str 欲反转义的字符串
 */
const unescape = (str: string) => str.replace(/&#44;/g, ',').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&');

// https://docs.go-cqhttp.org/cqcode
type CQType =
  'face' | 'record' | 'video' | 'at' | 'file' | 'shake' |
  'share' | 'music' | 'image' | 'reply' | 'redbag' |
  'poke' | 'forward' | 'node' | 'xml' | 'json' |
  'cardimage' | 'tts';

class CQCode {
  type: string;

  data: Map<string, string>;

  constructor(type: string, obj?: Record<string, string>) {
    this.type = type;
    this.data = new Map();
    if (obj) this.mset(obj);
  }

  set(key: string, value: string) {
    if (value) {
      this.data.set(key, value);
    }
    return this;
  }

  mset(obj: Record<string, string | number | undefined>) {
    Object.entries(obj).forEach(([k, v]) => {
      if (v != null) this.set(k, String(v));
    });
    return this;
  }

  pickData(keys: string[]) {
    return _.pick(Object.fromEntries(this.data.entries()), keys);
  }

  toString() {
    const list = Array.from(this.data.entries())
      .filter(([, v]) => !_.isNil(v))
      .map((kv) => kv.map((str: string) => escape(String(str), true)).join('='));
    list.unshift(`CQ:${this.type}`);
    return `[${list.join(',')}]`;
  }
}


/** string转CQ类数组 */
export function extractCQCodes(str: string) {
  const reg = /\[CQ:([^,[\]]+)((?:,[^,=[\]]+=[^,[\]]*)*)\]/g;
  const result: CQCode[] = [];
  // eslint-disable-next-line no-cond-assign
  for (let match; (match = reg.exec(str));) {
    const [, type, dataStr] = match;
    const data: Record<string, string> = {};
    for (const kv of _.filter(dataStr.split(','))) {
      const [key, ...value] = kv.split('=');
      data[unescape(key)] = unescape(value.join('='));
    }
    result.push(new CQCode(type, data));
  }
  return result;
}


/**
 * CQ码文本转换
 * @param {string} type
 * @param {object} params 参数,参照 https://docs.go-cqhttp.org/cqcode
 */
export default function getMessageCode(type: CQType, params: Record<string, string | number | undefined>) {
  const normalized = Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, v === undefined ? '' : String(v)]),
  );
  return new CQCode(type, normalized).toString();
}

export function getAtCode(qq: string) {
  return getMessageCode('at', { qq });
}

export function getReplyCode(msgId: number | string) {
  return getMessageCode('reply', { id: `${msgId}` });
}

export function getImgCode(file: string, isSticker = false) {
  if (isSticker) {
    return getMessageCode('image', { file, summary: '[动画表情]', sub_type: 1 });
  }
  return getMessageCode('image', { file });
}

export function getBigImgCode(file: string, isBase64 = false) {
  return getMessageCode('cardimage', {
    file: isBase64 ? `base64://${file}` : file,
    maxwidth: 800,
    maxheight: 1600,
    source: 'ののかちゃん',
  });
}

export function getVideoCode(file: string, cover?: string) {
  return getMessageCode('video', {
    file,
    cover,
  });
}

export function getShareCode_UNSAFE(url: string, title: string, content?: string, image?: string) {
  return getMessageCode('share', {
    url,
    title,
    content,
    image,
  });
}

export function getRecordCode(file: string) {
  return getMessageCode('record', { file });
}
