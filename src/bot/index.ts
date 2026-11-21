import { wsConfig } from '@/config';
import { SimpleMessageData } from '@/types/event';
import { WSActionRes } from '@/types/ws';
import { getAtCode } from '@/utils/msgCode';
import { printError, printLog } from '@/utils/print';
import { MessageHandlers, OneBotWS } from './ws';

const debugMode = process.env.YDEBUG === 'true';

class BotClient {
  private ws = new OneBotWS(wsConfig);

  readonly debugMode = debugMode;

  private async invoke(method: string, params: Record<string, any>, timeout?: number): Promise<WSActionRes | undefined> {
    try {
      const res = await this.ws.call(method, params, timeout);
      if (res.retcode === 0) return res;
      printError(`[WS Call Fail][${method}] ${res.wording || res.message || res.msg || res.retcode}`);
    } catch (e) {
      printError(`[WS Call Error][${method}] ${e}`);
    }
    return undefined;
  }

  private async callData<T>(method: string, params: Record<string, any>, timeout?: number): Promise<T | undefined> {
    const res = await this.invoke(method, params, timeout);
    return res?.data ?? undefined;
  }

  /** 启动连接并绑定消息回调 */
  start(handlers: MessageHandlers) {
    this.ws.setHandlers(handlers);
    this.ws.connect();
  }

  /** 获取 WS 双连接状态 */
  getConnectingState() {
    return this.ws.getConnectingState();
  }

  /** 发送私聊消息 */
  async sendPrivateMsg(userId: number, msg: string, plainText?: boolean): Promise<number | undefined> {
    if (!msg) return undefined;
    if (this.debugMode) printLog(`[Send Private Msg] ${msg}`);
    const data = await this.callData<{ message_id: number }>('send_private_msg', {
      user_id: userId,
      message: msg,
      auto_escape: !!plainText,
    });
    return data?.message_id;
  }

  /** 发送群消息 */
  async sendGroupMsg(groupId: number, msg: string, atUser?: number | string, plainText?: boolean): Promise<number | undefined> {
    if (!msg) return undefined;
    const prefix = atUser ? `${getAtCode(`${atUser}`)} ` : '';
    if (this.debugMode) printLog(`[Send Group Msg] ${prefix}${msg}`);
    const data = await this.callData<{ message_id: number }>('send_group_msg', {
      group_id: groupId,
      message: `${prefix}${msg}`,
      auto_escape: !!plainText,
    });
    return data?.message_id;
  }

  /** 按 message_id 获取消息内容（用于解析引用消息） */
  async getMessageFromId(messageId: number | string) {
    if (!messageId) return undefined;
    return this.callData<SimpleMessageData>('get_msg', { message_id: messageId });
  }
}

export default new BotClient();
