import { printError } from '@/utils/print';
import nnkbot from '@/core/nnkBot';
import axios from 'axios';


export async function getTTSAudio(text: string) {
  const nnkServiceConfig = nnkbot.config.nonokaService;
  const authorization = `Bearer ${nnkServiceConfig.apiKey}${nnkServiceConfig.apiKey}${nnkServiceConfig.apiKey}${nnkServiceConfig.apiKey}`;
  try {
    const response = await axios.post(
      'https://genie-tts-api-swotmwpmpu.cn-shanghai.fcapp.run/tts',
      { text },
      {
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
        },
        responseType: 'arraybuffer',
      },
    );
    const base64Audio = Buffer.from(response.data).toString('base64');
    return `base64://${base64Audio}`;
  } catch (error) {
    printError(`[NonokaSystem] TTS failed: ${error}`);
  }
  return undefined;
}
