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

/** 服务端上限，超出直接 400 */
export const TTS_MAX_TEXT_LENGTH = 300;

export async function getTTSAudio(text: string, options: TTSOptions = {}) {
  const input = text.trim();
  if (!input || input.length > TTS_MAX_TEXT_LENGTH) return null;

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
