import type { FormattedMessage } from '@/types/message';

const MAX_CHAT_HISTORY_COUNT = 10;

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

    // 第10条消息标记 Cache
    if (history.length === 9) {
      history.push({ ...msg, cacheControl: true });
    } else {
      history.push(msg);
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
  }
}

export default new MessageStorage();
