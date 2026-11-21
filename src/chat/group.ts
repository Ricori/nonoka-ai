import bot from '@/bot';
import { botConfig } from '@/config';
import { GroupMessageData, SimpleMessageData } from '@/types/event';
import { getReplyMsgId, hasReply } from '@/utils/function';
import { printLog } from '@/utils/print';
import { getRecordCode } from '@/utils/msgCode';
import { sendSegmentedVoice } from '@/service/tts';
import memoryExtractor from '@/memory/extract';
import aliasIndex from '@/memory/identity/aliasIndex';
import { isDrawing } from '@/tools/imageGen';
import messageStorage from './storage/message';
import { formatMessage } from './format';
import { sendSegmentedReply } from './replySender';
import { GroupReplyTrigger } from './trigger';
import { generateGroupReply } from './generateReply';

class GroupChatHandler {
  /** 主动插话触发策略（群级状态） */
  private trigger = new GroupReplyTrigger();

  /** 各群的回复防抖计时器 */
  private sessionTimers = new Map<number, NodeJS.Timeout | null>();

  /** 正在回复的群的锁 */
  private processingLocks = new Set<number>();

  /** 防抖窗口内被 @ 过的群，定时器触发时消费 */
  private pendingMentions = new Set<number>();

  async handle(data: GroupMessageData) {
    if (!botConfig.aiReply.enable) return;
    if (botConfig.aiReply.blackList.includes(data.group_id)) return;

    const {
      message, message_id: messageId, time, user_id: userId, self_id: selfId, group_id: groupId, sender,
    } = data;
    const nickName = sender.nickname || `${userId}`;

    let replyMessage: SimpleMessageData | undefined;
    if (hasReply(message)) {
      replyMessage = await bot.getMessageFromId(getReplyMsgId(message));
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

    // 昵称索引：改名当天就能认出新名字，所有群都收
    aliasIndex.note(groupId, userId, nickName);

    // -------- AI 回复触发决策 --------
    let shouldReply = false;
    let isInitiativeReply = false;
    let initiativeChance: number | null = null;

    if (formattedMessage.isMentionMe) {
      shouldReply = true;
      this.trigger.noteMention(groupId);
      this.pendingMentions.add(groupId);
    }

    if (botConfig.aiReply.initiativeList.includes(groupId)) {
      // 被 @ 的这条不掷骰，避免把本次回复降级为主动插话而失去工具
      if (!formattedMessage.isMentionMe && !isDrawing(groupId)) {
        const hit = this.trigger.rollInitiative(groupId, messageStorage.getGroupChatConversations(groupId));
        if (hit !== null) {
          shouldReply = true;
          isInitiativeReply = true;
          initiativeChance = hit.chance;
        }
      }

      memoryExtractor.onMessage(
        groupId,
        userId,
        nickName,
        formattedMessage.message,
        formattedMessage.isMentionMe,
        messageId,
        time > 1e12 ? time : time * 1000,
      );
    }

    if (!shouldReply) return;

    // -------- 防抖调度 --------
    if (this.sessionTimers.has(groupId) && this.sessionTimers.get(groupId)) {
      clearTimeout(this.sessionTimers.get(groupId)!);
    }

    const timer = setTimeout(() => {
      this.sessionTimers.set(groupId, null);
      // 防抖期间被 @ 过就整体按被 @ 处理
      const mentioned = this.pendingMentions.delete(groupId);
      this.processReply(groupId, isInitiativeReply && !mentioned, mentioned ? null : initiativeChance);
    }, 3500);
    this.sessionTimers.set(groupId, timer);
  }

  /** 生成并发送 AI 回复（同一群同时只处理一次） */
  private async processReply(groupId: number, isInitiativeReply = false, initiativeChance: number | null = null) {
    if (this.processingLocks.has(groupId)) return;
    if (isInitiativeReply && isDrawing(groupId)) return;
    this.processingLocks.add(groupId);

    try {
      const aiReplyText = await generateGroupReply(groupId, isInitiativeReply, initiativeChance);
      printLog(`[GroupChat] Auto reply to ${groupId}: ${aiReplyText}`);

      if (aiReplyText) {
        if (botConfig.aiReply.voiceList?.includes(groupId) && await this.trySendVoice(groupId, aiReplyText)) {
          return;
        }
        await sendSegmentedReply(aiReplyText, (msg) => bot.sendGroupMsg(groupId, msg));
      }
    } finally {
      this.processingLocks.delete(groupId);
    }
  }

  /** 尝试把回复转成语音发送，一条都没合成出来就返回 false 由调用方回退到文字 */
  private async trySendVoice(groupId: number, aiReplyText: string) {
    const message = aiReplyText
      .replace(/\[表情:\s*(.*?)\]/g, '')
      .replace(/\|\|/g, ' ')
      .trim();
    if (!message) return false;

    printLog(`[GroupChat] Auto reply audio: ${message}`);
    const { sent, rest } = await sendSegmentedVoice(
      message,
      (audio) => bot.sendGroupMsg(groupId, getRecordCode(audio)),
      { lang: 'zh' },
    );
    if (!sent) return false;

    if (rest) await bot.sendGroupMsg(groupId, rest);
    return true;
  }
}

const groupChatHandler = new GroupChatHandler();

export function handleGroupMessage(data: GroupMessageData) {
  return groupChatHandler.handle(data);
}
