import { CronJob, AsyncTask } from 'toad-scheduler';
import nnkbot from '@/core/nnkBot';
import { printError } from '@/utils/print';
import { consolidateMemoryTracked } from '@/modules/aiReply/memory/consolidate';

/**
 * 每日四次记忆巩固：切语义窗口、补向量、跑淘汰。
 *
 * 窗口要花 embedding，只对会主动插话的群做——和记忆抽取的范围保持一致。
 * 字面索引不花钱，`consolidateMemory` 里的增量 ingest 对所有群都跑
 */
const task = new AsyncTask('memoryConsolidateTask', async () => {
  if (!nnkbot.config.aiReply.enable || !nnkbot.config.nonokaService.apiKey) return;
  await consolidateMemoryTracked(nnkbot.config.aiReply.initiativeList);
}, (err) => {
  printError(`[memoryConsolidateTask] ${err}`);
});

// preventOverrun：一次跑不完（首次有积压）时不要叠着再起一轮
const MemoryConsolidateJob = new CronJob(
  { cronExpression: '0 0,6,12,18 * * *', timezone: 'Asia/Shanghai' },
  task,
  { id: 'memoryConsolidate', preventOverrun: true },
);

export default MemoryConsolidateJob;
