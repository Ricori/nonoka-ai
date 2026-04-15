import path from 'path';
import { GroupMessageData } from '@/types/event';
import NonokaModuleBase from '@/modules/base';
import nnkbot from '@/core/nnkBot';
import { getImgCode } from '@/utils/msgCode';
import {
  getImgs, getReplyMsgId, hasImage, hasReply,
} from '@/utils/function';
import { printError, printLog } from '@/utils/print';
import {
  downloadImage, getKeywords, getRandomPicture, PICTURE_DIR, refreshKeywords,
} from './functions';


export default class LocalPictureModule extends NonokaModuleBase<GroupMessageData> {
  static NAME = 'LocalPictureModule';

  private isAddCommand = false;

  private matchedKeyword: string | null = null;

  async checkConditions() {
    const { message } = this.data;

    // 检查是否是 /加图 命令
    if (message.includes('/加图')) {
      this.isAddCommand = true;
      return true;
    }

    // 检查消息是否是已注册的关键词
    const keywords = getKeywords();
    for (const keyword of keywords) {
      if (message === keyword) {
        this.matchedKeyword = keyword;
        return true;
      }
    }

    return false;
  }


  async run() {
    const { message, group_id: groupId, user_id: userId } = this.data;

    if (this.isAddCommand) {
      await this.handleAddPicture(message, groupId, userId);
    } else if (this.matchedKeyword) {
      await this.handleSendPicture(groupId);
    }
  }

  /** 处理 /加图 命令 */
  private async handleAddPicture(message: string, groupId: number, userId: number) {
    // 解析关键词：/加图 xxx
    const match = message.replace(/\[CQ:[^\]]+\]/g, '').match(/\/加图\s+(\S+)/);
    if (!match) {
      nnkbot.sendGroupMsg(groupId, '格式：/加图 nsy名', userId);
      return;
    }
    const keyword = match[1];
    if (keyword.length < 2) {
      nnkbot.sendGroupMsg(groupId, '关键词至少需要两个字', userId);
      return;
    }
    if (keyword.includes('龙')) {
      nnkbot.sendGroupMsg(groupId, '该关键词不允许使用', userId);
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
      nnkbot.sendGroupMsg(groupId, `已存储 ${successCount} 张图片到「${keyword}」`);
      printLog(`[LocalPic] ${userId} 添加了 ${successCount} 张图片到 ${keyword}`);
    } else {
      nnkbot.sendGroupMsg(groupId, '图片保存失败，请重试', userId);
    }
  }

  /** 处理关键词匹配，发送随机图片 */
  private async handleSendPicture(groupId: number) {
    const picPath = getRandomPicture(this.matchedKeyword!);
    if (!picPath) return;

    const fileUri = `file:///${picPath.replace(/\\/g, '/')}`;
    nnkbot.sendGroupMsg(groupId, getImgCode(fileUri));
  }
}
