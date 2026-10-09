import nnkbot from '@/core/nnkBot';
import { EventKind, ModuleContext, NonokaModule } from '@/core/nnkModule';
import { PrivateMessageData } from '@/types/event';
import { createMsgFromTweetId } from '@/service/twitter/message';
import messageStorage from '@/modules/aiReply/storage/message';
import nnkSchedule from '@/core/nnkSchedule';
import { isBotAdmin } from '@/modules/common/permission';

const HELP_TEXT = [
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
  '/p <groupId> <tweetUrl|tweetId>',
  '  推送推文到指定群组',
  '  示例: /p 123456 https://twitter.com/user/status/123456',
  '  示例: /p 123456 123456',
].join('\n');

/** /task 名称 → 定时任务 id */
const TASK_IDS = new Map([
  ['twitter', 'twitterPush'],
  ['bilibili', 'bilibiliNewShared'],
]);

type AdminCommand =
  | { cmd: 'help' }
  | { cmd: 'cleanMemory' }
  | { cmd: 'task'; task: string; enable: boolean }
  | { cmd: 'pushTweet'; groupId: number; tweetId: string };

class AdminModule extends NonokaModule<PrivateMessageData, AdminCommand> {
  readonly name = 'AdminModule';

  readonly events: EventKind[] = ['private'];

  match(ctx: ModuleContext<PrivateMessageData>): AdminCommand | false {
    const { user_id: userId, message } = ctx.data;
    if (!isBotAdmin(userId)) return false;

    if (message === '/help') return { cmd: 'help' };

    if (message === '/clean-memory') return { cmd: 'cleanMemory' };

    // /task <taskName> <on|off>
    const taskMatch = message.match(/^\/task\s+(\w+)\s+(on|off)$/);
    if (taskMatch) return { cmd: 'task', task: taskMatch[1], enable: taskMatch[2] === 'on' };

    // /p <groupId> <tweetUrl|tweetId>
    const pushTweetMatch = message.match(/^\/p\s+(\d+)\s+(?:\S*status\/)?(\d+)$/);
    if (pushTweetMatch) return { cmd: 'pushTweet', groupId: Number(pushTweetMatch[1]), tweetId: pushTweetMatch[2] };

    return false;
  }

  async run(ctx: ModuleContext<PrivateMessageData>, hit: AdminCommand) {
    switch (hit.cmd) {
      case 'help':
        ctx.reply(HELP_TEXT);
        return;

      case 'cleanMemory':
        messageStorage.cleanChatConversations();
        ctx.reply('[NonokaSystem] Memory cleaned.');
        return;

      case 'task':
        this.handleTaskControl(ctx, hit.task, hit.enable);
        return;

      case 'pushTweet': {
        const msgArr = await createMsgFromTweetId(hit.tweetId);
        if (!msgArr?.length) return;
        for (const msg of msgArr) {
          nnkbot.sendGroupMsg(hit.groupId, msg);
        }
        ctx.reply(`[NonokaSystem] Push ${hit.tweetId} to ${hit.groupId} succeeded.`);
        break;
      }

      default:
    }
  }

  /** 定时任务开关控制 */
  private handleTaskControl(ctx: ModuleContext<PrivateMessageData>, task: string, enable: boolean) {
    const taskId = TASK_IDS.get(task);
    if (!taskId) {
      ctx.reply('[NonokaSystem] Unsupported task.');
      return;
    }

    if (enable) {
      nnkSchedule.startById(taskId);
    } else {
      nnkSchedule.stopById(taskId);
    }
    ctx.reply(`[NonokaSystem] Task ${task} ${enable ? 'enabled' : 'disabled'}.`);
  }
}

export default new AdminModule();
