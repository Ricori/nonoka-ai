import { EventKind, ModuleContext, NonokaModule } from '@/core/nnkModule';
import { GroupMessageData, SimpleMessageData } from '@/types/event';
import nnkbot from '@/core/nnkBot';
import { BOT_NAME } from '@/constants';
import { getReplyMsgId, hasReply } from '@/utils/function';
import { printLog } from '@/utils/print';
import messageStorage from '../storage/message';
import userMemoryStorage from '../storage/userMemory';
import { formatMessage } from '../format';
import { sendSegmentedReply } from '../replySender';
import { GroupReplyTrigger } from './trigger';
import { generateGroupReply } from './generateReply';

class GroupAIReplyModule extends NonokaModule<GroupMessageData> {
  readonly name = 'GroupAIReplyModule';

  readonly events: EventKind[] = ['group'];

  /** 主动插话触发策略（群级状态） */
  private trigger = new GroupReplyTrigger();

  /** 各群的回复防抖计时器 */
  private sessionTimers = new Map<number, NodeJS.Timeout | null>();

  /** 正在回复的群的锁 */
  private processingLocks = new Set<number>();

  match(ctx: ModuleContext<GroupMessageData>) {
    if (!nnkbot.config.aiReply.enable) {
      return false;
    }
    const { blackList } = nnkbot.config.aiReply;
    return !blackList.includes(ctx.data.group_id);
  }

  async run(ctx: ModuleContext<GroupMessageData>) {
    const {
      message, user_id: userId, self_id: selfId, group_id: groupId, sender,
    } = ctx.data;
    const nickName = sender.nickname || `${userId}`;

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
      const reply = (Math.random() < 0.5) ? `${BOT_NAME}建议你 要！` : `${BOT_NAME}建议你 不要！`;
      ctx.reply(reply);
      return;
    }


    // -------- AI 回复触发决策 --------
    let shouldReply = false; // 需要AI回复
    let isInitiativeReply = false; // 是否是主动插话

    if (formattedMessage.isMentionMe) {
      // 被提到了
      shouldReply = true;
      this.trigger.noteMention(groupId);
    }

    // 主动插话的群
    if (nnkbot.config.aiReply.initiativeList.includes(groupId)) {
      if (this.trigger.shouldInitiative(groupId, formattedMessage.message)) {
        shouldReply = true;
        isInitiativeReply = true;
      }

      // 群友记忆系统
      userMemoryStorage.onMessage(userId, nickName, formattedMessage.message, formattedMessage.isMentionMe);
    }

    // 没有命中触发条件直接返回
    if (!shouldReply) return;

    // -------- 防抖调度 --------
    if (this.sessionTimers.has(groupId) && this.sessionTimers.get(groupId)) {
      clearTimeout(this.sessionTimers.get(groupId)!);
    }

    const timer = setTimeout(() => {
      this.sessionTimers.set(groupId, null);
      this.processReply(groupId, isInitiativeReply);
    }, 3500);
    this.sessionTimers.set(groupId, timer);
  }

  /** 生成并发送 AI 回复（同一群同时只处理一次） */
  private async processReply(groupId: number, isInitiativeReply = false) {
    if (this.processingLocks.has(groupId)) {
      return;
    }
    this.processingLocks.add(groupId);

    try {
      const aiReplyText = await generateGroupReply(groupId, isInitiativeReply);
      printLog(`[GroupAIReplyModule] Auto reply to ${groupId}: ${aiReplyText}`);

      if (aiReplyText) {
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

        // 分段文字发送
        await sendSegmentedReply(aiReplyText, (msg) => nnkbot.sendGroupMsg(groupId, msg));
      }
    } finally {
      this.processingLocks.delete(groupId);
    }
  }
}

export default new GroupAIReplyModule();
