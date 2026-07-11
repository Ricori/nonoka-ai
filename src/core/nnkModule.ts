import { GroupMessageData, PrivateMessageData, RequestFirendMessageData } from '@/types/event';

/** 事件与消息数据的映射 */
export interface EventDataMap {
  /** 好友请求 */
  'request': RequestFirendMessageData;
  /** 私聊消息 */
  'private': PrivateMessageData;
  /** 所有群消息（at + 非at） */
  'group': GroupMessageData;
  /** 仅被at的群消息 */
  'group:at': GroupMessageData;
  /** 仅未被at的群消息 */
  'group:plain': GroupMessageData;
}

export type EventKind = keyof EventDataMap;

/** run 的返回值：'continue' 继续调用链，'stop' 或 void 断链 */
export type FlowResult = void | 'stop' | 'continue';

/** 所有消息数据的联合类型 */
export type AnyMessageData = RequestFirendMessageData | PrivateMessageData | GroupMessageData;

export interface ModuleContext<D = AnyMessageData> {
  /** 原始消息数据（联合类型，可用 message_type 收窄） */
  data: D;
  /** 群消息是否@了bot（非群消息恒为 false） */
  isAtMe: boolean;
  /** 回复本条消息的来源（自动区分群/私聊；at 为 true 时在群里@发送者） */
  reply(msg: string, opts?: { at?: boolean; plainText?: boolean }): void;
}

/**
 * 消息处理模块基类。
 *
 * 泛型：D 为模块处理的消息数据类型；Hit 为 match 传递给 run 的命中数据类型。
 *
 * 注意：模块以单例注册（export default new XxxModule()），实例在所有消息间共享。
 * 不要用实例字段保存单条消息相关的状态，匹配阶段算出的数据请通过 match 返回值传给 run。
 */
export abstract class NonokaModule<D extends AnyMessageData = AnyMessageData, Hit = boolean> {
  /** 模块唯一名称 */
  abstract readonly name: string;

  /** 订阅的事件 */
  abstract readonly events: EventKind[];

  /** 可选的启动初始化，模块注册时执行一次 */
  init?(): void;

  /** 命中判定：返回 false 未命中；返回 true 或任意对象则命中（返回值会作为第二参数传给 run）。
   *  禁止副作用（写状态、发消息等都放 run）。 */
  abstract match(ctx: ModuleContext<D>): Hit | false | Promise<Hit | false>;

  /** 命中后的处理。返回 'continue' 继续调用链，返回 void 或 'stop' 断链（默认断链）。 */
  abstract run(ctx: ModuleContext<D>, hit: Hit): FlowResult | Promise<FlowResult>;
}

/** 擦除泛型后的模块类型，供注册与调度使用 */
export type AnyNonokaModule = NonokaModule<any, any>;
