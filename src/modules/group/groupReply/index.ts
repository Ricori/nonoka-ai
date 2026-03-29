import { GroupMessageData } from '@/types/event';
import YoruModuleBase from '@/modules/base';
import yorubot from '@/core/yoruBot';
import {
  calculateTypingDelay, cleanAt, getReplyMsgId, hasReply, sleep,
} from '@/utils/function';
import {
  generateAssistantMessageParam, generateInitiativePromptParam, generateUserMessageParam, getAiReply,
} from '@/service/ai';
import yoruStorage from '@/core/yoruStorage';
import { printLog } from '@/utils/print';
import { processStickerTag } from './stickerMap';

const sessionTimers = new Map<number, NodeJS.Timeout | null>();
const processingLocks = new Set<number>(); // 正在回复的群的锁
const lastAtTime = new Map<number, number>(); // 记录每个群最后被@的时间

async function processReplyQueue(groupId: number, autonomousReply = false) {
  if (processingLocks.has(groupId)) {
    // setTimeout(() => processReplyQueue(groupId), 2000);
    return;
  }
  processingLocks.add(groupId); // 上锁

  try {
    yoruStorage.trimGroupChatConversations(groupId);
    const history = yoruStorage.getGroupChatConversations(groupId);

    // 调用 LLM 回复
    let aiReplyText: string | null = null;
    if (autonomousReply) {
      // 主动发起会话的提示词
      const autoPrompt = generateInitiativePromptParam();
      aiReplyText = await getAiReply([...history, autoPrompt]);
    } else {
      aiReplyText = await getAiReply(history);
    }

    printLog(`[GroupAIReplyModule] Auto Reply: ${aiReplyText}`);
    if (aiReplyText) {
      // 记忆自己的回复
      const aiReplyMessageParam = generateAssistantMessageParam(aiReplyText);
      yoruStorage.addGroupChatConversations(groupId, aiReplyMessageParam);

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

    const nickName = sender.nickname || userId;

    let shouldReply = false;
    let autonomousReply = false;
    let processedMessage = '';
    const isAtMe = message.indexOf(`[CQ:at,qq=${selfId}]`) > -1;

    // 获取引用消息文本
    if (hasReply(message)) {
      const replyMsgId = getReplyMsgId(message);
      const replyMsgData = await yorubot.getMessageFromId(replyMsgId);
      if (replyMsgData) {
        const isBot = replyMsgData.sender.user_id === selfId; // 是否引用自己的消息
        const cleanText = cleanAt(replyMsgData.message).replace(/\[CQ:image,[^\]]+\]/g, '[之前的图片]').trim();
        processedMessage = `[${nickName}]回复了${isBot ? '我' : replyMsgData.sender.nickname || ''}的消息(${cleanText.slice(0, 90)})，说：${cleanAt(message)}`;
        if (isBot) {
          shouldReply = true;
        }
      }
    } else {
      processedMessage = `[${nickName}]${isAtMe ? '提到我' : ''}说：${cleanAt(message).trim()}`;
    }

    // 记录群对话记录
    const messageParam = generateUserMessageParam(processedMessage, false);

    if (messageParam) {
      yoruStorage.addGroupChatConversations(groupId, messageParam);
    }


    if (isAtMe) {
      // 在群里被@了
      shouldReply = true;
      lastAtTime.set(groupId, Date.now());
    }

    // 主动插话的白名单测试群
    if (yorubot.config.aiReply.initiativeList.includes(groupId)) {
      // 被@的后200s内插话概率增大
      const isRecentlyAt = Date.now() - (lastAtTime.get(groupId) || 0) < 200 * 1000;
      const triggerChance = isRecentlyAt ? 0.21 : 0.02;
      if (Math.random() < triggerChance) {
        shouldReply = true;
        autonomousReply = true;
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
      processReplyQueue(groupId, autonomousReply);
    }, 4500);
    sessionTimers.set(groupId, timer);
  }
}

