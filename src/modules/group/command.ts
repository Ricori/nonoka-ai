import nnkbot from '@/core/nnkBot';
import { EventKind, ModuleContext, NonokaModule } from '@/core/nnkModule';
import { GroupMessageData } from '@/types/event';
import { saveConfigToDisk } from '@/core/nnkConfig';
import { createMsgFromTweetId } from '@/service/twitter/message';
import { getRecordCode } from '@/utils/msgCode';
import { getTTSAudio } from '@/service/tts';
import { translateText } from '@/service/llm';
import { printError } from '@/utils/print';

type GroupCommand =
  | { cmd: 'initiative'; action?: string }
  | { cmd: 'pushTweet'; tweetId: string }
  | { cmd: 'tts'; text: string };

class GroupCommandModule extends NonokaModule<GroupMessageData, GroupCommand> {
  readonly name = 'GroupCommandModule';

  readonly events: EventKind[] = ['group'];

  match(ctx: ModuleContext<GroupMessageData>): GroupCommand | false {
    const { message } = ctx.data;

    // 1. Initiative conversation control - /initiative on|off
    const initiativeMatch = message.match(/^\/initiative(?:\s+(on|off))?$/);
    if (initiativeMatch) return { cmd: 'initiative', action: initiativeMatch[1] };

    // 2. Push twitter - /p <tweetUrl or tweetId>
    const pushTweetMatch = message.match(/^\/p\s+(?:\S*status\/)?(\d+)$/);
    if (pushTweetMatch) return { cmd: 'pushTweet', tweetId: pushTweetMatch[1] };

    // 3. tts - /tts <text>
    const ttsMatch = message.match(/^\/tts\s+(.+)$/);
    if (ttsMatch) return { cmd: 'tts', text: ttsMatch[1] };

    return false;
  }

  async run(ctx: ModuleContext<GroupMessageData>, hit: GroupCommand) {
    switch (hit.cmd) {
      case 'initiative':
        this.handleInitiative(ctx, hit.action);
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
