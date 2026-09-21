import Database from 'better-sqlite3';
import { botConfig } from '@/core/nnkConfig';
import { consolidateMemory, getConsolidationBacklog } from '@/modules/aiReply/memory/consolidate';
import { getMemoryDb } from '@/modules/aiReply/memory/db';
import { topicBudgetRemaining, topicSettings } from '@/modules/aiReply/memory/topic';

/**
 * 手动处理未完成的话题，共用定时任务的每日预算，不自动突破费用上限。
 * DAYS=45：最近 N 天；0 使用全部热历史，仍限制为 45 天。CONCURRENCY=3：并发。
 * DAILY_LIMIT=40：当天请求总上限；DRY=1：只读预览，不改水位、不调用模型。
 * SERVICE_URL 可临时覆盖服务地址。
 */
if (process.env.SERVICE_URL) botConfig.nonokaService.baseUrl = process.env.SERVICE_URL;

function numberEnv(name: string, fallback: number, min = 0): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} 必须是 >= ${min} 的整数`);
  return value;
}

const defaults = topicSettings();
const opts = {
  topicLookbackDays: numberEnv('DAYS', defaults.lookbackDays),
  topicDailyLimit: numberEnv('DAILY_LIMIT', defaults.dailyLimit),
  concurrency: numberEnv('CONCURRENCY', 3, 1),
  maxDays: 2,
  maxChunks: 40,
};
const dry = process.env.DRY === '1';
const groupIds = [...new Set(botConfig.aiReply.initiativeList)];
// DRY 不走建库/迁移/检查点流程，也不再前移历史水位。
const db = dry ? new Database('data/memory/nonoka.db', { readonly: true, fileMustExist: true }) : getMemoryDb();
try {
  let left = getConsolidationBacklog(groupIds, db, opts);
  console.log(`处理范围：${opts.topicLookbackDays ? `最近 ${opts.topicLookbackDays} 天` : '全部未处理历史'}`);
  console.log(`待处理 ${left.days} 天 / ${left.chunks} 次请求 / ${left.lines} 行`);
  console.log(`今日请求额度剩余 ${topicBudgetRemaining(db, opts.topicDailyLimit)} / ${opts.topicDailyLimit}`);
  if (dry) console.log('DRY=1：只读预览，未调用模型、未修改水位');
  else {
    let round = 0;
    while (left.days > 0 && topicBudgetRemaining(db, opts.topicDailyLimit) > 0) {
      round += 1;
      const stats = await consolidateMemory(groupIds, db, opts);
      const next = getConsolidationBacklog(groupIds, db, opts);
      console.log(`第 ${round} 轮：调用 ${stats.topicCalls} 次，话题 +${stats.topics}，剩余 ${next.days} 天 / ${next.chunks} 次请求`);
      if ((stats.topicFailures ?? 0) > 0 || (next.days >= left.days && next.chunks >= left.chunks)) {
        console.log('本轮失败或无进展，停止；已成功的段已保存，下次继续。');
        break;
      }
      left = next;
    }
    if (topicBudgetRemaining(db, opts.topicDailyLimit) === 0) console.log('今日额度已用完或已禁用，停止切话题。');
  }
} finally {
  db.close();
}
