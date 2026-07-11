import nnkbot from '@/core/nnkBot';
import nnkStorage from '@/core/nnkStorage';
import {
  EventKind, FlowResult, ModuleContext, NonokaModule,
} from '@/core/nnkModule';
import { GroupMessageData } from '@/types/event';

class RepeaterModule extends NonokaModule<GroupMessageData> {
  readonly name = 'RepeaterModule';

  readonly events: EventKind[] = ['group:plain'];

  match(ctx: ModuleContext<GroupMessageData>) {
    if (!nnkbot.config.repeater.enable) return false;
    return !nnkbot.config.repeater.blackList.includes(ctx.data.group_id);
  }

  run(ctx: ModuleContext<GroupMessageData>): FlowResult {
    const { message, group_id: groupId } = ctx.data;

    // 复读计数（放在 run 而非 match，避免副作用受链上前序模块影响）
    const times = nnkStorage.saveRepeaterLog(groupId, message);
    const randomValue = Math.floor(Math.random() * 2);
    if (times < 2 + randomValue) return 'continue';

    nnkStorage.setRepeaterDone(groupId);
    setTimeout(() => {
      ctx.reply(message);
    }, 1200);
    return 'stop';
  }
}

export default new RepeaterModule();
