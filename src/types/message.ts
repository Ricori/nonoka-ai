export interface FormattedMessage {
  /** 消息角色 */
  role: 'user' | 'assistant';
  /** 消息的userId */
  userId: number;
  /** 是否提到了bot */
  isMentionMe: boolean;
  /** 文本消息 */
  message: string;
  /** 图片URL */
  imgUrl?: string;
  /** 是否添加缓存标记 */
  cacheControl?: boolean;
}
