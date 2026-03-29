import { GroupMessageData, PrivateMessageData } from '@/types/event';
import yorubot from '@/core/yoruBot';
import {
  hasImage, hasReply, getReplyMsgId, getImgs,
} from '@/utils/function';
import searchImage from '@/service/searchImg';
import YoruModuleBase from '../base';

function hasSerachImageText(msg: string) {
  if (msg.includes('搜图') || msg.includes('来源')) {
    return true;
  }
  return false;
}

export default class ImageSearchModule extends YoruModuleBase<PrivateMessageData | GroupMessageData> {
  static NAME = 'ImageSearchModule';

  tempMessage = '';

  async checkConditions() {
    const { message } = this.data;
    if (hasReply(message)) {
      // If it is a reply message, extract the original message
      const replyMsgId = getReplyMsgId(message);
      const replyMsgData = await yorubot.getMessageFromId(replyMsgId);
      if (replyMsgData) {
        const rMsg = replyMsgData.message;
        // The image search logic is executed only when both the message contains an image
        // and the message contains a specified image search text.
        if (hasImage(rMsg) && hasSerachImageText(message)) {
          this.tempMessage = rMsg;
          return true;
        }
      }
    } else if (hasImage(message) && hasSerachImageText(message)) {
      this.tempMessage = message;
      return true;
    }
    return false;
  }

  async run() {
    const { user_id: userId, message_type: messageType } = this.data;
    const groupId = messageType === 'group' ? this.data.group_id : undefined;
    const imgsData = getImgs(this.tempMessage);
    const urls = imgsData.map((item) => item.url);

    const resultMsgs = await searchImage(urls);

    if (groupId) {
      resultMsgs.forEach((msg) => yorubot.sendGroupMsg(groupId, msg));
    } else {
      resultMsgs.forEach((msg) => yorubot.sendPrivateMsg(userId, msg));
    }
  }
}
