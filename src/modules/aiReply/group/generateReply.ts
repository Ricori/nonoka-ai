import { getLLMReply } from '@/service/llm';
import messageStorage from '../storage/message';
import userMemoryStorage from '../storage/userMemory';
import {
  formatAssistantMessage, formatInitiativePromptMessage, formatUserMemoryPromptMessage,
} from '../format';

/** 组装群聊上下文（会话历史 + 群友记忆 + 主动插话提示）并调用 LLM 生成回复；
 *  生成成功后会把回复记入该群会话历史 */
export async function generateGroupReply(groupId: number, isInitiativeReply: boolean): Promise<string | null> {
  const history = messageStorage.getGroupChatConversations(groupId);

  // 近期发言用户的记忆上下文
  const recentUserIds = [...new Set(
    history.slice(-10).filter((m) => m.role === 'user').map((m) => m.userId),
  )];
  const userMemoryContext = userMemoryStorage.getMemoryContext(recentUserIds);
  const userMemoryPrompt = formatUserMemoryPromptMessage(userMemoryContext);

  const messages = [...history, ...(userMemoryPrompt ? [userMemoryPrompt] : [])];
  if (isInitiativeReply) {
    // 主动发起会话的提示词
    messages.push(formatInitiativePromptMessage());
  }

  const aiReplyText = await getLLMReply(messages);
  if (aiReplyText) {
    // 记忆自己的回复
    messageStorage.addGroupChatConversations(groupId, formatAssistantMessage(aiReplyText));
  }
  return aiReplyText;
}
