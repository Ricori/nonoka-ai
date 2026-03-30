import { FormattedMessage } from '../../../types/message';

const MAX_CHAT_HISTORY_COUNT = 15;

class MessageStorage {
  /** 私聊消息对话记录 (key: qq) */
  private privateChatConversations = new Map<number, FormattedMessage[]>();

  /** 群消息对话记录  (key: groupId) */
  private groupChatConversations = new Map<number, FormattedMessage[]>();

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

    // 每5条消息标记 useCache
    if (history.length > 0 && history.length % 5 === 0) {
      history.push({ ...msg, cacheControl: true });
    } else {
      history.push(msg);
    }

    if (history.length > MAX_CHAT_HISTORY_COUNT + 10) {
      history.splice(0, history.length - MAX_CHAT_HISTORY_COUNT);
      while (history.length > 0 && history[0].role === 'assistant') {
        history.shift();
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

  /** 修剪某群会话记录：只保留最近1张图片 */
  trimGroupChatConversations(groupId: number) {
    let imageCount = 0;
    const history = this.groupChatConversations.get(groupId);
    if (!history) return;
    // 倒序遍历消息
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (msg.imgUrl) {
        imageCount++;
        if (imageCount > 1) {
          // 去掉多余的图片
          history[i] = { ...msg, imgUrl: undefined };
        }
      }
    }
  }

  /** 清理所有会话缓存 */
  cleanChatConversations() {
    this.privateChatConversations.clear();
    this.groupChatConversations.clear();
  }
}

export default new MessageStorage();
