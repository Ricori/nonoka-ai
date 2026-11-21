import path from 'path';

export const CHAT_BACKUP_DIR = path.resolve('data/memory/chat');

/**
 * 备份文件名里的日期串 yyyymmdd。检索与写入共用此函数，避免日期计算口径漂移（UTC 日期）
 */
export function backupDateKey(date = new Date()): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}
