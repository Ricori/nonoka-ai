import { GroupMessageData, SimpleMessageData } from '@/types/event';
import NonokaModuleBase from '@/modules/base';
import nnkbot from '@/core/nnkBot';
import {
  calculateTypingDelay, getReplyMsgId, hasReply, sleep,
} from '@/utils/function';
import { getLLMReply, translateText } from '@/service/llm';
import { printLog } from '@/utils/print';
import { getTTSAudio } from '@/service/tts';
import { getRecordCode } from '@/utils/msgCode';
import messageStorage from '../storage/message';
import { processStickerTag } from '../stickerMap';
import { getAdditionalChance } from './relevance';
import {
  formatAssistantMessage, formatInitiativePromptMessage, formatMessage, formatUserMemoryPromptMessage,
} from '../format';
import userMemoryStorage from '../storage/userMemory';

const sessionTimers = new Map<number, NodeJS.Timeout | null>();
const processingLocks = new Set<number>(); // 正在回复的群的锁
const lastAtTime = new Map<number, number>(); // 记录每个群最后被@的时间
const lastInitiativeTime = new Map<number, number>(); // 记录每个群最后主动插话的时间


async function processReplyQueue(groupId: number, isInitiativeReply = false) {
  if (processingLocks.has(groupId)) {
    return;
  }
  processingLocks.add(groupId);

  try {
    const history = messageStorage.getGroupChatConversations(groupId);

    // 调用 LLM 回复
    let aiReplyText: string | null = null;

    const recentUserIds = [...new Set(
      history.slice(-10).filter((m) => m.role === 'user').map((m) => m.userId),
    )];

    const userMemoryContext = userMemoryStorage.getMemoryContext(recentUserIds);
    const userMemoryPrompt = formatUserMemoryPromptMessage(userMemoryContext);

    if (isInitiativeReply) {
      // 主动发起会话的提示词
      const initiativePrompt = formatInitiativePromptMessage();
      aiReplyText = await getLLMReply([...history, ...(userMemoryPrompt ? [userMemoryPrompt] : []), initiativePrompt]);
    } else {
      aiReplyText = await getLLMReply([...history, ...(userMemoryPrompt ? [userMemoryPrompt] : [])]);
    }

    printLog(`[GroupAIReplyModule] Auto reply to ${groupId}: ${aiReplyText}`);
    if (aiReplyText) {
      // 记忆自己的回复
      const aiReplyMessageParam = formatAssistantMessage(aiReplyText);
      messageStorage.addGroupChatConversations(groupId, aiReplyMessageParam);

      /* 语音回复
      if (Math.random() < 0.2) {
        // 语音发送
        const message = aiReplyText.replace(/\[表情:\s*(.*?)\]/g, '').replace('||', '').trim();
        if (message) {
          const jpText = await translateText(message, 'jp');
          if (!jpText) return;
          printLog(`[GroupAIReplyModule] Auto reply audio: ${jpText}`);
          const base64 = await getTTSAudio(jpText);
          if (base64) {
            const recordCode = getRecordCode(base64);
            nnkbot.sendGroupMsg(groupId, recordCode);
          }
        }
      }
      */

      // 回复消息处理
      const messages = processStickerTag(aiReplyText)
        .split('||')
        .map((msg) => msg.trim())
        .filter((msg) => msg.length > 0);
      // 分段文字发送
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i].trim();
        if (i > 0) {
          const delay = calculateTypingDelay(msg);
          await sleep(delay);
        }
        nnkbot.sendGroupMsg(groupId, msg);
      }
    }
  } finally {
    // 发完消息后延迟2.5秒再解锁，控制消息频率
    setTimeout(() => {
      processingLocks.delete(groupId);
    }, 2500);
  }
}



export default class GroupAIReplyModule extends NonokaModuleBase<GroupMessageData> {
  static NAME = 'GroupAIReplyModule';

  async checkConditions() {
    if (!nnkbot.config.aiReply.enable) {
      return false;
    }
    const { group_id: groupId } = this.data;
    const { blackList } = nnkbot.config.aiReply;
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

    let shouldReply = false; // 需要AI回复
    let isInitiativeReply = false; // 是否是主动插话

    let replyMessage: SimpleMessageData | undefined;
    // 获取引用消息
    if (hasReply(message)) {
      replyMessage = await nnkbot.getMessageFromId(getReplyMsgId(message));
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

    //  -------- 固定回复逻辑 --------
    // 1. 匹配"要不要xxx"时随机回复"要"或"不要"
    if (/要不要/.test(formattedMessage.message)) {
      const reply = (Math.random() < 0.5) ? '乃乃香建议你 要！' : '乃乃香建议你 不要！';
      nnkbot.sendGroupMsg(groupId, reply);
      return;
    }


    // -------- AI 回复逻辑 --------
    if (formattedMessage.isMentionMe) {
      // 被提到了
      shouldReply = true;
      lastAtTime.set(groupId, Date.now());
    }

    // 主动插话的群
    if (nnkbot.config.aiReply.initiativeList.includes(groupId)) {
      const now = Date.now();
      const lastAt = lastAtTime.get(groupId) || 0;
      const lastInitiative = lastInitiativeTime.get(groupId) || 0;

      // 被提到后100s内插话概率增大
      const isRecentlyAt = now - lastAt < 100 * 1000;
      // 附加概率
      const additional = getAdditionalChance(formattedMessage.message);
      // 概率
      let triggerChance = (isRecentlyAt ? 0.12 : 0.015) + additional;

      // 如果上次是主动插话且30s内没被提到，则开始衰减
      if (lastInitiative > lastAt && now - lastAt >= 25 * 1000) {
        const timeSinceAt = now - lastAt;
        const decayPeriods = Math.floor(timeSinceAt / (25 * 1000));
        // 每25s衰减，最低到1.5%
        triggerChance = Math.max(0.015, triggerChance * (0.5 ** decayPeriods));
      }


      if (Math.random() < triggerChance) {
        shouldReply = true;
        isInitiativeReply = true;
        lastInitiativeTime.set(groupId, now);
      }

      // 群友记忆系统
      userMemoryStorage.onMessage(userId, nickName, formattedMessage.message, formattedMessage.isMentionMe);
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

