import Axios from 'axios';
import nnkbot from '@/core/nnkBot';
import { EventKind, ModuleContext, NonokaModule } from '@/core/nnkModule';
import { GroupMessageData, PrivateMessageData } from '@/types/event';
import { sleep } from '@/utils/function';
import { getImgCode } from '@/utils/msgCode';
import { printError } from '@/utils/print';


enum HPicLevel {
  /** All ages */
  SAFE = 0,
  /** R18 Only */
  R18 = 1,
  /** All ages and R18 mixed */
  MIX = 2,
}

class HPicModule extends NonokaModule<PrivateMessageData | GroupMessageData> {
  readonly name = 'HPicModule';

  readonly events: EventKind[] = ['private', 'group'];

  match(ctx: ModuleContext<PrivateMessageData | GroupMessageData>) {
    if (!nnkbot.config.hPic.enable) return false;
    const { message } = ctx.data;
    const { whiteGroupIds } = nnkbot.config.hPic;
    // Check if the group is in the whitelist or if it's a private message
    const groupId = ctx.data.message_type === 'group' ? ctx.data.group_id : undefined;
    const hasPermissions = !groupId || whiteGroupIds.includes(groupId);
    return hasPermissions && /((要|发|份|点|张)大?(色|h|瑟|涩)图)/.test(message);
  }

  async run(ctx: ModuleContext<PrivateMessageData | GroupMessageData>) {
    const { message } = ctx.data;
    const { enableR18 } = nnkbot.config.hPic;

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
    const API_URI = 'https://api.lolicon.app/setu/?apikey=170792005f99b428151719';
    const ret = await Axios.get(`${API_URI}&r18=${level}&num=${count}&excludeAI=true`);

    if (ret.data?.code !== 0 || !ret.data?.data?.length) {
      printError('[GetHpic API] getHpic API Error.');
      ctx.reply('色图库炸了！');
      return;
    }

    const imgUrls = ret.data.data.map((item: any) => item.url);

    // Send images
    for (const url of imgUrls) {
      ctx.reply(getImgCode(url));
      await sleep(4000);
    }
  }
}

export default new HPicModule();
