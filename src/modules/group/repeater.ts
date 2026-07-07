
import { GroupMessageData } from '@/types/event';
import NonokaModuleBase from '@/modules/base';
import nnkbot from '@/core/nnkBot';
import nnkStorage from '@/core/nnkStorage';

export default class RepeaterModule extends NonokaModuleBase<GroupMessageData> {
  static NAME = 'RepeaterModule';

  async checkConditions() {
    if (!nnkbot.config.repeater.enable) return false;
    const { message, group_id: groupId } = this.data;
    if (nnkbot.config.repeater.blackList.includes(groupId)) return false;

    const times = nnkStorage.saveRepeaterLog(groupId, message);
    const randomValue = Math.floor(Math.random() * 2);
    return times >= 2 + randomValue;
  }

  async run() {
    const { message, group_id: groupId } = this.data;
    nnkStorage.setRepeaterDone(groupId);

    setTimeout(() => {
      nnkbot.sendGroupMsg(groupId, message);
    }, 1200);
  }
}
