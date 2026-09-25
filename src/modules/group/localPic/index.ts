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
  deleteSentPicture, downloadImage, getKeywords, getRandomPicture, PICTURE_DIR, recordSentPicture, refreshKeywords,
} from './functions';

/** match 命中时传递给 run 的数据 */
type LocalPicHit =
  | { action: 'add' }
  | { action: 'delete' }
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

    // 检查是否是 /删图 命令（需引用图片消息）
    if (removeCQCodes(message).trim() === '/删图') {
      return { action: 'delete' };
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
    } else if (hit.action === 'delete') {
      await this.handleDeletePicture(ctx);
    } else {
      await this.handleSendPicture(ctx, hit.keyword);
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

  /** 处理 /删图 命令：群主/群管理员或 bot 管理员引用图片后删除 */
  private async handleDeletePicture(ctx: ModuleContext<GroupMessageData>) {
    const { message, user_id: userId, sender } = ctx.data;

    const isGroupAdmin = sender.role === 'owner' || sender.role === 'admin';
    const isBotAdmin = (nnkbot.config.admin || []).includes(userId);
    if (!isGroupAdmin && !isBotAdmin) {
      ctx.reply('只有管理员可以删图', { at: true });
      return;
    }

    if (!hasReply(message)) {
      ctx.reply('请引用要删除的图片发送 /删图', { at: true });
      return;
    }

    let keyword: string | null = null;
    try {
      keyword = deleteSentPicture(Number(getReplyMsgId(message)));
    } catch (e: any) {
      printError(`[LocalPic] Delete picture error: ${e.message}`);
    }

    if (keyword) {
      ctx.reply(`已从「${keyword}」删除图片`);
      printLog(`[LocalPic] ${userId} 从 ${keyword} 删除了图片`);
    } else {
      // 只记录了 bot 最近发出的图，重启后记录清空
      ctx.reply('找不到这张图，请引用 bot 最近发出的图片', { at: true });
    }
  }

  /** 处理关键词匹配，发送随机图片 */
  private async handleSendPicture(ctx: ModuleContext<GroupMessageData>, keyword: string) {
    const picPath = getRandomPicture(keyword);
    if (!picPath) return;

    const fileUri = `file:///${picPath.replace(/\\/g, '/')}`;
    // 记下 message_id，供 /删图 引用时定位本地文件
    const messageId = await nnkbot.sendGroupMsg(ctx.data.group_id, getImgCode(fileUri));
    if (messageId) recordSentPicture(messageId, picPath);
  }
}

export default new LocalPictureModule();
