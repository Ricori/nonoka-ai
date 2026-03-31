import { GroupMessageData, SimpleMessageData } from '@/types/event';
import YoruModuleBase from '@/modules/base';
import yorubot from '@/core/yoruBot';
import {
  calculateTypingDelay, getReplyMsgId, hasReply, sleep,
} from '@/utils/function';
import { getLLMReply } from '@/service/llm';
import messageStorage from '@/modules/aiReply/storage/message';
import { printLog } from '@/utils/print';
import { processStickerTag } from '../stickerMap';
import { getTopicRelevance } from './relevance';
import { formatAssistantMessage, formatInitiativePromptMessage, formatMessage } from '../format';

const sessionTimers = new Map<number, NodeJS.Timeout | null>();
const processingLocks = new Set<number>(); // 正在回复的群的锁
const lastAtTime = new Map<number, number>(); // 记录每个群最后被@的时间

async function processReplyQueue(groupId: number, autonomousReply = false) {
  if (processingLocks.has(groupId)) {
    return;
  }
  processingLocks.add(groupId);

  try {
    const history = messageStorage.getGroupChatConversations(groupId);

    // 调用 LLM 回复
    let aiReplyText: string | null = null;
    if (autonomousReply) {
      // 主动发起会话的提示词
      const autoPrompt = formatInitiativePromptMessage();
      aiReplyText = await getLLMReply([...history, autoPrompt]);
    } else {
      aiReplyText = await getLLMReply(history);
    }

    printLog(`[GroupAIReplyModule] Auto Reply: ${aiReplyText}`);
    if (aiReplyText) {
      // 记忆自己的回复
      const aiReplyMessageParam = formatAssistantMessage(aiReplyText);
      messageStorage.addGroupChatConversations(groupId, aiReplyMessageParam);

      // 回复消息处理
      const messages = processStickerTag(aiReplyText)
        .split('||')
        .map((msg) => msg.trim())
        .filter((msg) => msg.length > 0);

      // 分段发送
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i].trim();
        if (i > 0) {
          const delay = calculateTypingDelay(msg);
          await sleep(delay);
        }
        yorubot.sendGroupMsg(groupId, msg);
      }
    }
  } finally {
    // 发完消息后延迟3秒再解锁，控制消息频率
    setTimeout(() => {
      processingLocks.delete(groupId);
    }, 3000);
  }
}



export default class GroupAIReplyModule extends YoruModuleBase<GroupMessageData> {
  static NAME = 'GroupAIReplyModule';

  async checkConditions() {
    if (!yorubot.config.aiReply.enable) {
      return false;
    }
    const { group_id: groupId } = this.data;
    const { blackList } = yorubot.config.aiReply;
    if (blackList.includes(groupId)) {
      return false;
    }

    return true;
  }


  async run() {
    const {
      message, user_id: userId, self_id: selfId, group_id: groupId, sender,
    } = this.data;
    const nickName = sender.nickname || `${userId}`;

    let shouldReply = false; // 需要回复
    let isInitiativeReply = false; // 是否是主动插话


    let replyMessage: SimpleMessageData | undefined;
    // 获取引用消息
    if (hasReply(message)) {
      replyMessage = await yorubot.getMessageFromId(getReplyMsgId(message));
    }

    const formattedMessage = formatMessage({
      selfId,
      userId,
      nickName,
      rawMessage: message,
      replyMessage,
      cleanImage: false,
    });

    // 记录群对话记录
    messageStorage.addGroupChatConversations(groupId, formattedMessage);


    if (formattedMessage.isMentionMe) {
      // 被提到了
      shouldReply = true;
      lastAtTime.set(groupId, Date.now());
    }

    // 主动插话的白名单测试群
    if (yorubot.config.aiReply.initiativeList.includes(groupId)) {
      // 被@的后200s内插话概率增大
      const isRecentlyAt = Date.now() - (lastAtTime.get(groupId) || 0) < 200 * 1000;
      // 基础概率
      const baseTriggerChance = isRecentlyAt ? 0.20 : 0.02;
      // 消息关联度加成
      const additional = getTopicRelevance(formattedMessage.message);
      if (Math.random() < baseTriggerChance + additional) {
        shouldReply = true;
        isInitiativeReply = true;
      }
    }


    // 没有命中触发条件直接返回
    if (!shouldReply) return;

    // 触发的话进入队列
    if (sessionTimers.has(groupId) && sessionTimers.get(groupId)) {
      clearTimeout(sessionTimers.get(groupId)!);
    }

    const timer = setTimeout(() => {
      sessionTimers.set(groupId, null);
      processReplyQueue(groupId, isInitiativeReply);
    }, 4500);
    sessionTimers.set(groupId, timer);
  }
}

