import nnkbot from '@/core/nnkBot';
import { EventKind, ModuleContext, NonokaModule } from '@/core/nnkModule';
import { GroupMessageData } from '@/types/event';
import { saveConfigToDisk } from '@/core/nnkConfig';
import { createMsgFromTweetId } from '@/service/twitter/message';
import { getRecordCode } from '@/utils/msgCode';
import { getTTSAudio } from '@/service/tts';
import { translateText } from '@/service/llm';
import { printError } from '@/utils/print';
import { isVoiceEnabled, setVoiceEnabled } from '../aiReply/group/voiceState';

type GroupCommand =
  | { cmd: 'initiative'; action?: string }
  | { cmd: 'voice'; action?: string }
  | { cmd: 'pushTweet'; tweetId: string }
  | { cmd: 'tts'; text: string }
  | { cmd: 'ban'; userId?: number; minutes: number };

/** QQ 单次禁言上限 30 天 */
const MAX_BAN_MINUTES = 30 * 24 * 60;

class GroupCommandModule extends NonokaModule<GroupMessageData, GroupCommand> {
  readonly name = 'GroupCommandModule';

  readonly events: EventKind[] = ['group'];

  match(ctx: ModuleContext<GroupMessageData>): GroupCommand | false {
    const { message } = ctx.data;

    // 1. Initiative conversation control - /initiative on|off
    const initiativeMatch = message.match(/^\/initiative(?:\s+(on|off))?$/);
    if (initiativeMatch) return { cmd: 'initiative', action: initiativeMatch[1] };

    // 2. Voice reply control - /voice on|off
    const voiceMatch = message.match(/^\/voice(?:\s+(on|off))?$/);
    if (voiceMatch) return { cmd: 'voice', action: voiceMatch[1] };

    // 3. Push twitter - /p <tweetUrl or tweetId>
    const pushTweetMatch = message.match(/^\/p\s+(?:\S*status\/)?(\d+)$/);
    if (pushTweetMatch) return { cmd: 'pushTweet', tweetId: pushTweetMatch[1] };

    // 4. tts - /tts <text>
    const ttsMatch = message.match(/^\/tts\s+(.+)$/);
    if (ttsMatch) return { cmd: 'tts', text: ttsMatch[1] };

    // 5. ban - /ban <qq> [minutes]，默认 10 分钟，0 为解除；参数不对时 userId 为空，回复用法
    if (/^\/ban(\s|$)/.test(message)) {
      const args = message.trim().match(/^\/ban\s+(\d{5,12})(?:\s+(\d+))?$/);
      return {
        cmd: 'ban',
        userId: args ? Number(args[1]) : undefined,
        minutes: args?.[2] === undefined ? 10 : Number(args[2]),
      };
    }

    return false;
  }

  async run(ctx: ModuleContext<GroupMessageData>, hit: GroupCommand) {
    switch (hit.cmd) {
      case 'initiative':
        this.handleInitiative(ctx, hit.action);
        return;

      case 'voice':
        this.handleVoice(ctx, hit.action);
        return;

      case 'pushTweet': {
        const msgArr = await createMsgFromTweetId(hit.tweetId);
        if (!msgArr || msgArr.length === 0) return;
        for (const msg of msgArr) {
          ctx.reply(msg);
        }
        return;
      }

      case 'tts':
        await this.handleTTS(ctx, hit.text);
        break;

      case 'ban':
        await this.handleBan(ctx, hit.minutes, hit.userId);
        break;

      default:
    }
  }

  /** 主动对话开关（initiativeList 是运行时可变配置，修改后立即落盘） */
  private handleInitiative(ctx: ModuleContext<GroupMessageData>, action?: string) {
    const { group_id: groupId } = ctx.data;
    const list = nnkbot.config.aiReply.initiativeList;

    if (!action) {
      const isOn = list.includes(groupId);
      ctx.reply(`[NonokaSystem] 当前群主动对话状态: ${isOn ? '开启' : '关闭'}`);
    } else if (action === 'on') {
      if (!list.includes(groupId)) {
        list.push(groupId);
        this.persistInitiativeChange();
        ctx.reply('[NonokaSystem] 已开启主动对话');
      }
    } else {
      const idx = list.indexOf(groupId);
      if (idx !== -1) {
        list.splice(idx, 1);
        this.persistInitiativeChange();
        ctx.reply('[NonokaSystem] 已关闭主动对话');
      }
    }
  }

  /** 配置落盘 */
  private persistInitiativeChange() {
    try {
      saveConfigToDisk();
    } catch (e) {
      printError(`[GroupCommandModule] 保存 initiative 配置失败: ${e}`);
    }
  }

  /** 语音回复开关（仅内存态，重启后失效，不落盘） */
  private handleVoice(ctx: ModuleContext<GroupMessageData>, action?: string) {
    const { group_id: groupId } = ctx.data;

    if (!action) {
      ctx.reply(`[NonokaSystem] 当前群语音回复状态: ${isVoiceEnabled(groupId) ? '开启' : '关闭'}`);
      return;
    }

    const enable = action === 'on';
    setVoiceEnabled(groupId, enable);
    ctx.reply(`[NonokaSystem] 已${enable ? '开启' : '关闭'}语音回复`);
  }

  /** 禁言（群主/群管理员/bot 管理员可用，bot 自身也需是群管理员） */
  private async handleBan(ctx: ModuleContext<GroupMessageData>, minutes: number, userId?: number) {
    const { group_id: groupId, user_id: senderId, sender } = ctx.data;
    const isGroupAdmin = sender.role === 'owner' || sender.role === 'admin';
    const isBotAdmin = (nnkbot.config.admin || []).includes(senderId);
    if (!isGroupAdmin && !isBotAdmin) {
      ctx.reply('[NonokaSystem] 只有管理员可以禁言', { at: true });
      return;
    }
    if (!userId) {
      ctx.reply('[NonokaSystem] 用法: /ban QQ号 [分钟]，默认 10 分钟，0 为解除禁言');
      return;
    }
    if (minutes > MAX_BAN_MINUTES) {
      ctx.reply(`[NonokaSystem] 禁言最长 ${MAX_BAN_MINUTES} 分钟（30 天）`);
      return;
    }

    if (await nnkbot.setGroupBan(groupId, userId, minutes * 60)) {
      ctx.reply(`[NonokaSystem] ${minutes === 0 ? `已解除 ${userId} 的禁言` : `已禁言 ${userId} ${minutes} 分钟`}`);
    } else {
      ctx.reply(`[NonokaSystem] 禁言 ${userId} 失败（bot 不是管理员、对方是管理员或不在群里？）`);
    }
  }

  /** 文字转语音（非日文先翻译为日文） */
  private async handleTTS(ctx: ModuleContext<GroupMessageData>, text: string) {
    let base64: string | null;
    const japaneseRegex = /[぀-ゟ゠-ヿ]/;
    if (japaneseRegex.test(text)) {
      // 日文
      base64 = await getTTSAudio(text);
    } else {
      // 非日文则翻译
      const jpText = await translateText(text, 'jp');
      if (!jpText) return;
      base64 = await getTTSAudio(jpText);
    }

    if (base64) {
      ctx.reply(getRecordCode(base64));
    } else {
      ctx.reply('[NonokaSystem] TTS failed.');
    }
  }
}

export default new GroupCommandModule();
