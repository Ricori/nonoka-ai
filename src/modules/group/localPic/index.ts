import path from 'path';
import nnkbot from '@/core/nnkBot';
import { EventKind, ModuleContext, NonokaModule } from '@/core/nnkModule';
import { GroupMessageData } from '@/types/event';
import { getImgCode, removeCQCodes } from '@/utils/msgCode';
import {
  getImgs, getReplyMsgId, hasImage, hasReply,
} from '@/utils/function';
import { printError, printLog } from '@/utils/print';
import {
  downloadImage, getKeywords, getRandomPicture, PICTURE_DIR, refreshKeywords,
} from './functions';

/** match 命中时传递给 run 的数据 */
type LocalPicHit =
  | { action: 'add' }
  | { action: 'send'; keyword: string };

class LocalPictureModule extends NonokaModule<GroupMessageData, LocalPicHit> {
  readonly name = 'LocalPictureModule';

  readonly events: EventKind[] = ['group'];

  match(ctx: ModuleContext<GroupMessageData>): LocalPicHit | false {
    const { message } = ctx.data;

    // 检查是否是 /加图 命令
    if (message.includes('/加图')) {
      return { action: 'add' };
    }

    // 检查消息是否是已注册的关键词
    const keywords = getKeywords();
    for (const keyword of keywords) {
      if (message === keyword) {
        return { action: 'send', keyword };
      }
    }

    return false;
  }

  async run(ctx: ModuleContext<GroupMessageData>, hit: LocalPicHit) {
    if (hit.action === 'add') {
      await this.handleAddPicture(ctx);
    } else {
      this.handleSendPicture(ctx, hit.keyword);
    }
  }

  /** 处理 /加图 命令 */
  private async handleAddPicture(ctx: ModuleContext<GroupMessageData>) {
    const { message, user_id: userId } = ctx.data;

    // 解析关键词：/加图 xxx
    const match = removeCQCodes(message).match(/\/加图\s+(\S+)/);
    if (!match) {
      ctx.reply('格式：/加图 nsy名', { at: true });
      return;
    }
    const keyword = match[1];
    if (keyword.length < 2) {
      ctx.reply('关键词至少需要两个字', { at: true });
      return;
    }
    if (keyword.includes('龙')) {
      ctx.reply('该关键词不允许使用', { at: true });
      return;
    }

    const imgs = [] as { file: string, url: string }[];
    if (hasReply(message)) {
      // 从引用的消息中提取图片
      const replyMsgId = getReplyMsgId(message);
      const replyMsgData = await nnkbot.getMessageFromId(replyMsgId);
      if (replyMsgData && hasImage(replyMsgData.message)) {
        imgs.push(...getImgs(replyMsgData.message));
      }
    }
    imgs.push(...getImgs(message));

    if (imgs.length === 0) {
      return;
    }

    const destDir = path.join(PICTURE_DIR, keyword);
    let successCount = 0;

    for (const img of imgs) {
      try {
        await downloadImage(img.url, destDir);
        successCount++;
      } catch (e: any) {
        printError(`[LocalPic] Download picture error: ${e.message}`);
      }
    }

    if (successCount > 0) {
      refreshKeywords();
      ctx.reply(`已存储 ${successCount} 张图片到「${keyword}」`);
      printLog(`[LocalPic] ${userId} 添加了 ${successCount} 张图片到 ${keyword}`);
    } else {
      ctx.reply('图片保存失败，请重试', { at: true });
    }
  }

  /** 处理关键词匹配，发送随机图片 */
  private handleSendPicture(ctx: ModuleContext<GroupMessageData>, keyword: string) {
    const picPath = getRandomPicture(keyword);
    if (!picPath) return;

    const fileUri = `file:///${picPath.replace(/\\/g, '/')}`;
    ctx.reply(getImgCode(fileUri));
  }
}

export default new LocalPictureModule();
