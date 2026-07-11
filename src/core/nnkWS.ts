import WebSocketClient from 'websocket/lib/WebSocketClient';
import { connection as Connection } from 'websocket';
import { nanoid } from 'nanoid';
import { printError, printLog } from '@/utils/print';
import { WSConfig } from '@/types/config';
import { WSActionRes } from '@/types/ws';
import { GroupMessageData, PrivateMessageData, RequestFirendMessageData } from '@/types/event';


type WSType = 'api' | 'event';

const WebSocketState = {
  DISABLED: -1, INIT: 0, CONNECTING: 1, CONNECTED: 2, CLOSING: 3, CLOSED: 4,
};

interface EventFunction {
  friend?: (data: RequestFirendMessageData) => Promise<void>
  private?: (data: PrivateMessageData) => Promise<void>
  group?: (data: GroupMessageData) => Promise<void>
}

interface ResponseHandlersType { onSuccess: (ctxt: WSActionRes) => void, onFailure: (e: Error) => void }

export class NonokaWebsocket {
  private baseUrl = '';

  private apiWSConnection: Connection | undefined = undefined;

  private eventWSConnection: Connection | undefined = undefined;

  responseHandlers = new Map<string, ResponseHandlersType>();

  public wsState = {
    api: WebSocketState.DISABLED,
    event: WebSocketState.DISABLED,
  };

  private eventFunction = {
    friend: async (_data: RequestFirendMessageData) => { },
    private: async (_data: PrivateMessageData) => { },
    group: async (_data: GroupMessageData) => { },
  };

  private reconnectTimers: Record<WSType, ReturnType<typeof setTimeout> | null> = {
    api: null,
    event: null,
  };

  private reconnectAttempts: Record<WSType, number> = { api: 0, event: 0 };

  private static readonly MAX_RECONNECT_DELAY = 30000;

  private static readonly BASE_RECONNECT_DELAY = 1000;

  private static readonly CALL_TIMEOUT = 15000;

  constructor(wsConfig: WSConfig, eventFC?: EventFunction) {
    const { host = '127.0.0.1', port = 6700 } = wsConfig;
    this.baseUrl = `ws://${host}:${port}`;
    this.eventFunction = { ...this.eventFunction, ...eventFC };
  }

  call(method: string, params: Record<string, any>) {
    return new Promise((resolve: (c: WSActionRes) => void, reject: (e: Error) => void) => {
      if (!this.apiWSConnection?.connected) {
        reject(new Error('apiWs has not been initialized.'));
        return;
      }
      const reqid = nanoid();
      // 超时保护，防止 echo 丢失导致 Promise 永久挂起、handler 永不释放
      const timer = setTimeout(() => {
        this.responseHandlers.delete(reqid);
        reject(new Error(`WS call timeout: ${method}`));
      }, NonokaWebsocket.CALL_TIMEOUT);
      const onSuccess = (ctxt: WSActionRes) => {
        clearTimeout(timer);
        this.responseHandlers.delete(reqid);
        const { echo, ...result } = ctxt;
        resolve(result);
      };
      const onFailure = (err: Error) => {
        clearTimeout(timer);
        this.responseHandlers.delete(reqid);
        reject(err);
      };
      this.responseHandlers.set(reqid, { onFailure, onSuccess });
      this.apiWSConnection.sendUTF(JSON.stringify({
        action: method,
        params,
        echo: { reqid },
      }));
    });
  }

  /** 断开连接时清理所有挂起的请求，避免泄漏并让调用方及时收到失败 */
  private rejectAllPending(reason: string) {
    if (this.responseHandlers.size === 0) return;
    const handlers = [...this.responseHandlers.values()];
    this.responseHandlers.clear();
    handlers.forEach((h) => h.onFailure(new Error(reason)));
  }

  handleEvent(data: Record<string, any>) {
    switch (data.post_type) {
      case 'request':
        if (data.request_type === 'friend') {
          this.eventFunction.friend(data as RequestFirendMessageData);
        }
        break;
      case 'message':
        if (data.message_type === 'private') {
          this.eventFunction.private(data as PrivateMessageData);
        } else if (data.message_type === 'group') {
          this.eventFunction.group(data as GroupMessageData);
        }
        break;
      default:
        break;
    }
  }

  private scheduleReconnect(type: WSType) {
    if (this.reconnectTimers[type]) return;

    const delay = Math.min(
      NonokaWebsocket.BASE_RECONNECT_DELAY * 2 ** this.reconnectAttempts[type],
      NonokaWebsocket.MAX_RECONNECT_DELAY,
    );
    this.reconnectAttempts[type]++;
    printLog(`[WS Connect] ${type}Ws will reconnect in ${delay}ms (attempt ${this.reconnectAttempts[type]})`);

    this.reconnectTimers[type] = setTimeout(() => {
      this.reconnectTimers[type] = null;
      this.connectOne(type);
    }, delay);
  }

  private connectOne(type: WSType) {
    const ws = new WebSocketClient();
    this.wsState[type] = WebSocketState.CONNECTING;

    ws.on('connectFailed', (e: Error) => {
      this.wsState[type] = WebSocketState.CLOSED;
      printError(`[WS Connect] ${type}Ws connect fail, Error: ${e.toString()}`);
      this.scheduleReconnect(type);
    });

    ws.on('connect', (c: Connection) => {
      this.wsState[type] = WebSocketState.CONNECTED;
      this.reconnectAttempts[type] = 0;
      printLog(`[WS Connect] ${type}Ws connect successfully`);

      c.on('error', (e: Error) => {
        this.wsState[type] = WebSocketState.CLOSED;
        printError(`[WS Connect] ${type}Ws connect fail, Error: ${e.toString()}`);
        if (type === 'api') this.rejectAllPending(`apiWs error: ${e.toString()}`);
      });

      c.on('close', () => {
        this.wsState[type] = WebSocketState.CLOSED;
        printLog(`[WS Connect] ${type}Ws connect close`);
        if (type === 'api') this.rejectAllPending('apiWs connection closed');
        this.scheduleReconnect(type);
      });

      c.on('message', (data) => {
        if (data.type !== 'utf8') return;
        let context: Record<string, any>;
        try {
          context = JSON.parse(data.utf8Data);
        } catch (err) {
          printError(`[WS] WS Data Error, data: ${data.utf8Data}`);
          return;
        }
        if (type === 'event') {
          this.handleEvent(context);
        } else {
          const reqid = context.echo?.reqid || '';
          const { onSuccess } = this.responseHandlers.get(reqid) || {};
          if (typeof onSuccess === 'function') {
            onSuccess(context as WSActionRes);
          }
        }
      });

      this[`${type}WSConnection`] = c;
    });

    const path = type === 'api' ? '/api' : '/event';
    ws.connect(`${this.baseUrl}${path}`, 'echo-protocol');
  }

  connect() {
    this.connectOne('api');
    this.connectOne('event');
  }

  getConnectingState() {
    return {
      api: this.apiWSConnection?.connected === true,
      event: this.eventWSConnection?.connected === true,
    };
  }
}
