import Database from 'better-sqlite3';
import { botConfig } from '@/core/nnkConfig';
import {
  legacyTopicLines, prepareTopicLines, readTopicLines, topicSince,
} from '@/modules/aiReply/memory/topic';
import { backupDateKey } from '@/modules/aiReply/storage/message';
import { HISTORY_DAYS } from '@/modules/aiReply/memory/policy';

/** 同一批真实日志对比新旧规则；只读数据库、零模型调用。输入字符数不等于计费 token。 */
const days = Number(process.env.DAYS ?? HISTORY_DAYS);
if (!Number.isSafeInteger(days) || days < 0) throw new Error('DAYS 必须是非负整数');
const db = new Database('data/memory/nonoka.db', { readonly: true, fileMustExist: true });
try {
  const groups = [...new Set(botConfig.aiReply.initiativeList)];
  const totals = {
    groupDays: 0,
    rawLines: 0,
    oldLines: 0,
    newLines: 0,
    oldCalls: 0,
    newCalls: 0,
    oldBodyChars: 0,
    newBodyChars: 0,
  };
  for (const groupId of groups) {
    const dates = db.prepare(
      'SELECT DISTINCT date_key AS day FROM chat_line WHERE group_id = ? AND date_key >= ? AND date_key < ? ORDER BY date_key',
    ).all(groupId, topicSince(days), Number(backupDateKey())) as { day: number }[];
    for (const { day } of dates) {
      const raw = readTopicLines(db, groupId, day);
      const old = legacyTopicLines(raw);
      const prepared = prepareTopicLines(raw);
      const sent = [] as typeof prepared;
      let calls = 0;
      for (let i = 0; i < prepared.length; i += 100) {
        const slice = prepared.slice(i, i + 100);
        if (slice.some((line) => line.userId !== 0)) {
          calls += 1;
          sent.push(...slice);
        }
      }
      totals.groupDays += 1;
      totals.rawLines += raw.length;
      totals.oldLines += old.length;
      totals.newLines += sent.length;
      totals.oldCalls += Math.ceil(old.length / 100);
      totals.newCalls += calls;
      totals.oldBodyChars += old.reduce((n, line) => n + line.body.slice(0, 200).length, 0);
      totals.newBodyChars += sent.reduce((n, line) => n + line.body.slice(0, 200).length, 0);
    }
  }
  console.log(JSON.stringify({
    days,
    groups: groups.length,
    ...totals,
    requestReductionPercent: totals.oldCalls ? Number((100 * (1 - totals.newCalls / totals.oldCalls)).toFixed(2)) : 0,
    bodyReductionPercent: totals.oldBodyChars ? Number((100 * (1 - totals.newBodyChars / totals.oldBodyChars)).toFixed(2)) : 0,
    note: '同一历史样本的离线估计，不含提示词、输出、失败重试、历史范围和预算限制的额外节省；未调用模型。',
  }, null, 2));
} finally { db.close(); }
