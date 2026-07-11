import nnkbot from '@/core/nnkBot';
import { EventKind, ModuleContext, NonokaModule } from '@/core/nnkModule';
import { GroupMessageData, PrivateMessageData } from '@/types/event';
import {
  hasImage, hasReply, getReplyMsgId, getImgs,
} from '@/utils/function';
import searchImage from '@/service/searchImg';

function hasSerachImageText(msg: string) {
  if (msg.includes('搜图') || msg.includes('来源')) {
    return true;
  }
  return false;
}

/** match 命中时传递给 run 的数据：要搜索的原始消息 */
interface SearchHit {
  searchMsg: string;
}

class ImageSearchModule extends NonokaModule<PrivateMessageData | GroupMessageData, SearchHit> {
  readonly name = 'ImageSearchModule';

  readonly events: EventKind[] = ['private', 'group:at'];

  async match(ctx: ModuleContext<PrivateMessageData | GroupMessageData>): Promise<SearchHit | false> {
    const { message } = ctx.data;
    if (!hasSerachImageText(message)) return false;

    if (hasReply(message)) {
      // If it is a reply message, extract the original message
      const replyMsgData = await nnkbot.getMessageFromId(getReplyMsgId(message));
      // The image search logic is executed only when both the message contains an image
      // and the message contains a specified image search text.
      if (replyMsgData && hasImage(replyMsgData.message)) {
        return { searchMsg: replyMsgData.message };
      }
      return false;
    }

    if (hasImage(message)) {
      return { searchMsg: message };
    }
    return false;
  }

  async run(ctx: ModuleContext<PrivateMessageData | GroupMessageData>, hit: SearchHit) {
    const urls = getImgs(hit.searchMsg).map((item) => item.url);
    const resultMsgs = await searchImage(urls);
    resultMsgs.forEach((msg) => ctx.reply(msg));
  }
}

export default new ImageSearchModule();
