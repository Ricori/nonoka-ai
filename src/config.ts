import fs from 'fs';
import path from 'path';
import { loadConfigFile } from '@/utils/io';
import { BotConfig, NonokaConfig } from '@/types/config';

const CONFIG_PATH = path.resolve('config.json');

/** 全局配置（单一真相源） */
const nonokaConfig = loadConfigFile('config.json') as NonokaConfig;

export const { wsConfig, botConfig } = nonokaConfig;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 校验配置结构，避免把 config.json 写坏 */
function validateConfig(v: unknown): v is NonokaConfig {
  if (!isPlainObject(v)) return false;
  const { wsConfig: ws, botConfig: bot } = v as Record<string, unknown>;
  if (!isPlainObject(ws) || typeof ws.host !== 'string' || typeof ws.port !== 'number') return false;
  if (!isPlainObject(bot)) return false;
  const requiredKeys = ['nonokaService', 'apiKeys', 'aiReply'];
  return requiredKeys.every((k) => k in bot);
}

/** 将当前内存中的配置原子性写回 config.json */
export function saveConfigToDisk() {
  const tmpPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(nonokaConfig, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, CONFIG_PATH);
}

/** 统一的配置热更新入口：构造新配置并校验，再原地合并到内存并原子落盘 */
export function updateBotConfig(updater: (current: BotConfig) => BotConfig) {
  const snapshot = JSON.parse(JSON.stringify(botConfig)) as BotConfig;
  const next = updater(snapshot);
  // 敏感配置块不允许经由运行时更新篡改，强制沿用原值
  const merged: BotConfig = {
    ...next,
    nonokaService: botConfig.nonokaService,
    apiKeys: botConfig.apiKeys,
  };

  const candidate: NonokaConfig = { wsConfig, botConfig: merged };
  if (!validateConfig(candidate)) {
    throw new Error('invalid config shape');
  }

  Object.assign(botConfig, merged);
  saveConfigToDisk();
}
