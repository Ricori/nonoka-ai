import bot from '@/bot';
import { handleGroupMessage } from '@/chat/group';
import { handlePrivateMessage } from '@/chat/private';
import { ingestOnStartup } from '@/memory/ingest';
import { AdminPanel } from '@/panel';
import scheduler from '@/tasks/scheduler';
import SystemCleanupJob from '@/tasks/clean';
import MemoryConsolidateJob from '@/tasks/memoryConsolidate';

// 聊天备份导入记忆检索索引，跑完再接消息，避免定时巩固读到旧索引
ingestOnStartup();

// 定时任务
scheduler.loadJob([
  SystemCleanupJob,
  MemoryConsolidateJob,
]);

// 单页管理面板
new AdminPanel().start();

// ののか，Link Start ~
bot.start({
  onPrivateMessage: handlePrivateMessage,
  onGroupMessage: handleGroupMessage,
});
