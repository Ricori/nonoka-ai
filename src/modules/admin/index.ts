import { PrivateMessageData } from '@/types/event';
import nnkbot from '@/core/nnkBot';
import { createMsgFromTweetId } from '@/tasks/twitter';
import messageStorage from '@/modules/aiReply/storage/message';
import nnkSchedule from '@/core/nnkSchedule';
import axios from 'axios';
import { getRecordCode } from '@/utils/msgCode';
import { getTTSAudio } from '@/service/tts';
import NonokaModuleBase from '../base';

export default class AdminModule extends NonokaModuleBase<PrivateMessageData> {
  static NAME = 'AdminModule';

  private taskControlMatch: RegExpMatchArray | null = null;

  private pushTweetMatch: RegExpMatchArray | null = null;

  private ttsMatch: RegExpMatchArray | null = null;

  async checkConditions() {
    const adminList = nnkbot.config.admin || [];
    const userId = this.data.user_id;
    // Check userId in admin list
    if (adminList.indexOf(userId) === -1) {
      return false;
    }

    // Exec administrator command
    const { message } = this.data;

    // 0. help
    if (message === '/help') {
      return true;
    }

    // 1. clean memory
    if (message === '/clean-memory') {
      return true;
    }

    // 2. task control - /task twitter|bilibili on|off
    this.taskControlMatch = message.match(/^\/task\s+(\w+)\s+(on|off)$/);
    if (this.taskControlMatch) {
      return true;
    }

    // 3. push twitter - /push-tweet <groupId> <tweetUrl or tweetId>
    this.pushTweetMatch = message.match(/^\/push-tweet\s+(\d+).*(?:status\/|\s+)(\d+)$/);
    if (this.pushTweetMatch) {
      return true;
    }

    // 4. tts - /tts <text>
    this.ttsMatch = message.match(/^\/tts\s+(.+)$/);
    if (this.ttsMatch) {
      return true;
    }

    return false;
  }

  async run() {
    // Prevent call chain
    this.finished = true;

    const { user_id: userId, message } = this.data;

    // 0. help
    if (message === '/help') {
      const helpText = [
        '=== Nonoka Admin Commands ===',
        '',
        '/help',
        '  显示所有可用命令',
        '',
        '/clean-memory',
        '  清理 AI 对话记忆',
        '',
        '/task <taskName> <on|off>',
        '  控制定时任务开关',
        '  taskName: twitter | bilibili',
        '  示例: /task twitter on',
        '',
        '/push-tweet <groupId> <tweetUrl|tweetId>',
        '  推送推文到指定群组',
        '  示例: /push-tweet 123456 https://twitter.com/user/status/123456',
        '  示例: /push-tweet 123456 123456',
        '',
        '/tts <text>',
        '  文字转语音',
        '  示例: /tts おはようございます。',
      ].join('\n');
      nnkbot.sendPrivateMsg(userId, helpText);
      return;
    }

    // 1. clean memory
    if (message === '/clean-memory') {
      messageStorage.cleanChatConversations();
      nnkbot.sendPrivateMsg(userId, '[NonokaSystem] Memory cleaned.');
      return;
    }

    // 2. task control
    if (this.taskControlMatch) {
      const [, task, action] = this.taskControlMatch;
      switch (task) {
        case 'twitter':
          if (action === 'on') {
            nnkSchedule.startById('twitterPush');
            nnkbot.sendPrivateMsg(userId, '[NonokaSystem] Twitter task enabled.');
          } else {
            nnkSchedule.stopById('twitterPush');
            nnkbot.sendPrivateMsg(userId, '[NonokaSystem] Twitter task disabled.');
          }
          return;
        case 'bilibili':
          if (action === 'on') {
            nnkSchedule.startById('bilibiliNewShared');
            nnkbot.sendPrivateMsg(userId, '[NonokaSystem] Bilibili task enabled.');
          } else {
            nnkSchedule.stopById('bilibiliNewShared');
            nnkbot.sendPrivateMsg(userId, '[NonokaSystem] Bilibili task disabled.');
          }
          return;
        default:
          nnkbot.sendPrivateMsg(userId, '[NonokaSystem] Unsupported task.');
          return;
      }
    }

    // 3. push twitter
    if (this.pushTweetMatch) {
      const [, targetGroupId, tweetId] = this.pushTweetMatch;
      const msgArr = await createMsgFromTweetId(tweetId);
      if (!msgArr || msgArr.length === 0) return;
      for (const msg of msgArr) {
        nnkbot.sendGroupMsg(Number(targetGroupId), msg);
      }
      nnkbot.sendPrivateMsg(userId, `[NonokaSystem] Push ${tweetId} to ${targetGroupId} successed.`);
    }

    // 4. tts
    if (this.ttsMatch) {
      const [, text] = this.ttsMatch;
      const base64 = await getTTSAudio(text);
      if (base64) {
        const recordCode = getRecordCode(base64);
        nnkbot.sendPrivateMsg(userId, recordCode);
      } else {
        nnkbot.sendPrivateMsg(userId, '[NonokaSystem] TTS failed.');
      }
    }
  }
}
