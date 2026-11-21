interface PrivateSender {
  /** 发送者QQ号 */
  user_id?: number,
  /** 昵称 */
  nickname?: string,
  /** 性别 */
  sex?: 'male' | 'female' | 'unknown',
  /** 年龄 */
  age?: number
}

interface GroupSender extends PrivateSender {
  /** 群名片／备注 */
  card?: string,
  /** 地区 */
  area?: string,
  /** 成员等级 */
  level?: string,
  /** 角色, owner 或 admin 或 member */
  role?: string,
  /** 专属头衔 */
  title?: string,
}

/** 简单消息类型 */
export interface SimpleMessageData {
  /** 消息ID */
  message_id: number,
  /** 收到事件的机器人 QQ 号 */
  self_id: number,
  /** 发送者信息 */
  sender: PrivateSender,
  /** 发送者QQ号 */
  user_id: number,
  /** 上报类型 */
  post_type: 'message',
  /** 消息真实id */
  real_id: number,
  /** 事件发生的时间戳 */
  time: number,
  /** 消息内容 */
  message: string,
  /** 原始消息内容 */
  raw_message: string,
  /** 字体 */
  font: number,
}

/** 私聊消息类型 */
export interface PrivateMessageData extends SimpleMessageData {
  /** 发送者信息 */
  sender: PrivateSender,
  /** 消息类型 */
  message_type: 'private',
  /** 消息子类型,好友=friend,群临时会话=group */
  sub_type: 'friend' | 'group' | 'other',
  /** 临时会话来源 */
  temp_source: number,
}

/** 群消息类型 */
export interface GroupMessageData extends SimpleMessageData {
  /** 发送者信息 */
  sender: GroupSender,
  /** 消息类型 */
  message_type: 'group',
  /** 消息子类型,正常消息=normal,匿名消息=anonymous,系统提示=notice */
  sub_type: 'normal' | 'anonymous' | 'notice',
  /** 群号 */
  group_id: number,
}

/** 消息类型 */
export type MessageType = SimpleMessageData | PrivateMessageData | GroupMessageData;
