import { GroupMessageData, PrivateMessageData } from '@/types/event';
import NonokaModuleBase from '@/modules/base';
import nnkbot from '@/core/nnkBot';
import { sleep } from '@/utils/function';
import { getImgCode } from '@/utils/msgCode';
import Axios from 'axios';
import { printError } from '@/utils/print';


enum HPicLevel {
  /** All ages */
  SAFE = 0,
  /** R18 Only */
  R18 = 1,
  /** All ages and R18 mixed */
  MIX = 2,
}

export default class HPicModule extends NonokaModuleBase<PrivateMessageData | GroupMessageData> {
  static NAME = 'HPicModule';

  async checkConditions() {
    if (!nnkbot.config.hPic.enable) return false;
    const { message } = this.data;
    const exec = /((要|发|份|点|张)大?(色|h|瑟|涩)图)/.exec(message);
    if (exec !== null) {
      return true;
    }
    return false;
  }

  async run() {
    const { message, user_id: userId, message_type: messageType } = this.data;
    const groupId = messageType === 'group' ? this.data.group_id : undefined;
    const { whiteGroupIds, enableR18 } = nnkbot.config.hPic;

    const hasPermissions = !groupId || whiteGroupIds.length === 0 || whiteGroupIds.includes(groupId);
    if (!hasPermissions) return;

    let level = HPicLevel.SAFE;
    if (enableR18) {
      level = HPicLevel.MIX;
    }

    // Get image Count
    let count = 1;
    const countExec = /([0-9]+)[张份]/.exec(message);
    if (countExec && countExec[1]) {
      count = Number(countExec[1]);
    }
    count = count > 10 ? 10 : count;

    // Get image urls
    const nnkServiceConfig = nnkbot.config.nonokaService;
    const nnkURL = `${nnkServiceConfig.baseUrl}/hpic/get?apikey=${nnkServiceConfig.apiKey}&level=${level}&count=${count}`;
    const ret = await Axios.get(nnkURL, { timeout: 15000 });

    const imgUrls = ret.data?.list;

    if (ret?.data?.success === false || imgUrls.length === 0) {
      printError('[NonokaService] getHpic API Error.');
      nnkbot.sendMsg(groupId, userId, '色图库炸了！');
      return;
    }

    // Send images
    for (const url of imgUrls) {
      const msg = getImgCode(url);
      nnkbot.sendMsg(groupId, userId, msg);
      await sleep(4000);
    }
  }
}
