import { printError, printLog } from '@/utils/print';
import { GroupMessageData, PrivateMessageData, RequestFirendMessageData } from '@/types/event';
import { BotConfig } from '@/types/config';
import NonokaModuleBase from '@/modules/base';
import { NonokaWebsocket } from './nnkWS';
import { botConfig, wsConfig } from './nnkConfig';

const debugMode = process.env.YDEBUG === 'true';

type Module = typeof NonokaModuleBase<RequestFirendMessageData> |
  typeof NonokaModuleBase<PrivateMessageData> |
  typeof NonokaModuleBase<GroupMessageData>;


export class NonokaCore {
  /** NonokaWebSocket Object */
  protected nonokaWS: NonokaWebsocket;

  /** Is in debug mode */
  readonly debugMode = debugMode;

  /** Bot configs */
  readonly config: BotConfig;

  /** Request modules currently loaded */
  requestMessageModuleList: typeof NonokaModuleBase<RequestFirendMessageData>[] = [];

  /** Private message modules currently loaded  */
  privateMessageModuleList: typeof NonokaModuleBase<PrivateMessageData>[] = [];

  /** Group message currently loaded  */
  groupAtMessageModuleList: typeof NonokaModuleBase<GroupMessageData>[] = [];

  /** Request modules currently loaded  */
  groupMessageModuleList: typeof NonokaModuleBase<GroupMessageData>[] = [];

  /** Modules whose static init has been executed */
  private initializedModules = new Set<typeof NonokaModuleBase>();

  constructor() {
    // config（botConfig 为共享引用，管理面板热更新后此处同步生效）
    this.debugMode = debugMode;
    this.config = botConfig;

    // event listeners
    const eventFC = {
      friend: async (data: RequestFirendMessageData) => {
        if (this.debugMode) printLog('[Recive friend event]', data);
        this.flow(this.requestMessageModuleList, data);
      },
      private: async (data: PrivateMessageData) => {
        if (this.debugMode) printLog('[Recive private msg]', data);
        this.flow(this.privateMessageModuleList, data);
      },
      groupAtMe: async (data: GroupMessageData) => {
        if (this.debugMode) printLog('[Recive group at msg]', data);
        this.flow(this.groupAtMessageModuleList, data);
      },
      group: async (data: GroupMessageData) => {
        // if (this.debugMode) printLog('[Recive group msg]', data);
        this.flow(this.groupMessageModuleList, data);
      },
    };

    // create nonokaWS object
    this.nonokaWS = new NonokaWebsocket(wsConfig, eventFC);
  }

  /** Loaded request message type modules */
  loadModule(type: 'request', ModuleList: typeof NonokaModuleBase<RequestFirendMessageData>[]): void;
  /** Loaded private message type modules */
  loadModule(type: 'private', ModuleList: typeof NonokaModuleBase<PrivateMessageData>[]): void;
  /** Loaded private message type modules, support common modules */
  loadModule(type: 'private', ModuleList: typeof NonokaModuleBase<(PrivateMessageData | GroupMessageData) >[]): void;
  /** Loaded groupAt message type modules */
  loadModule(type: 'groupAt', ModuleList: typeof NonokaModuleBase<GroupMessageData>[]): void;
  /** Loaded groupAt message type modules, support common modules */
  loadModule(type: 'groupAt', ModuleList: typeof NonokaModuleBase<(PrivateMessageData | GroupMessageData) >[]): void;
  /** Loaded group message type modules */
  loadModule(type: 'group', ModuleList: typeof NonokaModuleBase<GroupMessageData>[]): void;
  /** Loaded group message type modules, support common modules  */
  loadModule(type: 'group', ModuleList: typeof NonokaModuleBase<(PrivateMessageData | GroupMessageData) >[]): void;
  /** Loaded modules in different message type */
  loadModule(type: 'request' | 'private' | 'groupAt' | 'group', ModuleList: typeof NonokaModuleBase[]) {
    this[`${type}MessageModuleList`]?.push(...ModuleList);
    // 执行模块的启动初始化，同一模块注册到多条消息链也只执行一次
    ModuleList.forEach((Module) => {
      if (this.initializedModules.has(Module)) return;
      this.initializedModules.add(Module);
      Module.init?.();
    });
  }

  /** Module flow */
  async flow(ModuleList: Module[], data: any) {
    let extra = {};
    for (const Module of ModuleList) {
      const obj = new Module(data, extra);
      try {
        // check conditions
        const hit = await obj.checkConditions();
        if (hit) {
          // debug text
          if (this.debugMode) printLog('[System Module]', `Run ${Module.NAME}`);
          // run
          await obj.run();
          // get res
          const { finished, extraData } = obj.processingNextData();
          // check finished
          if (finished) return;
          // extraData
          extra = extraData;
        }
      } catch (error) {
        printError(`[${Module.NAME || 'MODULE'} Error] ${error}`);
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
