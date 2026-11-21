import fs from 'fs';
import path from 'path';
import type { FormattedMessage } from '@/types/message';
import { printError } from '@/utils/print';
import { backupDateKey, CHAT_BACKUP_DIR } from '@/memory/backup';

export { backupDateKey, CHAT_BACKUP_DIR };

const MAX_MESSAGE_CONTEXT_COUNT = 20;
const CHAT_HISTORY_TRIM_BATCH_SIZE = 20;

/**
 * bot 自己的发言在备份日志里额外标注触发方式、工具调用次数与点名注入条数：
 * `[0][主动 0.12]内容`、`[0][被动][工具 2][点名 1]内容`。
 * 供离线统计区分主动插话与被 @ 应答，以及核对工具/点名的触发频率。
 *
 * 旧日志里的 `[旧账 N]` 是同一个位置上的前身（关键词预注入时代），解析侧仍然认它
 */
function backupTriggerMark(msg: FormattedMessage): string {
  const marks: string[] = [];
  if (msg.initiative !== undefined) {
    marks.push(msg.initiative ? `[主动 ${msg.chance ?? 0}]` : '[被动]');
  }
  if (msg.toolCalls) marks.push(`[工具 ${msg.toolCalls}]`);
  if (msg.mentionHits) marks.push(`[点名 ${msg.mentionHits}]`);
  return marks.join('');
}

class MessageStorage {
  /** 私聊消息对话记录 (key: qq) */
  private privateChatConversations = new Map<number, FormattedMessage[]>();

  /** 群消息对话记录  (key: groupId) */
  private groupChatConversations = new Map<number, FormattedMessage[]>();

  /** 获取传给模型的最近上下文，最多 20 条 */
  private getRecentContext(history: FormattedMessage[]): FormattedMessage[] {
    return history.slice(-MAX_MESSAGE_CONTEXT_COUNT);
  }

  /** 将群聊裁掉的消息追加备份到当日文件，不覆盖已有内容 */
  private async backupGroupHistory(groupId: number, messages: FormattedMessage[]) {
    try {
      const file = path.join(CHAT_BACKUP_DIR, `${groupId}_${backupDateKey()}.txt`);
      const lines = `${messages.map((m) => `[${m.userId}]${backupTriggerMark(m)}${m.message}`).join('\n')}\n`;
      await fs.promises.appendFile(file, lines, 'utf-8');
    } catch (e) {
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

    history.push(msg);

    if (history.length >= MAX_MESSAGE_CONTEXT_COUNT + CHAT_HISTORY_TRIM_BATCH_SIZE) {
      // 裁掉哪一批就备份哪一批，备份与裁剪共用同一阈值和消息快照
      const trimmedMessages = history.splice(0, CHAT_HISTORY_TRIM_BATCH_SIZE);
      if (store === this.groupChatConversations) {
        this.backupGroupHistory(key, trimmedMessages);
      }
    }
  }

  /** 添加某qq私聊会话记录 */
  addPrivateChatMessage(userId: number, msg: FormattedMessage) {
    this.appendChatMessage(this.privateChatConversations, userId, msg);
  }

  /** 获取某qq私聊会话记录 */
  getPrivateChatMessage(userId: number): FormattedMessage[] {
    return this.getRecentContext(this.privateChatConversations.get(userId) || []);
  }

  /** 添加某群会话记录 */
  addGroupChatConversations(groupId: number, msg: FormattedMessage) {
    this.appendChatMessage(this.groupChatConversations, groupId, msg);
  }

  /** 获取某群会话记录 */
  getGroupChatConversations(groupId: number): FormattedMessage[] {
    return this.getRecentContext(this.groupChatConversations.get(groupId) || []);
  }


  /** 清理所有会话缓存 */
  cleanChatConversations() {
    this.privateChatConversations.clear();
    this.groupChatConversations.clear();
  }
}

export default new MessageStorage();
