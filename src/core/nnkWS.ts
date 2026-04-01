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
  groupAtMe?: (data: GroupMessageData) => Promise<void>
  group?: (data: GroupMessageData) => Promise<void>
}

interface ResponseHandlersType { onSuccess: (ctxt: WSActionRes) => void, onFailure: (e: Error) => void }

export class YoruWebsocket {
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
    groupAtMe: async (_data: GroupMessageData) => { },
    group: async (_data: GroupMessageData) => { },
  };

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
      const onSuccess = (ctxt: WSActionRes) => {
        this.responseHandlers.delete(reqid);
        const { echo, ...result } = ctxt;
        resolve(result);
      };
      const onFailure = (err: Error) => {
        this.responseHandlers.delete(reqid);
        reject(err);
      };
      const reqid = nanoid();
      this.responseHandlers.set(reqid, { onFailure, onSuccess });
      this.apiWSConnection.sendUTF(JSON.stringify({
        action: method,
        params,
        echo: { reqid },
      }));
    });
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
          const selfId = data.self_id || 0;
          const msg = `${data.message || ''}`;
          if (msg.indexOf(`[CQ:at,qq=${selfId}]`) > -1) {
            this.eventFunction.groupAtMe(data as GroupMessageData);
          } else {
            this.eventFunction.group(data as GroupMessageData);
          }
        }
        break;
      default:
        break;
    }
  }

  connect() {
    const ws = {
      api: new WebSocketClient(),
      event: new WebSocketClient(),
    };
    const connectError = (type: WSType, err: Error) => {
      this.wsState[type] = WebSocketState.CLOSED;
      printError(`[WS Connect] ${type}Ws connect fail, Error: ${err.toString()}`);
    };
    const connectSuccess = (type: WSType) => {
      this.wsState[type] = WebSocketState.CONNECTING;
      printLog(`[WS Connect] ${type}Ws connect successfully`);
    };
    const connectClose = (type: WSType) => {
      this.wsState[type] = WebSocketState.CLOSED;
      printLog(`[WS Connect] ${type}Ws connect close`);
    };

    for (const type of ['api', 'event'] as WSType[]) {
      ws[type].on('connectFailed', (e: Error) => {
        connectError(type, e);
      });
      ws[type].on('connect', (c: Connection) => {
        connectSuccess(type);
        c.on('error', (e: Error) => {
          connectError(type, e);
        });
        c.on('close', () => {
          connectClose(type);
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
    }

    ws.api.connect(`${this.baseUrl}/api`, 'echo-protocol');
    ws.event.connect(`${this.baseUrl}/event`, 'echo-protocol');
  }

  getConnectingState() {
    return {
      api: this.apiWSConnection?.connected === true,
      event: this.eventWSConnection?.connected === true,
    };
  }
}
