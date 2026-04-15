import { SimpleIntervalJob, Task } from 'toad-scheduler';
import messageStorage from '@/modules/aiReply/storage/message';
import { printLog } from '@/utils/print';

const task = new Task('systemCleanupTask', () => {
  // 清理会话缓存
  messageStorage.cleanChatConversations();
  printLog('[systemCleanupTask] 已自动清理会话缓存。');
});

const SystemCleanupJob = new SimpleIntervalJob({ days: 3 }, task, { id: 'systemCleanup' });


export default SystemCleanupJob;
