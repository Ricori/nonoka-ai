import Database from 'better-sqlite3';
import { botConfig } from '@/core/nnkConfig';
import { consolidateMemory, getConsolidationBacklog } from '@/modules/aiReply/memory/consolidate';
import { getMemoryDb } from '@/modules/aiReply/memory/db';

/**
 * 手动跑一次巩固：导入日志、切语义窗口、补向量、淘汰。不调 chat 模型，只花 embedding。
 * DRY=1：只读预览积压，不改库。SERVICE_URL 可临时覆盖服务地址。
 */
if (process.env.SERVICE_URL) botConfig.nonokaService.baseUrl = process.env.SERVICE_URL;

const dry = process.env.DRY === '1';
const groupIds = [...new Set(botConfig.aiReply.initiativeList)];
// DRY 不走建库/迁移流程
const db = dry ? new Database('data/memory/nonoka.db', { readonly: true, fileMustExist: true }) : getMemoryDb();
try {
  if (dry && !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_window'").get()) {
    console.log('库还在 v9 之前，没有窗口表；启动一次 bot 或去掉 DRY 跑一次完成迁移后再看');
    process.exit(0);
  }
  const before = getConsolidationBacklog(db);
  console.log(`待向量化：窗口 ${before.windows} 个 / 记忆 ${before.memories} 条${before.oldestDate ? `，最早 ${before.oldestDate}` : ''}`);
  if (dry) console.log('DRY=1：只读预览，未修改数据库');
  else {
    const stats = await consolidateMemory(groupIds, db);
    const after = getConsolidationBacklog(db);
    console.log(`完成：新窗口 ${stats.windows}，向量化 ${stats.embedded}，淘汰 ${stats.evicted}；`
      + `剩余待向量化 窗口 ${after.windows} / 记忆 ${after.memories}`);
  }
} finally {
  db.close();
}
