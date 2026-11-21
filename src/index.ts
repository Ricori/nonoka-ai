import nnkbot from '@/core/nnkBot';
import nnkSchedule from '@/core/nnkSchedule';
import { NonokaAdmin } from '@/core/admin';
import SystemCleanupJob from '@/tasks/clean';
import MemoryConsolidateJob from '@/tasks/memoryConsolidate';
import AdminModule from '@/modules/admin';
import PrivateAIReplyModule from '@/modules/aiReply/private';
import GroupAIReplyModule from '@/modules/aiReply/group';
import { ingestOnStartup } from '@/modules/aiReply/memory/ingest';

// 加载模块
nnkbot.loadModules([
  // 管理员命令 (private)
  AdminModule,
  // 私聊 AI 回复 (private)
  PrivateAIReplyModule,
  // 群聊 AI 回复 (group)
  GroupAIReplyModule,
]);

// 聊天备份导入记忆检索索引，跑完再接消息，也避免定时巩固读到旧索引
ingestOnStartup();

// 加载定时任务
nnkSchedule.loadJob([
  SystemCleanupJob,
  MemoryConsolidateJob,
]);

// 启动管理面板
new NonokaAdmin(nnkbot).start();

// ののか，Link Start ~
nnkbot.start();
