import { printError } from '@/utils/print';
import { botConfig } from '@/core/nnkConfig';
import axios from 'axios';

export type TTSLang = 'ja' | 'zh';

export interface TTSOptions {
  /** 合成语言，服务端默认 ja，中文文本必须显式传 zh */
  lang?: TTSLang;
  /** 语速 0.6–1.5 */
  speed?: number;
  /** 随机种子，-1 为每次随机；传回上次的 seed 可复现同一段音频 */
  seed?: number;
}

/** 服务端单次请求上限，超出直接 400 */
export const TTS_MAX_TEXT_LENGTH = 300;

/**
 * 切块合成的总字数上限。服务端只有一个 GPU 容器、一次只处理一个请求，
 * 切出来的块越多 GPU 被独占越久，期间别的群连短句语音都得排队，
 * 所以这里要有个闸。900 字约三块、三分钟音频，再长就不值得发语音了。
 */
export const TTS_MAX_TOTAL_LENGTH = 900;

/** 优先在句末切，切不开再用句中停顿 */
const BREAK_PATTERNS = [/(?<=[。！？!?…；;\n])/, /(?<=[，,、：:])/];

/** 按 pattern 拆成最小单元，再贪心装回不超过 limit 字的块 */
function packBy(text: string, pattern: RegExp, limit: number) {
  const chunks: string[] = [];
  let buf = '';
  for (const unit of text.split(pattern)) {
    if (buf && buf.length + unit.length > limit) {
      chunks.push(buf);
      buf = '';
    }
    buf += unit;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/** 整段没有标点时的兜底，按码点累加避免把 emoji 的代理对劈成两半 */
function hardSlice(text: string, limit: number) {
  const chunks: string[] = [];
  let buf = '';
  for (const char of text) {
    if (buf.length + char.length > limit) {
      chunks.push(buf);
      buf = '';
    }
    buf += char;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/**
 * 把长文本按标点切成不超过 limit 字的块。服务端自己也会按标点切句（cut5），
 * 但它只认一次请求 300 字，所以超出的部分必须在这边切开分多次请求。
 */
export function splitForTTS(text: string, limit = TTS_MAX_TEXT_LENGTH) {
  let chunks = [text.trim()];
  for (const pattern of BREAK_PATTERNS) {
    if (chunks.every((chunk) => chunk.length <= limit)) break;
    chunks = chunks.flatMap((chunk) => (chunk.length <= limit ? [chunk] : packBy(chunk, pattern, limit)));
  }
  return chunks
    .flatMap((chunk) => (chunk.length <= limit ? [chunk] : hardSlice(chunk, limit)))
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

export async function getTTSAudio(text: string, options: TTSOptions = {}) {
  const input = text.trim();
  if (!input) return null;
  if (input.length > TTS_MAX_TEXT_LENGTH) {
    // 服务端会直接 400，别浪费一次往返；长文本应该走 sendSegmentedVoice
    printError(`[NonokaSystem] TTS text too long: ${input.length} > ${TTS_MAX_TEXT_LENGTH}`);
    return null;
  }

  const nnkServiceConfig = botConfig.nonokaService;
  const authorization = `Bearer ${nnkServiceConfig.apiKey}`;

  const url = `${nnkServiceConfig.baseUrl}/v1/audio/speech`;

  try {
    const response = await axios.post(
      url,
      { input, ...options },
      {
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
        },
        responseType: 'arraybuffer',
        timeout: 180000,
      },
    );
    const base64Audio = Buffer.from(response.data).toString('base64');
    return `base64://${base64Audio}`;
  } catch (error) {
    printError(`[NonokaSystem] TTS failed with ${url}: ${decodeError(error) ?? error}`);
  }

  return null;
}

export interface SegmentedVoiceResult {
  /** 已经交给 send 的音频条数 */
  sent: number;
  /** 合成失败、没发出去的剩余文本，全部成功时是空串 */
  rest: string;
}

/**
 * 长文本切块串行合成并逐条发送，返回发了几条、还剩多少没发。
 *
 * 串行是服务端要求的（单 GPU 容器、一次一个请求，并发只会在 Modal 侧排队）；
 * 每块合成完立刻发出去，不等整段做完，免得群里干等几十秒。
 * 中途失败就停下，剩余文本交回调用方处理，别让 GPU 继续为一个已经断掉的回复干活。
 */
export async function sendSegmentedVoice(
  text: string,
  send: (audio: string) => unknown,
  options: TTSOptions = {},
): Promise<SegmentedVoiceResult> {
  const input = text.trim();
  if (!input) return { sent: 0, rest: '' };
  if (input.length > TTS_MAX_TOTAL_LENGTH) {
    printError(`[NonokaSystem] TTS skipped: ${input.length} chars over ${TTS_MAX_TOTAL_LENGTH}`);
    return { sent: 0, rest: input };
  }

  const chunks = splitForTTS(input);
  // 固定种子才能让每块音色一致。服务端把实际种子放在 x-seed 响应头上，
  // 但这里拿不到响应头，所以自己先定一个（0 是随机种子的保留值，从 1 开始）
  const seed = options.seed ?? Math.floor(Math.random() * 2 ** 31) + 1;

  for (let i = 0; i < chunks.length; i++) {
    const audio = await getTTSAudio(chunks[i], { ...options, seed });
    if (!audio) {
      return { sent: i, rest: chunks.slice(i).join('') };
    }
    await send(audio);
  }

  return { sent: chunks.length, rest: '' };
}

// responseType 是 arraybuffer，失败时正文也是二进制，原因得自己解出来
function decodeError(error: unknown): string | undefined {
  const data = (error as { response?: { data?: unknown } })?.response?.data;
  if (!data) return undefined;
  try {
    const body = JSON.parse(Buffer.from(data as ArrayBuffer).toString('utf8'));
    return typeof body?.error === 'string' ? body.error : undefined;
  } catch {
    return undefined;
  }
}
