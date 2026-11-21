import Axios from 'axios';
import FormData from 'form-data';
import sharp from 'sharp';
import { botConfig } from '@/config';
import { sleep } from '@/utils/function';
import { printError, printLog } from '@/utils/print';

/**
 * 图片生成，直连上游（gpt-image-2）。
 */

/** 实测出图 60~150s，留到 300s。后台出图不阻塞对话，等久点没关系 */
const IMAGE_TIMEOUT = 300000;

/** 拉底图/取回成品图的超时，只是普通下载 */
const FETCH_TIMEOUT = 30000;

function getUpstreamUrl(path: string) {
  return `${botConfig.apiKeys.imageGen.baseUrl}${path}`;
}

function getAuthHeader() {
  return { Authorization: `Bearer ${botConfig.apiKeys.imageGen.apiKey}` };
}

/** 上游的失败原因（余额不足、内容审核等）都在 body 里，只打 message 等于什么都没说 */
function describeError(e: any) {
  const data = e?.response?.data;
  return data ? `${e.message} - ${JSON.stringify(data).slice(0, 300)}` : e.message;
}

/** 一次出图的结果 */
export interface ImageResult {
  /** 成功时是 `base64://xxx`，失败为 null */
  file: string | null;
  /** 是否被上游内容审核拦下。拦了就别原样重试，得换个说法 */
  blocked: boolean;
}

/** 内容审核的说辞。上游是中文壳子套 OpenAI，两种口径都要认 */
const BLOCK_PATTERNS = /安全政策|内容政策|审核|拦截|不适合|safety|content[_ ]?policy|moderation/i;

/** 400 才可能是内容拦截；余额不足、限流之类的别误判成拦截，那些原样重试是有意义的 */
function isContentBlocked(e: any): boolean {
  if (e?.response?.status !== 400) return false;
  return BLOCK_PATTERNS.test(JSON.stringify(e.response.data ?? ''));
}

/** 重试前先等一会儿。上游对连发的出图请求会直接 ban，贴着重试等于自找封禁 */
const RETRY_DELAY = 5000;

/**
 * 值不值得重试。
 *
 * 只认 5xx 和网络层错误：4xx 都是确定性的（内容拦截、鉴权、额度），重来一次还是同样的结果。
 * 超时也不重试——已经等了 240s，再来一轮群友早就散了
 */
function isRetryable(e: any): boolean {
  const status = e?.response?.status;
  if (status) return status >= 500;
  return e?.code !== 'ECONNABORTED';
}

/**
 * 跑一次请求，失败且值得重试就隔几秒再来一次，只重一次。
 *
 * send 每次都要重新构造请求：改图那条路 FormData 是流，
 * 同一个实例发第二次时内容已经被读空了
 */
async function withRetry<T>(send: () => Promise<T>, label: string): Promise<T> {
  try {
    return await send();
  } catch (e: any) {
    if (!isRetryable(e)) throw e;
    printLog(`[ImageGen] ${label}上游抽风(${e?.response?.status ?? e?.code ?? e.message})，${RETRY_DELAY / 1000}s 后重试一次`);
    await sleep(RETRY_DELAY);
    return send();
  }
}

/**
 * 年龄和年级是内容审核最容易卡的点：人设是高中生，模型写自画像时几乎每次都带上，
 * 而画风本身就决定了角色看起来多大，写了纯属给自己找麻烦，发之前统一抹掉。
 *
 * 中英文都要拦——模型是随机挑语言写 prompt 的，只拦中文等于没拦。
 * 「高中」这类词在别的语境下（比如「提高中间调」）会被误伤，但画图 prompt 里基本不会出现
 */
const AGE_PATTERNS = [
  /\d+\s*[岁歳](的)?/g,
  /[高初][一二三中]\s*(的)?(女?生|学生)?/g,
  /小学生/g,
  /未成年/g,
  /\bJK\b/gi,
  /\b\d+[\s-]*(year|yr)[\s-]*old[\s-]*(girl|boy|child)?/gi,
  /\b(high|middle|junior|senior|elementary|primary)[\s-]*school(er|s)?\b/gi,
  /\bschool[\s-]*(girl|boy|kid|child)s?\b/gi,
  /\b(teen|teenage|teenaged|teenager|preteen|underage|loli)s?\b/gi,
  /\bgrade\s*\d+\b/gi,
  /\b\d+(st|nd|rd|th)[\s-]*graders?\b/gi,
];

export function sanitizePrompt(prompt: string): string {
  const stripped = AGE_PATTERNS.reduce((acc, re) => acc.replace(re, ''), prompt);
  // 抹完会留下「，，」、连续空格和标点前的空档，收拾干净再发
  return stripped
    .replace(/[，,]\s*(?=[，,])/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,，.。])/g, '$1')
    .replace(/^[\s，,]+|[\s，,]+$/g, '')
    .trim();
}

/** 上游偶尔用 200 带 error 返回失败，不认出来会被当成「没图」静默吞掉 */
async function toResult(data: any): Promise<ImageResult> {
  if (data?.error) {
    printError(`[ImageGen] 上游返回错误: ${JSON.stringify(data.error)}`);
    return { file: null, blocked: BLOCK_PATTERNS.test(JSON.stringify(data.error)) };
  }
  return { file: await normalizeToBase64(data), blocked: false };
}

/**
 * 统一把上游返回归一化成 `base64://xxx`，可以直接塞进图片 CQ 码。
 *
 * 上游可能返 b64_json 也可能只返一个 url，后者不能直接丢给 QQ——
 * 那个域名从客户端不一定连得上，还是本地下下来再发更稳
 */
async function normalizeToBase64(data: any): Promise<string | null> {
  const first = data?.data?.[0];
  if (!first) return null;

  if (typeof first.b64_json === 'string' && first.b64_json.length > 0) {
    return `base64://${first.b64_json}`;
  }

  if (typeof first.url === 'string' && first.url.length > 0) {
    const buffer = await fetchImageBuffer(first.url);
    if (buffer) return `base64://${buffer.toString('base64')}`;
  }

  return null;
}

/** 下载一张图，失败返回 null */
async function fetchImageBuffer(imgUrl: string): Promise<Buffer | null> {
  const ret = await Axios.get(imgUrl, {
    responseType: 'arraybuffer',
    timeout: FETCH_TIMEOUT,
  }).catch((e) => {
    printError(`[ImageGen] 拉图失败 ${imgUrl}: ${e.message}`);
    return null;
  });

  return ret ? Buffer.from(ret.data) : null;
}

/**
 * 超过4MB就压缩
 */
const MAX_SRC_BYTES = 4 * 1024 * 1024;

/** 压过头会糊，长边 2048 对出图来说够用了 */
const MAX_SRC_EDGE = 2048;

/**
 * 底图太大就压到能发的尺寸。
 *
 * 转 JPEG 是因为 PNG 对照片几乎压不动，而这里超限的基本都是照片；
 * 压完还超（比如超长图）就再降一档质量，两次都不行只能放弃
 */
async function shrinkIfNeeded(buffer: Buffer): Promise<{ buffer: Buffer, jpeg: boolean } | null> {
  if (buffer.length <= MAX_SRC_BYTES) return { buffer, jpeg: false };

  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

  for (const quality of [82, 60]) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await sharp(buffer)
        .rotate() // 按 EXIF 摆正，否则压完方向会变
        .resize({
          width: MAX_SRC_EDGE, height: MAX_SRC_EDGE, fit: 'inside', withoutEnlargement: true,
        })
        .jpeg({ quality })
        .toBuffer();
      if (out.length <= MAX_SRC_BYTES) {
        printLog(`[ImageGen] 底图 ${mb(buffer.length)}MB 超限，压到 ${mb(out.length)}MB (q${quality})`);
        return { buffer: out, jpeg: true };
      }
    } catch (e: any) {
      printError(`[ImageGen] 底图压缩失败: ${e.message}`);
      return null;
    }
  }

  printError(`[ImageGen] 底图 ${mb(buffer.length)}MB 压不到限制以内，放弃`);
  return null;
}

/** 清理 prompt，改动了就打一行，不然线上看不出发出去的到底是什么 */
function prepare(prompt: string): string {
  const safe = sanitizePrompt(prompt);
  if (safe !== prompt) printLog(`[ImageGen] prompt 已清理年龄/年级 -> ${safe}`);
  return safe;
}

/** 文生图 */
export async function generateImage(prompt: string, size: string): Promise<ImageResult> {
  const safe = prepare(prompt);

  try {
    const res = await withRetry(() => Axios.post(getUpstreamUrl('/v1/images/generations'), {
      prompt: safe, size, n: 1, model: botConfig.apiKeys.imageGen.model,
    }, {
      headers: getAuthHeader(),
      timeout: IMAGE_TIMEOUT,
    }), '生成');
    return await toResult(res.data);
  } catch (e: any) {
    printError(`[ImageGen] 生成失败: ${describeError(e)}`);
    return { file: null, blocked: isContentBlocked(e) };
  }
}

/** 图生图：以 srcImgUrl 为底改图 */
export async function editImage(srcImgUrl: string, prompt: string, size: string): Promise<ImageResult> {
  const raw = await fetchImageBuffer(srcImgUrl);
  if (!raw) return { file: null, blocked: false };

  const src = await shrinkIfNeeded(raw);
  if (!src) return { file: null, blocked: false };

  const safe = prepare(prompt);

  // FormData 是流，发一次就读空了，重试必须重新拼一份
  const post = () => {
    const form = new FormData();
    // 上游按文件名后缀判类型，QQ 的图片链接常常不带后缀，得自己把后缀报对
    form.append('image', src.buffer, src.jpeg
      ? { filename: 'image.jpg', contentType: 'image/jpeg' }
      : { filename: 'image.png', contentType: 'image/png' });
    form.append('prompt', safe);
    form.append('size', size);
    form.append('n', '1');
    form.append('model', botConfig.apiKeys.imageGen.model);

    return Axios.post(getUpstreamUrl('/v1/images/edits'), form, {
      headers: { ...form.getHeaders(), ...getAuthHeader() },
      timeout: IMAGE_TIMEOUT,
    });
  };

  try {
    const res = await withRetry(post, '改图');
    return await toResult(res.data);
  } catch (e: any) {
    printError(`[ImageGen] 改图失败: ${describeError(e)}`);
    return { file: null, blocked: isContentBlocked(e) };
  }
}
