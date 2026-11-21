import type { FormattedMessage } from '@/types/message';
import memoryStore from '../store';
import aliasIndex from './aliasIndex';

/** 认人时往回看几条群友发言：bot 有 3.5s 防抖，等它开口时问句往往已经被后续消息挤下去了 */
const MENTION_SCAN_COUNT = 5;

/** 一次最多额外注入几个被提到的人的档案 */
const MAX_MENTIONED_USERS = 2;

/**
 * 找出被点到名、值得额外注入全量档案的群友。
 * alreadyFull 是已经注了全量的人（说话的对象），不用再占名额
 */
export function getMentionedUserIds(
  groupId: number,
  history: FormattedMessage[],
  alreadyFull: Set<number>,
): number[] {
  // 倒序：bot 要回的是最后那条，它提到的人得先占名额
  const recent = history
    .filter((m) => m.role === 'user' && m.userId !== 0)
    .slice(-MENTION_SCAN_COUNT)
    .reverse();

  const ids = new Set<number>();
  recent.forEach((m) => {
    aliasIndex.resolve(groupId, m.message).forEach((userId) => {
      // 认出了名字但这个人没有任何档案可注入，占名额也没意义
      if (!alreadyFull.has(userId) && memoryStore.hasMemory(userId)) ids.add(userId);
    });
  });

  return [...ids].slice(0, MAX_MENTIONED_USERS);
}
