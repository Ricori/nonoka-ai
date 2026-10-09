import nnkbot from '@/core/nnkBot';
import { EventKind, ModuleContext, NonokaModule } from '@/core/nnkModule';
import { GroupMessageData } from '@/types/event';
import { saveConfigToDisk } from '@/core/nnkConfig';
import { createMsgFromTweetId } from '@/service/twitter/message';
import { getRecordCode } from '@/utils/msgCode';
import { getTTSAudio } from '@/service/tts';
import { translateText } from '@/service/llm';
import { printError } from '@/utils/print';
import { isGroupManager } from '@/modules/common/permission';
import { isVoiceEnabled, setVoiceEnabled } from '../aiReply/group/voiceState';

type GroupCommand =
  | { cmd: 'initiative'; enable?: boolean }
  | { cmd: 'voice'; enable?: boolean }
  | { cmd: 'pushTweet'; tweetId: string }
  | { cmd: 'tts'; text: string }
  | { cmd: 'ban'; userId?: number; minutes: number };


const DEFAULT_BAN_MINUTES = 10;

const onOffText = (on: boolean) => (on ? '开启' : '关闭');
const parseSwitch = (arg?: string) => (arg === undefined ? undefined : arg === 'on');

class GroupCommandModule extends NonokaModule<GroupMessageData, GroupCommand> {
  readonly name = 'GroupCommandModule';

  readonly events: EventKind[] = ['group'];

  match(ctx: ModuleContext<GroupMessageData>): GroupCommand | false {
    const { message } = ctx.data;

    // /initiative [on|off]
    const initiativeMatch = message.match(/^\/initiative(?:\s+(on|off))?$/);
    if (initiativeMatch) return { cmd: 'initiative', enable: parseSwitch(initiativeMatch[1]) };

    // /voice [on|off]
    const voiceMatch = message.match(/^\/voice(?:\s+(on|off))?$/);
    if (voiceMatch) return { cmd: 'voice', enable: parseSwitch(voiceMatch[1]) };

    // /p <tweetUrl|tweetId>
    const pushTweetMatch = message.match(/^\/p\s+(?:\S*status\/)?(\d+)$/);
    if (pushTweetMatch) return { cmd: 'pushTweet', tweetId: pushTweetMatch[1] };

    // /tts <text>
    const ttsMatch = message.match(/^\/tts\s+(.+)$/);
    if (ttsMatch) return { cmd: 'tts', text: ttsMatch[1] };

    // /ban <qq> [minutes]
    if (/^\/ban(\s|$)/.test(message)) {
      const args = message.trim().match(/^\/ban\s+(\d{5,12})(?:\s+(\d+))?$/);
      return {
        cmd: 'ban',
        userId: args ? Number(args[1]) : undefined,
        minutes: args?.[2] === undefined ? DEFAULT_BAN_MINUTES : Number(args[2]),
      };
    }

    return false;
  }

  async run(ctx: ModuleContext<GroupMessageData>, hit: GroupCommand) {
    switch (hit.cmd) {
      case 'initiative':
        this.handleInitiative(ctx, hit.enable);
        return;

      case 'voice':
        this.handleVoice(ctx, hit.enable);
        return;

      case 'pushTweet': {
        const msgArr = await createMsgFromTweetId(hit.tweetId);
        for (const msg of msgArr ?? []) {
          ctx.reply(msg);
        }
        return;
      }

      case 'tts':
        await this.handleTTS(ctx, hit.text);
        return;

      case 'ban':
        await this.handleBan(ctx, hit.minutes, hit.userId);
        break;

      default:
    }
  }

  /** 主动对话开关（initiativeList 是运行时可变配置，修改后立即落盘） */
  private handleInitiative(ctx: ModuleContext<GroupMessageData>, enable?: boolean) {
    const { group_id: groupId } = ctx.data;
    const list = nnkbot.config.aiReply.initiativeList;
    const isOn = list.includes(groupId);

    if (enable === undefined) {
      ctx.reply(`[NonokaSystem] 当前群主动对话状态: ${onOffText(isOn)}`);
      return;
    }

    if (enable !== isOn) {
      if (enable) {
        list.push(groupId);
      } else {
        list.splice(list.indexOf(groupId), 1);
      }
      try {
        saveConfigToDisk();
      } catch (e) {
        printError(`[GroupCommandModule] 保存 initiative 配置失败: ${e}`);
      }
    }
    ctx.reply(`[NonokaSystem] 已${onOffText(enable)}主动对话`);
  }

  /** 语音回复开关（仅内存态，重启后失效，不落盘） */
  private handleVoice(ctx: ModuleContext<GroupMessageData>, enable?: boolean) {
    const { group_id: groupId } = ctx.data;

    if (enable === undefined) {
      ctx.reply(`[NonokaSystem] 当前群语音回复状态: ${onOffText(isVoiceEnabled(groupId))}`);
      return;
    }

    setVoiceEnabled(groupId, enable);
    ctx.reply(`[NonokaSystem] 已${onOffText(enable)}语音回复`);
  }

  /** 禁言（群主/群管理员/bot 管理员可用，bot 自身也需是群管理员） */
  private async handleBan(ctx: ModuleContext<GroupMessageData>, minutes: number, userId?: number) {
    if (!isGroupManager(ctx.data)) {
      ctx.reply('[NonokaSystem] 只有管理员可以禁言', { at: true });
      return;
    }
    if (!userId) {
      ctx.reply(`[NonokaSystem] 用法: /ban QQ号 [分钟]，默认 ${DEFAULT_BAN_MINUTES} 分钟，0 为解除禁言`);
      return;
    }
    if (minutes > 30 * 24 * 60) {
      ctx.reply(`[NonokaSystem] 禁言最长 ${30 * 24 * 60} 分钟（30 天）`);
      return;
    }

    const ok = await nnkbot.setGroupBan(ctx.data.group_id, userId, minutes * 60);
    if (!ok) {
      ctx.reply(`[NonokaSystem] 禁言 ${userId} 失败（bot 不是管理员、对方是管理员或不在群里？）`);
      return;
    }
    ctx.reply(`[NonokaSystem] ${minutes === 0 ? `已解除 ${userId} 的禁言` : `已禁言 ${userId} ${minutes} 分钟`}`);
  }

  /** 文字转语音（非日文先翻译为日文） */
  private async handleTTS(ctx: ModuleContext<GroupMessageData>, text: string) {
    const jpText = /[぀-ヿ]/.test(text) ? text : await translateText(text, 'jp');
    if (!jpText) return;

    const base64 = await getTTSAudio(jpText);
    ctx.reply(base64 ? getRecordCode(base64) : '[NonokaSystem] TTS failed.');
  }
}

export default new GroupCommandModule();
