import { getLLMReply } from '@/service/llm';
import nnkbot from '@/core/nnkBot';
import messageStorage from '../storage/message';
import userMemoryStorage from '../storage/userMemory';
import groupProfileStorage from '../storage/groupProfile';
import {
  formatAssistantMessage, formatInitiativePromptMessage, formatUserMemoryPromptMessage,
} from '../format';

/** 会主动插话、却还没写群档案的群，先按陌生群对待，免得把主场的语气带过去 */
const DEFAULT_PROFILE_TEXT = '陌生群，关系空白：少说话，语气收敛，优先只回应直接向你说话的人';

/** 取注入 system 的群环境描述：有档案用档案，
 *  没档案但会主动插话的群用保守默认文案，其余（只在被 @ 时回复）不注入 */
function getGroupContext(groupId: number): string | undefined {
  const { profileText } = groupProfileStorage.getProfile(groupId);
  if (profileText) return profileText;
  if (nnkbot.config.aiReply.initiativeList.includes(groupId)) return DEFAULT_PROFILE_TEXT;
  return undefined;
}

/** 组装群聊上下文（会话历史 + 群友记忆 + 主动插话提示）并调用 LLM 生成回复；
 *  生成成功后会把回复记入该群会话历史 */
export async function generateGroupReply(
  groupId: number,
  isInitiativeReply: boolean,
  initiativeChance: number | null = null,
): Promise<string | null> {
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

  const aiReplyText = await getLLMReply(messages, getGroupContext(groupId));
  if (aiReplyText) {
    // 记忆自己的回复，并带上触发方式供备份日志标注
    messageStorage.addGroupChatConversations(
      groupId,
      formatAssistantMessage(aiReplyText, isInitiativeReply, initiativeChance),
    );
  }
  return aiReplyText;
}
