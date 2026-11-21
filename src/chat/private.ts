import bot from '@/bot';
import { botConfig } from '@/config';
import { PrivateMessageData } from '@/types/event';
import { getLLMReply } from '@/service/llm';
import messageStorage from './storage/message';
import { sendSegmentedReply } from './replySender';
import { formatAssistantMessage, formatMessage } from './format';

/** 处理私聊消息并分段回复 */
export async function handlePrivateMessage(data: PrivateMessageData) {
  if (!botConfig.aiReply.enable) return;

  const {
    message, user_id: userId, self_id: selfId, sender,
  } = data;
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
    await sendSegmentedReply(aiReplyText, (msg) => bot.sendPrivateMsg(userId, msg));
  }
}
