import { PrivateMessageData } from '@/types/event';
import YoruModuleBase from '@/modules/base';
import yorubot from '@/core/yoruBot';
import { getAiReply } from '@/service/ai';
import { calculateTypingDelay, sleep } from '@/utils/function';
import messageStorage from '../storage/message';
import { processStickerTag } from '../stickerMap';
import { formatAssistantMessage, formatMessage } from '../format';

export default class PrivateAIReplyModule extends YoruModuleBase<PrivateMessageData> {
  static NAME = 'PrivateAIReplyModule';

  async checkConditions() {
    return yorubot.config.aiReply.enable;
  }

  async run() {
    const {
      message, user_id: userId, self_id: selfId, sender,
    } = this.data;
    const nickName = sender.nickname || `${userId}`;

    const formattedMessage = formatMessage({
      selfId,
      userId,
      nickName,
      rawMessage: message,
      cleanImage: false,
    });

    messageStorage.addPrivateChatMessage(userId, formattedMessage);
    const history = messageStorage.getPrivateChatMessage(userId);
    const aiReplyText = await getAiReply(history);

    if (aiReplyText) {
      const aiReplyMessageParam = formatAssistantMessage(aiReplyText);
      messageStorage.addPrivateChatMessage(userId, aiReplyMessageParam);

      const messages = processStickerTag(aiReplyText)
        .split('||')
        .map((msg) => msg.trim())
        .filter((msg) => msg.length > 0);

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i].trim();
        if (i > 0) {
          const delay = calculateTypingDelay(msg);
          await sleep(delay);
        }
        yorubot.sendPrivateMsg(userId, msg);
      }
    }
  }
}


