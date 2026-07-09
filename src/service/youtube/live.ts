import Axios from 'axios';
import { printError } from '@/utils/print';
import nnkbot from '@/core/nnkBot';

export interface YoutubeLiveStatus {
  isLive: boolean;
  videoId?: string;
  title?: string;
  thumbnail?: string;
}

export async function getYoutubeLiveStatus(channelId: string): Promise<YoutubeLiveStatus | null> {
  const { baseUrl, apiKey } = nnkbot.config.nonokaService;
  const url = `${baseUrl}/youtube/live-status/${channelId}?apikey=${apiKey}`;

  try {
    const res = await Axios.get(url, { timeout: 20000 });
    if (!res.data?.success) return null;
    return res.data as YoutubeLiveStatus;
  } catch (e) {
    printError(`[NonokaService] getYoutubeLiveStatus API Error (${channelId}): ${e.message}`);
    return null;
  }
}
