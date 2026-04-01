import { PrivateMessageData } from '@/types/event';
import nnkbot from '@/core/nnkBot';
import { createMsgFromTweetId } from '@/tasks/twitter';
import messageStorage from '@/modules/aiReply/storage/message';
import nnkSchedule from '@/core/nnkSchedule';
import NonokaModuleBase from '../base';

export default class AdminModule extends NonokaModuleBase<PrivateMessageData> {
  static NAME = 'AdminModule';

  private taskControlMatch: RegExpMatchArray | null = null;

  private pushTweetMatch: RegExpMatchArray | null = null;

  async checkConditions() {
    const adminList = nnkbot.config.admin || [];
    const userId = this.data.user_id;
    // Check userId in admin list
    if (adminList.indexOf(userId) === -1) {
      return false;
    }

    // Exec administrator command
    const { message } = this.data;
    // 1. clean memory
    if (message === '/clean-memory') {
      return true;
    }

    // 2. task control - /task twitter|bilibili on|off
    this.taskControlMatch = message.match(/\/task\s+(\w+)\s+(on|off)/);
    if (this.taskControlMatch) {
      return true;
    }

    // 3. push twitter - /push-tweet <groupId> <tweetUrl or tweetId>
    this.pushTweetMatch = message.match(/\/push-tweet\s+(\d+).*(?:status\/|\s+)(\d+)/);
    if (this.pushTweetMatch) {
      return true;
    }

    return false;
  }

  async run() {
    // Prevent call chain
    this.finished = true;

    const { user_id: userId, message } = this.data;

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
  }
}
