import nnkbot from '@/core/nnkBot';
import { EventKind, ModuleContext, NonokaModule } from '@/core/nnkModule';
import { PrivateMessageData } from '@/types/event';
import { createMsgFromTweetId } from '@/service/twitter/message';
import messageStorage from '@/modules/aiReply/storage/message';
import nnkSchedule from '@/core/nnkSchedule';

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
  '',
  '/tts <text>',
  '  文字转语音',
  '  示例: /tts おはようございます。',
].join('\n');

type AdminCommand =
  | { cmd: 'help' }
  | { cmd: 'cleanMemory' }
  | { cmd: 'task'; task: string; action: string }
  | { cmd: 'pushTweet'; groupId: string; tweetId: string };

class AdminModule extends NonokaModule<PrivateMessageData, AdminCommand> {
  readonly name = 'AdminModule';

  readonly events: EventKind[] = ['private'];

  match(ctx: ModuleContext<PrivateMessageData>): AdminCommand | false {
    // Check userId in admin list
    const adminList = nnkbot.config.admin || [];
    if (adminList.indexOf(ctx.data.user_id) === -1) {
      return false;
    }
    // Exec administrator command
    const { message } = ctx.data;
    if (message === '/help') {
      return { cmd: 'help' };
    }
    if (message === '/clean-memory') {
      return { cmd: 'cleanMemory' };
    }
    const taskControlMatch = message.match(/^\/task\s+(\w+)\s+(on|off)$/);
    if (taskControlMatch) {
      return { cmd: 'task', task: taskControlMatch[1], action: taskControlMatch[2] };
    }
    const pushTweetMatch = message.match(/^\/p\s+(\d+).*(?:status\/|\s+)(\d+)$/);
    if (pushTweetMatch) {
      return { cmd: 'pushTweet', groupId: pushTweetMatch[1], tweetId: pushTweetMatch[2] };
    }
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
        this.handleTaskControl(ctx, hit.task, hit.action);
        return;
      case 'pushTweet': {
        const msgArr = await createMsgFromTweetId(hit.tweetId);
        if (!msgArr || msgArr.length === 0) return;
        for (const msg of msgArr) {
          nnkbot.sendGroupMsg(Number(hit.groupId), msg);
        }
        ctx.reply(`[NonokaSystem] Push ${hit.tweetId} to ${hit.groupId} successed.`);
        break;
      }
      default:
    }
  }

  /** 定时任务开关控制 */
  private handleTaskControl(ctx: ModuleContext<PrivateMessageData>, task: string, action: string) {
    switch (task) {
      case 'twitter':
        if (action === 'on') {
          nnkSchedule.startById('twitterPush');
          ctx.reply('[NonokaSystem] Twitter task enabled.');
        } else {
          nnkSchedule.stopById('twitterPush');
          ctx.reply('[NonokaSystem] Twitter task disabled.');
        }
        return;
      case 'bilibili':
        if (action === 'on') {
          nnkSchedule.startById('bilibiliNewShared');
          ctx.reply('[NonokaSystem] Bilibili task enabled.');
        } else {
          nnkSchedule.stopById('bilibiliNewShared');
          ctx.reply('[NonokaSystem] Bilibili task disabled.');
        }
        return;
      default:
        ctx.reply('[NonokaSystem] Unsupported task.');
    }
  }
}

export default new AdminModule();
