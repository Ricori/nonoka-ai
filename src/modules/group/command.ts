import { GroupMessageData } from '@/types/event';
import yorubot from '@/core/yoruBot';
import { createMsgFromTweetId } from '@/tasks/twitter';
import YoruModuleBase from '../base';

export default class GroupCommandModule extends YoruModuleBase<GroupMessageData> {
  static NAME = 'GroupCommandModule';

  private initiativeMatch: RegExpMatchArray | null = null;

  private pushTweetMatch: RegExpMatchArray | null = null;

  async checkConditions() {
    const { message } = this.data;

    // Initiative conversation control - /initiative on|off
    this.initiativeMatch = message.match(/^\/initiative(?:\s+(on|off))?$/);
    if (this.initiativeMatch) return true;

    // Push twitter - /push-tweet <tweetUrl or tweetId>
    this.pushTweetMatch = message.match(/^\/push-tweet\s+(?:\S*status\/)?(\d+)$/);
    if (this.pushTweetMatch) return true;

    return false;
  }

  async run() {
    const { group_id: groupId } = this.data;

    // Initiative conversation
    if (this.initiativeMatch) {
      const action = this.initiativeMatch[1];
      const list = yorubot.config.aiReply.initiativeList;
      if (!action) {
        const isOn = list.includes(groupId);
        yorubot.sendGroupMsg(groupId, `[YoruSystem] 当前群主动对话状态: ${isOn ? '开启' : '关闭'}`);
      } else if (action === 'on') {
        if (!list.includes(groupId)) {
          list.push(groupId);
          yorubot.sendGroupMsg(groupId, '[YoruSystem] 已开启主动对话');
        }
      } else {
        const idx = list.indexOf(groupId);
        if (idx !== -1) {
          list.splice(idx, 1);
          yorubot.sendGroupMsg(groupId, '[YoruSystem] 已关闭主动对话');
        }
      }
    }

    // Push twitter
    if (this.pushTweetMatch) {
      const [, tweetId] = this.pushTweetMatch;
      const msgArr = await createMsgFromTweetId(tweetId);
      if (!msgArr || msgArr.length === 0) return;
      for (const msg of msgArr) {
        yorubot.sendGroupMsg(Number(groupId), msg);
      }
    }
  }
}
