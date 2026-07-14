import nnkbot from '@/core/nnkBot';
import { EventKind, ModuleContext, NonokaModule } from '@/core/nnkModule';
import { PrivateMessageData } from '@/types/event';
import { getLLMReply } from '@/service/llm';
import messageStorage from '../storage/message';
import { sendSegmentedReply } from '../replySender';
import { formatAssistantMessage, formatMessage } from '../format';

class PrivateAIReplyModule extends NonokaModule<PrivateMessageData> {
  readonly name = 'PrivateAIReplyModule';

  readonly events: EventKind[] = ['private'];

  match() {
    return nnkbot.config.aiReply.enable;
  }

  async run(ctx: ModuleContext<PrivateMessageData>) {
    const {
      message, user_id: userId, self_id: selfId, sender,
    } = ctx.data;
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
    const aiReplyText = await getLLMReply(history);

    if (aiReplyText) {
      const aiReplyMessageParam = formatAssistantMessage(aiReplyText);
      messageStorage.addPrivateChatMessage(userId, aiReplyMessageParam);

      // 分段文字发送
      await sendSegmentedReply(aiReplyText, (msg) => ctx.reply(msg));
    }
  }
}

export default new PrivateAIReplyModule();
