import { GroupMessageData } from '@/types/event';
import nnkbot from '@/core/nnkBot';
import { createMsgFromTweetId } from '@/tasks/twitter';
import { getRecordCode } from '@/utils/msgCode';
import { getTTSAudio } from '@/service/tts';
import { translateText } from '@/service/llm';
import NonokaModuleBase from '../base';

export default class GroupCommandModule extends NonokaModuleBase<GroupMessageData> {
  static NAME = 'GroupCommandModule';

  private initiativeMatch: RegExpMatchArray | null = null;

  private pushTweetMatch: RegExpMatchArray | null = null;

  private ttsMatch: RegExpMatchArray | null = null;

  async checkConditions() {
    const { message } = this.data;

    // 1. Initiative conversation control - /initiative on|off
    this.initiativeMatch = message.match(/^\/initiative(?:\s+(on|off))?$/);
    if (this.initiativeMatch) return true;

    // 2. Push twitter - /p <tweetUrl or tweetId>
    this.pushTweetMatch = message.match(/^\/p\s+(?:\S*status\/)?(\d+)$/);
    if (this.pushTweetMatch) return true;

    // 3. tts - /tts <text>
    this.ttsMatch = message.match(/^\/tts\s+(.+)$/);
    if (this.ttsMatch) {
      return true;
    }
    return false;
  }

  async run() {
    const { group_id: groupId } = this.data;

    // 1. Initiative conversation
    if (this.initiativeMatch) {
      const action = this.initiativeMatch[1];
      const list = nnkbot.config.aiReply.initiativeList;
      if (!action) {
        const isOn = list.includes(groupId);
        nnkbot.sendGroupMsg(groupId, `[NonokaSystem] 当前群主动对话状态: ${isOn ? '开启' : '关闭'}`);
      } else if (action === 'on') {
        if (!list.includes(groupId)) {
          list.push(groupId);
          nnkbot.sendGroupMsg(groupId, '[NonokaSystem] 已开启主动对话');
        }
      } else {
        const idx = list.indexOf(groupId);
        if (idx !== -1) {
          list.splice(idx, 1);
          nnkbot.sendGroupMsg(groupId, '[NonokaSystem] 已关闭主动对话');
        }
      }
    }

    // 2. Push twitter
    if (this.pushTweetMatch) {
      const [, tweetId] = this.pushTweetMatch;
      const msgArr = await createMsgFromTweetId(tweetId);
      if (!msgArr || msgArr.length === 0) return;
      for (const msg of msgArr) {
        nnkbot.sendGroupMsg(groupId, msg);
      }
    }

    // 3. tts
    if (this.ttsMatch) {
      const [, text] = this.ttsMatch;
      let base64: string | null;
      const japaneseRegex = /[\u3040-\u309F\u30A0-\u30FF]/;
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
        const recordCode = getRecordCode(base64);
        nnkbot.sendGroupMsg(groupId, recordCode);
      } else {
        nnkbot.sendGroupMsg(groupId, '[NonokaSystem] TTS failed.');
      }
    }
  }
}
