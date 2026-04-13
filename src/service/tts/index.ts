import { printError } from '@/utils/print';
import nnkbot from '@/core/nnkBot';
import axios from 'axios';


export async function getTTSAudio(text: string) {
  const nnkServiceConfig = nnkbot.config.nonokaService;
  const authorization = `Bearer ${nnkServiceConfig.apiKey}${nnkServiceConfig.apiKey}${nnkServiceConfig.apiKey}${nnkServiceConfig.apiKey}`;

  const urls = [
    'https://genie-tts-api-swotmwpmpu.cn-shanghai.fcapp.run/tts',
    'https://ricori--genie-tts-api-fastapi-app.modal.run/tts',
  ];

  // Randomly shuffle URLs
  const shuffledUrls = Math.random() < 0.5 ? urls : [urls[1], urls[0]];

  for (const url of shuffledUrls) {
    try {
      const response = await axios.post(
        url,
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
      printError(`[NonokaSystem] TTS failed with ${url}: ${error}`);
    }
  }
  return null;
}
