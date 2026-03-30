import { ChatCompletionMessageParam } from 'openai/resources';

const MAX_CHAT_HISTORY_COUNT = 15;

interface RepeaterLog {
  msg: string,
  times: number,
  done: boolean,
}

class YoruStorage {
  /** 自动同意好友请求的名单  */
  private toBeAddedList = new Set<number>();

  /** 复读记录  */
  private repeaterData = new Map<number, RepeaterLog>();

  /** 各平台最新内容时间 (key: "bili-{uid}" | "twitter-{username}") */
  private lastestSNSUpdateTime = new Map<string, number>();

  /** 私聊消息对话记录 (key: qq) */
  private privateChatConversations = new Map<number, ChatCompletionMessageParam[]>();

  /** 群消息对话记录  (key: groupId) */
  private groupChatConversations = new Map<number, ChatCompletionMessageParam[]>();

  /** 新增好友到待添加名单 */
  joinToBeAddedList = (userId: number) => { this.toBeAddedList.add(userId); };

  /** 检查是否在待添加的好友名单中 */
  getIsInToBeAddedList = (userId: number) => this.toBeAddedList.has(userId);

  /** 在待添加的好友名单中删除某用户 */
  deleteIdFromToBeAddedList = (userId: number) => { this.toBeAddedList.delete(userId); };

  /** 记录某群复读情况
   * @param {number} groupId 群号
   * @param {string} msg 消息
   * @returns 如果已经复读则返回0，否则返回当前复读次数
   */
  saveRepeaterLog(groupId: number, msg: string) {
    const logObj = this.repeaterData.get(groupId);
    // 没有记录或另起复读则新建记录
    if (!logObj || logObj.msg !== msg) {
      const newLog: RepeaterLog = { msg, times: 1, done: false };
      this.repeaterData.set(groupId, newLog);
      return 1;
    }
    // 已经复读过则跳过
    if (logObj.done) return 0;
    logObj.times += 1;
    return logObj.times;
  }

  /** 标记某群已复读
   *  @param {number} groupId 群号
  */
  setRepeaterDone(groupId: number) {
    const logObj = this.repeaterData.get(groupId);
    if (logObj) {
      logObj.done = true;
    }
  }

  /** 设置某up最新动态时间 */
  setBiliLastestDynamicTime(uid: string, time: number) {
    this.lastestSNSUpdateTime.set(`bili-${uid}`, time);
  }

  /** 获取某up最新动态时间 */
  getBiliLastestDynamicTime(uid: string) {
    return this.lastestSNSUpdateTime.get(`bili-${uid}`) ?? 0;
  }

  /** 设置某推特用户最新推文时间 */
  setTwitterLastestTweetTime(username: string, time: number) {
    this.lastestSNSUpdateTime.set(`twitter-${username}`, time);
  }

  /** 获取某推特用户最新推文时间 */
  getTwitterLastestTweetTime(username: string) {
    return this.lastestSNSUpdateTime.get(`twitter-${username}`) ?? 0;
  }

  /** 向指定会话记录中追加消息并裁剪 */
  private appendChatMessage(
    store: Map<number, ChatCompletionMessageParam[]>,
    key: number,
    messageParam: ChatCompletionMessageParam,
  ) {
    if (!store.has(key)) {
      store.set(key, []);
    }
    const history = store.get(key)!;

    // 每5条消息添加 cache_control
    let msg: ChatCompletionMessageParam = messageParam;
    if (history.length > 0 && history.length % 5 === 0) {
      const content = typeof messageParam.content === 'string'
        ? [{ type: 'text', text: messageParam.content, cache_control: { type: 'ephemeral' } } as any]
        : messageParam.content;
      msg = { ...messageParam, content } as any;
    }

    history.push(msg);
    if (history.length > MAX_CHAT_HISTORY_COUNT + 10) {
      history.splice(0, history.length - MAX_CHAT_HISTORY_COUNT);
      while (history.length > 0 && history[0].role === 'assistant') {
        history.shift();
      }
    }
  }

  /** 添加某qq私聊会话记录 */
  addPrivateChatMessage(userId: number, messageParam: ChatCompletionMessageParam) {
    this.appendChatMessage(this.privateChatConversations, userId, messageParam);
  }

  /** 获取某qq私聊会话记录 */
  getPrivateChatMessage(userId: number): ChatCompletionMessageParam[] {
    return this.privateChatConversations.get(userId) || [];
  }

  /** 添加某群会话记录 */
  addGroupChatConversations(groupId: number, messageParam: ChatCompletionMessageParam) {
    this.appendChatMessage(this.groupChatConversations, groupId, messageParam);
  }

  /** 获取某群会话记录 */
  getGroupChatConversations(groupId: number) {
    return this.groupChatConversations.get(groupId) || [];
  }

  /** 修剪某群会话记录 */
  trimGroupChatConversations(groupId: number) {
    let imageCount = 0;
    const history = this.groupChatConversations.get(groupId)!;
    // 倒序遍历消息
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      // 判断消息 content 是不是多模态数组
      if (Array.isArray(msg.content)) {
        imageCount++;
        // 如果超过 1 张图
        if (imageCount > 1) {
          const downgradedText = (msg.content[0] as { text: string }).text;
          // 多模态消息改为纯文本消息
          history[i] = {
            ...msg,
            content: downgradedText,
          };
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

export default new YoruStorage();
