export interface WSConfig {
  /** host地址 */
  host: string;
  /** ws端口 */
  port: number;
}

export interface BotConfig {
  /** 管理员qq数组 */
  admin: number[];
  /** nonoka API服务 */
  nonokaService: {
    /** API服务地址 */
    baseUrl: string;
    /** API服务密钥 */
    apiKey: string;
  };
  /** 第三方服务 API 密钥（不通过管理面板读取或修改，直接编辑 config.json） */
  apiKeys: {
    /** 画图上游。出图要 130s+，过 nonoka 服务会被 CF 边缘切成 524，只能直连 */
    imageGen: {
      /** 上游地址，如 https://api.llm-token.cn */
      baseUrl: string;
      /** 上游密钥 */
      apiKey: string;
      /** 出图模型，如 gpt-image-2 */
      model: string;
    };
  };
  /** AI回复 */
  aiReply: {
    /** 是否开启AI回复 */
    enable: boolean;
    /** 黑名单，黑名单内的群不会触发任何回复 */
    blackList: number[];
    /** 主动发起对话的群名单 */
    initiativeList: number[];
    /** 开启语音回复（TTS）的群名单 */
    voiceList?: number[];
    /** 记忆系统。整块可省略，省略时按代码里的默认值走 */
    memory?: {
      /** 每次回复允许模型调几轮召回工具 */
      toolRounds?: {
        mention?: number;
        initiative?: number;
      };
      /** 黑名单 QQ，名单内的人不再抽取、更新记忆 */
      blackUserIds?: number[];
      /** 攒够多少条「有信息量」的消息触发一次抽取，默认 30 */
      extractThreshold?: number;
      /** 同一个人两次抽取之间的最小间隔分钟数，默认 240 */
      extractCooldownMin?: number;
    };
    /** 画图工具。整块可省略，省略时按代码里的默认值走（默认开启） */
    imageGen?: {
      /** 是否允许模型调用画图工具，默认 true，要关得显式写 false */
      enable?: boolean;
      /** 白名单群号，留空则所有开了 AI 回复的群都能画 */
      whiteGroupIds?: number[];
      /** 每群每日出图上限，默认 5 */
      dailyLimit?: number;
      /** 同群两次出图之间的冷却秒数，默认 120 */
      cooldownSec?: number;
      /** 出图尺寸，默认 1024x1024 */
      size?: string;
    };
    /** 联网搜索工具。整块可省略，省略时按代码里的默认值走（默认开启） */
    search?: {
      /** 是否允许模型调用搜索工具，默认 true，要关得显式写 false */
      enable?: boolean;
      /** 白名单群号，留空则所有开了 AI 回复的群都能搜 */
      whiteGroupIds?: number[];
      /** 每群每日搜索上限，默认 20。上游免费额度是每月 1000 次。 */
      dailyLimit?: number;
      /** 单次返回的结果条数，默认 5，上限 8 */
      count?: number;
    };
  };
}

export interface NonokaConfig {
  wsConfig: WSConfig;
  botConfig: BotConfig;
}
