import { printError } from '@/utils/print';
import { botConfig } from '@/core/nnkConfig';
import axios from 'axios';


export async function getTTSAudio(text: string) {
  const nnkServiceConfig = botConfig.nonokaService;
  const authorization = `Bearer ${nnkServiceConfig.apiKey}`;

  const url = `${nnkServiceConfig.baseUrl}/v1/audio/speech`;

  try {
    const response = await axios.post(
      url,
      { input: text },
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

  return null;
}
