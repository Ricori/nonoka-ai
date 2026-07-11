import nnkbot from '@/core/nnkBot';
import { EventKind, ModuleContext, NonokaModule } from '@/core/nnkModule';
import { PrivateMessageData } from '@/types/event';
import { getLLMReply } from '@/service/llm';
import { calculateTypingDelay, sleep } from '@/utils/function';
import messageStorage from '../storage/message';
import { processStickerTag } from '../stickerMap';
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
        ctx.reply(msg);
      }
    }
  }
}

export default new PrivateAIReplyModule();
