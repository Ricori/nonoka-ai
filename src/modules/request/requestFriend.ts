import { RequestFirendMessageData } from '@/types/event';
import nnkbot from '@/core/nnkBot';
import nnkStorage from '@/core/nnkStorage';
import NonokaModuleBase from '../base';

export default class RequestFriendModule extends NonokaModuleBase<RequestFirendMessageData> {
  static NAME = 'RequestFriendModule';

  async checkConditions() {
    return true;
  }

  async run() {
    const userId = this.data.user_id;
    const { flag } = this.data;
    if (nnkbot.config.autoAddFriend || nnkStorage.getIsInToBeAddedList(userId)) {
      // Agree to be added as a friend
      nnkbot.setFriendAddRequest(flag, true);
      // Delete id from to be added list
      nnkStorage.deleteIdFromToBeAddedList(userId);
      // Send notification to administrator
      (nnkbot.config.admin || []).forEach((adminId) => {
        if (!Number.isNaN(Number(adminId))) {
          nnkbot.sendPrivateMsg(adminId, `[SystemMessage] 新增好友，Id：${userId}`);
        }
      });
    } else {
      // Refuse to be friends
      nnkbot.setFriendAddRequest(flag, false);
    }

    // finish
    this.finished = true;
  }
}
