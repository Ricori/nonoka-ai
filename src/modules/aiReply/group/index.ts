import { EventKind, ModuleContext, NonokaModule } from '@/core/nnkModule';
import { GroupMessageData, SimpleMessageData } from '@/types/event';
import nnkbot from '@/core/nnkBot';
import { BOT_NAME } from '@/constants';
import { getReplyMsgId, hasReply } from '@/utils/function';
import { printLog } from '@/utils/print';
import { getRecordCode } from '@/utils/msgCode';
import { getTTSAudio } from '@/service/tts';
import { translateText } from '@/service/llm';
import messageStorage from '../storage/message';
import userMemoryStorage from '../storage/userMemory';
import { formatMessage } from '../format';
import { sendSegmentedReply } from '../replySender';
import { GroupReplyTrigger } from './trigger';
import { generateGroupReply } from './generateReply';
import { isVoiceEnabled } from './voiceState';

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
    let initiativeChance: number | null = null; // 本次主动插话实际使用的概率

    if (formattedMessage.isMentionMe) {
      // 被提到了
      shouldReply = true;
      this.trigger.noteMention(groupId);
    }

    // 主动插话的群
    if (nnkbot.config.aiReply.initiativeList.includes(groupId)) {
      const chance = this.trigger.rollInitiative(groupId, formattedMessage.message);
      if (chance !== null) {
        shouldReply = true;
        isInitiativeReply = true;
        initiativeChance = chance;
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
      this.processReply(groupId, isInitiativeReply, initiativeChance);
    }, 3500);
    this.sessionTimers.set(groupId, timer);
  }

  /** 生成并发送 AI 回复（同一群同时只处理一次） */
  private async processReply(groupId: number, isInitiativeReply = false, initiativeChance: number | null = null) {
    if (this.processingLocks.has(groupId)) {
      return;
    }
    this.processingLocks.add(groupId);

    try {
      const aiReplyText = await generateGroupReply(groupId, isInitiativeReply, initiativeChance);
      printLog(`[GroupAIReplyModule] Auto reply to ${groupId}: ${aiReplyText}`);

      if (aiReplyText) {
        // 开启语音回复的群优先发语音，成功后不再发文字，避免同样内容重复出现
        if (isVoiceEnabled(groupId) && await this.trySendVoice(groupId, aiReplyText)) {
          return;
        }

        // 分段文字发送
        await sendSegmentedReply(aiReplyText, (msg) => nnkbot.sendGroupMsg(groupId, msg));
      }
    } finally {
      this.processingLocks.delete(groupId);
    }
  }

  /** 尝试把回复转成语音发送，任一环节失败都返回 false 由调用方回退到文字 */
  private async trySendVoice(groupId: number, aiReplyText: string) {
    // 去掉表情标签，分段符换成空格以免相邻两段粘连
    const message = aiReplyText
      .replace(/\[表情:\s*(.*?)\]/g, '')
      .replace(/\|\|/g, ' ')
      .trim();
    if (!message) return false;

    const jpText = await translateText(message, 'jp');
    if (!jpText) return false;

    printLog(`[GroupAIReplyModule] Auto reply audio: ${jpText}`);
    const base64 = await getTTSAudio(jpText);
    if (!base64) return false;

    nnkbot.sendGroupMsg(groupId, getRecordCode(base64));
    return true;
  }
}

export default new GroupAIReplyModule();
