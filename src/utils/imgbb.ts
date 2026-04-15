import { printError } from '@/utils/print';
import Axios from 'axios';
import FormData from 'form-data';


export async function imgTransferToImgbb(imgUrl: string) {
  const imgBuffer = await Axios.get(imgUrl, { responseType: 'arraybuffer' }).then((r) => r.data).catch((e) => {
    printError(`[AiModule Error] Can't fetch QQ img. Error: ${e.message}`);
    return null;
  });
  if (!imgBuffer) return null;
  const form = new FormData();
  form.append('image', imgBuffer, 'image');
  const ret = await Axios.post('https://api.imgbb.com/1/upload', form, {
    params: {
      key: 'a8a68ddaf156ea21809cf39d6c7481c8',
      expiration: 86400 * 7,
    },
  }).catch((e) => {
    printError(`[AiModule Error] Cant't upload file to imgbb. Error: ${e.message}`);
    return null;
  });
  if (!ret || !ret?.data?.success || !ret?.data?.data?.url) return null;
  const convertedImgUrl: string = ret.data.data.url;
  return convertedImgUrl;
}
