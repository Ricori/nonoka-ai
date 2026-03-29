import { PrivateMessageData } from '@/types/event';
import yorubot from '@/core/yoruBot';
import { createMsgFromTweetId } from '@/tasks/twitter';
import yoruStorage from '@/core/yoruStorage';
import yoruSchedule from '@/core/yoruSchedule';
import YoruModuleBase from '../base';

export default class AdminModule extends YoruModuleBase<PrivateMessageData> {
  static NAME = 'AdminModule';

  private taskControlMatch: RegExpMatchArray | null = null;

  private pushTweetMatch: RegExpMatchArray | null = null;

  async checkConditions() {
    const adminList = yorubot.config.admin || [];
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
      yoruStorage.cleanChatConversations();
      yorubot.sendPrivateMsg(userId, '[YoruSystem] Memory cleaned.');
      return;
    }

    // 2. task control
    if (this.taskControlMatch) {
      const [, task, action] = this.taskControlMatch;
      switch (task) {
        case 'twitter':
          if (action === 'on') {
            yoruSchedule.startById('twitterPush');
            yorubot.sendPrivateMsg(userId, '[YoruSystem] Twitter task enabled.');
          } else {
            yoruSchedule.stopById('twitterPush');
            yorubot.sendPrivateMsg(userId, '[YoruSystem] Twitter task disabled.');
          }
          return;
        case 'bilibili':
          if (action === 'on') {
            yoruSchedule.startById('bilibiliNewShared');
            yorubot.sendPrivateMsg(userId, '[YoruSystem] Bilibili task enabled.');
          } else {
            yoruSchedule.stopById('bilibiliNewShared');
            yorubot.sendPrivateMsg(userId, '[YoruSystem] Bilibili task disabled.');
          }
          return;
        default:
          yorubot.sendPrivateMsg(userId, '[YoruSystem] Unsupported task.');
          return;
      }
    }

    // 3. push twitter
    if (this.pushTweetMatch) {
      const [, targetGroupId, tweetId] = this.pushTweetMatch;
      const msgArr = await createMsgFromTweetId(tweetId);
      if (!msgArr || msgArr.length === 0) return;
      for (const msg of msgArr) {
        yorubot.sendGroupMsg(Number(targetGroupId), msg);
      }
      yorubot.sendPrivateMsg(userId, `[YoruSystem] Push ${tweetId} to ${targetGroupId} successed.`);
    }
  }
}
