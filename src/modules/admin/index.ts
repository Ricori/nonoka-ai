import nnkbot from '@/core/nnkBot';
import { EventKind, ModuleContext, NonokaModule } from '@/core/nnkModule';
import { PrivateMessageData } from '@/types/event';
import messageStorage from '@/modules/aiReply/storage/message';

const HELP_TEXT = [
  '=== Nonoka Admin Commands ===',
  '',
  '/help',
  '  显示所有可用命令',
  '',
  '/clean-memory',
  '  清理 AI 对话记忆缓存',
].join('\n');

type AdminCommand =
  | { cmd: 'help' }
  | { cmd: 'cleanMemory' };

class AdminModule extends NonokaModule<PrivateMessageData, AdminCommand> {
  readonly name = 'AdminModule';

  readonly events: EventKind[] = ['private'];

  match(ctx: ModuleContext<PrivateMessageData>): AdminCommand | false {
    const { user_id: userId, message } = ctx.data;
    if (!nnkbot.config.admin.includes(userId)) return false;

    if (message === '/help') return { cmd: 'help' };
    if (message === '/clean-memory') return { cmd: 'cleanMemory' };
    return false;
  }

  async run(ctx: ModuleContext<PrivateMessageData>, hit: AdminCommand) {
    if (hit.cmd === 'help') {
      ctx.reply(HELP_TEXT);
      return;
    }

    if (hit.cmd === 'cleanMemory') {
      messageStorage.cleanChatConversations();
      ctx.reply('[NonokaSystem] Memory cleaned.');
    }
  }
}

export default new AdminModule();
