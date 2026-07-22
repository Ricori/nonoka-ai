
import nnkbot from '@/core/nnkBot';
import nnkSchedule from '@/core/nnkSchedule';
import { NonokaAdmin } from '@/core/nnkAdmin';
import SystemCleanupJob from '@/tasks/clean';
import TwitterPushJob from '@/tasks/twitter';
import YtLivePushJob from '@/tasks/youtube';
import RequestFriendModule from '@/modules/request/requestFriend';
import AdminModule from '@/modules/admin';
import ImageSearchModule from '@/modules/common/imageSearch';
import HPicModule from '@/modules/common/hPic';
import YkhrOnedriveModule from '@/modules/group/ykhr';
import PrivateAIReplyModule from '@/modules/aiReply/private';
import GroupAIReplyModule from '@/modules/aiReply/group';
import RepeaterModule from '@/modules/group/repeater';
import LocalPictureModule from '@/modules/group/localPic';
import GroupCommandModule from '@/modules/group/command';

// 加载模块
nnkbot.loadModules([
  // 好友请求处理 (request)
  RequestFriendModule,
  // 管理员命令 (private)
  AdminModule,
  // 群命令 (group)
  GroupCommandModule,
  // 搜图 (private | group:at)
  ImageSearchModule,
  // 图库 (group)
  LocalPictureModule,
  // YKHR (group:plain)
  // YkhrOnedriveModule,
  // 涩图 (private | group)
  HPicModule,
  // 复读机 (group:plain)
  RepeaterModule,
  // 私聊 AI 回复 (private)
  PrivateAIReplyModule,
  // 群聊 AI 回复 (group)
  GroupAIReplyModule,
]);

// 加载定时任务
nnkSchedule.loadJob([
  SystemCleanupJob,
  // BilibiliNewSharedJob,
  TwitterPushJob,
  YtLivePushJob,
]);

// 启动管理面板
new NonokaAdmin(nnkbot).start();

// ののか，Link Start ~
nnkbot.start();
