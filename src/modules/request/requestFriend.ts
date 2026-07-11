import nnkbot from '@/core/nnkBot';
import nnkStorage from '@/core/nnkStorage';
import { EventKind, ModuleContext, NonokaModule } from '@/core/nnkModule';
import { RequestFirendMessageData } from '@/types/event';

class RequestFriendModule extends NonokaModule<RequestFirendMessageData> {
  readonly name = 'RequestFriendModule';

  readonly events: EventKind[] = ['request'];

  match() {
    return true;
  }

  run(ctx: ModuleContext<RequestFirendMessageData>) {
    const { user_id: userId, flag } = ctx.data;
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
  }
}

export default new RequestFriendModule();
