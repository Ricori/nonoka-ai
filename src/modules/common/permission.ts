import nnkbot from '@/core/nnkBot';
import { GroupMessageData } from '@/types/event';

/** 是否为 bot 管理员（config.admin） */
export function isBotAdmin(userId: number) {
  return (nnkbot.config.admin || []).includes(userId);
}

/** 群主/群管理员或 bot 管理员 */
export function isGroupManager(data: GroupMessageData) {
  const { role } = data.sender;
  return role === 'owner' || role === 'admin' || isBotAdmin(data.user_id);
}
