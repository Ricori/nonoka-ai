import { printError, printLog } from '@/utils/print';
import { GroupMessageData, PrivateMessageData, RequestFirendMessageData } from '@/types/event';
import { BotConfig } from '@/types/config';
import { hasAtUser } from '@/utils/msgCode';
import { NonokaWebsocket } from './nnkWS';
import { botConfig, wsConfig } from './nnkConfig';
import { AnyNonokaModule, EventKind, ModuleContext } from './nnkModule';

const debugMode = process.env.YDEBUG === 'true';

/** WS base events (group:at / group:plain are derived by the flow based on isAtMe) */
type BaseEvent = 'request' | 'private' | 'group';

export abstract class NonokaCore {
  /** NonokaWebSocket Object */
  protected nonokaWS: NonokaWebsocket;

  /** Is in debug mode */
  readonly debugMode = debugMode;

  /** Bot configs (shared reference) */
  readonly config: BotConfig;

  /** Registered modules */
  protected moduleList: AnyNonokaModule[] = [];

  /** Initialized modules */
  private initializedModules = new Set<AnyNonokaModule>();

  /** Send a private message (implemented by the NonokaBot) */
  abstract sendPrivateMsg(userId: number, msg: string, plainText?: boolean): Promise<void>;

  /** Send a group message (implemented by the NonokaBot)  */
  abstract sendGroupMsg(groupId: number, msg: string, atUser?: number | string, plainText?: boolean): Promise<void>;

  constructor() {
    this.debugMode = debugMode;
    this.config = botConfig;

    // event listeners
    const eventFC = {
      friend: async (data: RequestFirendMessageData) => {
        if (this.debugMode) printLog('[Recive friend event]', data);
        this.flow('request', data);
      },
      private: async (data: PrivateMessageData) => {
        if (this.debugMode) printLog('[Recive private msg]', data);
        this.flow('private', data);
      },
      group: async (data: GroupMessageData) => {
        this.flow('group', data);
      },
    };

    // create nonokaWS object
    this.nonokaWS = new NonokaWebsocket(wsConfig, eventFC);
  }

  /** Register module */
  loadModules(list: AnyNonokaModule[]) {
    list.forEach((module) => {
      this.moduleList.push(module);
      if (this.initializedModules.has(module)) return;
      this.initializedModules.add(module);
      module.init?.();
    });
    this.printModuleChains();
  }

  /** Print the parsed call chain for each event */
  private printModuleChains() {
    const chains: Record<string, string[]> = {
      request: [], private: [], 'group:at': [], 'group:plain': [],
    };
    this.moduleList.forEach((m) => {
      if (m.events.includes('request')) chains.request.push(m.name);
      if (m.events.includes('private')) chains.private.push(m.name);
      if (m.events.includes('group') || m.events.includes('group:at')) chains['group:at'].push(m.name);
      if (m.events.includes('group') || m.events.includes('group:plain')) chains['group:plain'].push(m.name);
    });
    printLog(`[NonokaCore] Loaded ${this.moduleList.length} modules:`);
    Object.entries(chains).forEach(([event, names]) => {
      printLog(`  ${event.padEnd(11)}: ${names.join(' -> ') || '(none)'}`);
    });
  }

  /** Construct the message context */
  private createContext(
    data: RequestFirendMessageData | PrivateMessageData | GroupMessageData,
    isAtMe: boolean,
  ): ModuleContext {
    const reply = (msg: string, opts: { at?: boolean; plainText?: boolean } = {}) => {
      if ('message_type' in data && data.message_type === 'group') {
        this.sendGroupMsg(data.group_id, msg, opts.at ? data.user_id : undefined, opts.plainText);
      } else {
        this.sendPrivateMsg(data.user_id, msg, opts.plainText);
      }
    };
    return { data, isAtMe, reply };
  }

  /** Call chain */
  async flow(event: BaseEvent, data: RequestFirendMessageData | PrivateMessageData | GroupMessageData) {
    const isAtMe = event === 'group'
      && hasAtUser(`${(data as GroupMessageData).message || ''}`, data.self_id || 0);
    const subEvent: EventKind = event === 'group' ? (isAtMe ? 'group:at' : 'group:plain') : event;

    const ctx = this.createContext(data, isAtMe);

    for (const module of this.moduleList) {
      const subscribed = module.events.includes(event) || module.events.includes(subEvent);
      if (subscribed) {
        try {
          const hit = await module.match(ctx);
          if (hit) {
            if (this.debugMode) printLog('[System]', `Run ${module.name}.`);
            const result = await module.run(ctx, hit);
            // Broken by default; It is only passed on to subsequent modules if 'continue' is returned.
            if (result !== 'continue') return;
          }
        } catch (error) {
          printError(`[${module.name || 'MODULE'} Error] ${error}`);
        }
      }
    }
  }

  /** Start bot */
  start() {
    this.nonokaWS.connect();
  }

  /** Get bot connecting status */
  getIsBotConnecting() {
    const state = this.nonokaWS.getConnectingState();
    if (state.api && state.event) {
      return true;
    }
    return false;
  }
}
