import Axios from 'axios';
import { printError } from '@/utils/print';
import nnkbot from '@/core/nnkBot';

export interface YoutubeLiveStatus {
  isLive: boolean;
  videoId?: string;
  title?: string;
  thumbnail?: string;
}

export async function getYoutubeLiveStatus(channelName: string): Promise<YoutubeLiveStatus | null> {
  const { baseUrl, apiKey } = nnkbot.config.nonokaService;
  const url = `${baseUrl}/youtube/live-status/${encodeURIComponent(channelName)}?apikey=${apiKey}`;

  try {
    const res = await Axios.get(url, { timeout: 20000 });
    if (!res.data?.success) return null;
    return res.data as YoutubeLiveStatus;
  } catch (e) {
    printError(`[NonokaService] getYoutubeLiveStatus API Error (${channelName}): ${e.message}`);
    return null;
  }
}
