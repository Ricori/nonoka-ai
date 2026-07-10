import fs from 'fs';
import path from 'path';
import { loadConfigFile } from '@/utils/io';
import { NonokaConfig } from '@/types/config';

/**
 * 全局配置
 */
const nonokaConfig = loadConfigFile('config.json') as NonokaConfig;

export const { wsConfig, botConfig } = nonokaConfig;

const CONFIG_PATH = path.resolve('config.json');

/** 运行时修改配置后调用，将当前内存中的配置原子性写回 config.json，避免重启丢失 */
export function saveConfigToDisk() {
  const tmpPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(nonokaConfig, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, CONFIG_PATH);
}
