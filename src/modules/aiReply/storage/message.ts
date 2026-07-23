import fs from 'fs';
import path from 'path';
import type { FormattedMessage } from '@/types/message';
import { printError } from '@/utils/print';

const MAX_CHAT_HISTORY_COUNT = 10;
const CHAT_BACKUP_DIR = path.resolve('data/memory/chat');

/**
 * bot 自己的发言在备份日志里额外标注触发方式：`[0][主动 0.12]内容` / `[0][被动]内容`，
 * 供离线统计区分主动插话与被 @ 应答
 */
function backupTriggerMark(msg: FormattedMessage): string {
  if (msg.initiative === undefined) return '';
  return msg.initiative ? `[主动 ${msg.chance ?? 0}]` : '[被动]';
}

class MessageStorage {
  /** 私聊消息对话记录 (key: qq) */
  private privateChatConversations = new Map<number, FormattedMessage[]>();

  /** 群消息对话记录  (key: groupId) */
  private groupChatConversations = new Map<number, FormattedMessage[]>();

  /** 每个群尚未备份到文件的消息条数 (key: groupId) */
  private groupUnbackedCount = new Map<number, number>();

  /** 将群聊新增消息追加备份到当日文件，不覆盖已有内容 */
  private async backupGroupHistory(groupId: number, history: FormattedMessage[]) {
    const count = Math.min(this.groupUnbackedCount.get(groupId) ?? 0, history.length);
    if (count === 0) return;
    // 在 await 前先取快照并清零计数，避免写盘期间新增的消息被漏记或重复
    const newMessages = history.slice(-count);
    this.groupUnbackedCount.set(groupId, 0);

    try {
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const file = path.join(CHAT_BACKUP_DIR, `${groupId}_${date}.txt`);
      const lines = `${newMessages.map((m) => `[${m.userId}]${backupTriggerMark(m)}${m.message}`).join('\n')}\n`;
      await fs.promises.appendFile(file, lines, 'utf-8');
    } catch (e) {
      // 写入失败则把这批消息计回待备份数量，下次备份时重试
      this.groupUnbackedCount.set(groupId, (this.groupUnbackedCount.get(groupId) ?? 0) + newMessages.length);
      printError('[MessageStorage] 备份群聊记录失败', e);
    }
  }

  /** 向指定会话记录中追加消息并裁剪 */
  private appendChatMessage(
    store: Map<number, FormattedMessage[]>,
    key: number,
    msg: FormattedMessage,
  ) {
    if (!store.has(key)) {
      store.set(key, []);
    }
    const history = store.get(key)!;

    // 第10条消息标记 Cache
    if (history.length === 9) {
      history.push({ ...msg, cacheControl: true });
    } else {
      history.push(msg);
    }

    // 每累计20条备份一次群聊记录
    if (store === this.groupChatConversations) {
      this.groupUnbackedCount.set(key, (this.groupUnbackedCount.get(key) ?? 0) + 1);
      if (history.length === MAX_CHAT_HISTORY_COUNT + 10) {
        this.backupGroupHistory(key, history);
      }
    }

    if (history.length > MAX_CHAT_HISTORY_COUNT + 10) {
      // 触发消息裁剪
      history.splice(0, history.length - MAX_CHAT_HISTORY_COUNT);
      while (history.length > 0 && history[0].role === 'assistant') {
        history.shift();
      }
      if (history.length > 0) {
        // 倒序遍历消息，修剪早期图片
        let imageCount = 0;
        for (let i = history.length - 1; i >= 0; i--) {
          const m = history[i];
          if (m.imgUrl) {
            imageCount++;
            if (imageCount > 1) {
              history[i] = { ...m, imgUrl: undefined };
            }
          }
        }
        // 清理后最后一条消息标记 Cache
        history[history.length - 1].cacheControl = true;
      }
    }
  }

  /** 添加某qq私聊会话记录 */
  addPrivateChatMessage(userId: number, msg: FormattedMessage) {
    this.appendChatMessage(this.privateChatConversations, userId, msg);
  }

  /** 获取某qq私聊会话记录 */
  getPrivateChatMessage(userId: number): FormattedMessage[] {
    return this.privateChatConversations.get(userId) || [];
  }

  /** 添加某群会话记录 */
  addGroupChatConversations(groupId: number, msg: FormattedMessage) {
    this.appendChatMessage(this.groupChatConversations, groupId, msg);
  }

  /** 获取某群会话记录 */
  getGroupChatConversations(groupId: number): FormattedMessage[] {
    return this.groupChatConversations.get(groupId) || [];
  }


  /** 清理所有会话缓存 */
  cleanChatConversations() {
    this.privateChatConversations.clear();
    this.groupChatConversations.clear();
    // 会话已清空，未备份计数一并重置，避免下次备份时把新消息误当增量
    this.groupUnbackedCount.clear();
  }
}

export default new MessageStorage();
