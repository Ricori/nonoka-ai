import { MessageType } from '@/types/event';


export default class NonokaModuleBase<T extends MessageType> {
  /** 模块唯一名称 */
  static NAME = '';

  /** 消息数据 */
  protected data: T;

  /** 结束标志，为true时将中止调用链（下个Module不会调用） */
  protected finished = true;

  /** 调用链上共享的额外数据 */
  protected extraData: Record<string, string>;

  constructor(data: T, extraData: Record<string, string>) {
    this.data = data;
    this.extraData = extraData;
  }

  /** 检查是否命中条件，如命中返回true */
  async checkConditions() {
    return false;
  }

  /** 命中条件后具体操作方法
   * 如需要运行完后继续调用链，请设定 this.finished = false;
   * 如有需要传递给后续Module的信息，请修改 this.extraData;
   */
  async run(): Promise<void> {
    return undefined;
  }

  /** 处理后续数据 */
  processingNextData() {
    return { finished: this.finished, extraData: this.extraData };
  }
}

