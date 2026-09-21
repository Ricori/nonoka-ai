import { backupDateKey } from '../storage/message';

export const HISTORY_DAYS = 45;
export const DAY_MS = 86400000;
export const MAX_USER_MEMORIES = 14;

export function historySince(now = Date.now()): number {
  return Number(backupDateKey(new Date(now - HISTORY_DAYS * DAY_MS)));
}

/** 人工确认的身份数据不靠时间失效；未确认身份和陈旧的自动印象不能参与回复。 */
export function usableMemorySql(alias = 'm', now = Date.now()): string {
  return `(${alias}.kind NOT IN ('alias', 'relation') OR ${alias}.verified = 1 OR ${alias}.pinned = 1)
    AND (${alias}.verified = 1 OR ${alias}.pinned = 1 OR ${alias}.last_seen >= ${Math.floor(now - HISTORY_DAYS * DAY_MS)})`;
}

export function usableMemory(item: { kind: string, verified: boolean, pinned: boolean, lastSeen: number }, now = Date.now()): boolean {
  if (item.pinned || item.verified) return true;
  return item.kind !== 'alias' && item.kind !== 'relation' && item.lastSeen >= now - HISTORY_DAYS * DAY_MS;
}
