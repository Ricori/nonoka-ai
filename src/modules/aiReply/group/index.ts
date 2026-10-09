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
import memoryExtractor from '../memory/extract';
import { isDrawing } from '../imageGen/tools';
import aliasIndex from '../history/aliasIndex';
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

  /** 防抖窗口内被 @ 过的群，定时器触发时消费 */
  private pendingMentions = new Set<number>();

  match(ctx: ModuleContext<GroupMessageData>) {
    if (!nnkbot.config.aiReply.enable) {
      return false;
    }
    const { blackList } = nnkbot.config.aiReply;
    return !blackList.includes(ctx.data.group_id);
  }

  async run(ctx: ModuleContext<GroupMessageData>) {
    const {
      message, message_id: messageId, time, user_id: userId, self_id: selfId, group_id: groupId, sender,
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

    // 昵称索引：改名当天就能认出新名字，不必等日志落盘或重启。
    // 放在初回复判定之前，所有群都收，认人跟这个群会不会主动插话无关
    aliasIndex.note(groupId, userId, nickName);

    //  -------- 固定回复逻辑 --------
    // 1. 匹配"要不要xxx"时随机回复"要"或"不要"
    // if (/要不要/.test(formattedMessage.message)) {
    //   const reply = (Math.random() < 0.5) ? `${BOT_NAME}建议你 要！` : `${BOT_NAME}建议你 不要！`;
    //   ctx.reply(reply);
    //   return;
    // }

    // -------- AI 回复触发决策 --------
    let shouldReply = false; // 需要AI回复
    let isInitiativeReply = false; // 是否是主动插话
    let initiativeChance: number | null = null; // 本次主动插话实际使用的概率

    if (formattedMessage.isMentionMe) {
      // 被提到了
      shouldReply = true;
      this.trigger.noteMention(groupId);
      this.pendingMentions.add(groupId);
    }

    // 主动插话的群
    if (nnkbot.config.aiReply.initiativeList.includes(groupId)) {
      // 被 @ 的这条不掷骰：掷中会把这次回复降级成主动插话，而主动插话不下发工具
      // 判定放在掷骰之前，免得白白消耗 trigger 内部的冷却与计数状态
      if (!formattedMessage.isMentionMe && !isDrawing(groupId)) {
        const hit = this.trigger.rollInitiative(groupId, messageStorage.getGroupChatConversations(groupId));
        if (hit !== null) {
          printLog(`[GroupAIReplyModule] ${groupId} 主动插话 概率 ${hit.baseChance.toFixed(4)}→${hit.chance.toFixed(4)}`);
          shouldReply = true;
          isInitiativeReply = true;
          initiativeChance = hit.chance;
        }
      }

      // 群友记忆系统
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

    // 没有命中触发条件直接返回
    if (!shouldReply) return;

    // -------- 防抖调度 --------
    if (this.sessionTimers.has(groupId) && this.sessionTimers.get(groupId)) {
      clearTimeout(this.sessionTimers.get(groupId)!);
    }

    const timer = setTimeout(() => {
      this.sessionTimers.set(groupId, null);
      // 定时器只带最后一条消息的标志，防抖期间被 @ 过就整体按被 @ 处理，
      // 否则别人随后插一句掷中，@ 过来的那次请求会被当成主动插话而失去工具
      const mentioned = this.pendingMentions.delete(groupId);
      this.processReply(groupId, isInitiativeReply && !mentioned, mentioned ? null : initiativeChance);
    }, 3500);
    this.sessionTimers.set(groupId, timer);
  }

  /** 生成并发送 AI 回复（同一群同时只处理一次） */
  private async processReply(groupId: number, isInitiativeReply = false, initiativeChance: number | null = null) {
    if (this.processingLocks.has(groupId)) {
      return;
    }
    // 掷骰到这里隔着 3.5s 防抖，期间可能已经开始画图了，主动插话再拦一道
    if (isInitiativeReply && isDrawing(groupId)) {
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
