
import nnkbot from '@/core/nnkBot';
import nnkSchedule from '@/core/nnkSchedule';
import { NonokaAdmin } from '@/core/nnkAdmin';
import BilibiliNewSharedJob from '@/tasks/bilibili';
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

// 加载好友请求模块
nnkbot.loadModule('request', [RequestFriendModule]);

// 加载私聊消息模块
nnkbot.loadModule('private', [
  AdminModule,
  ImageSearchModule,
  HPicModule,
  PrivateAIReplyModule,
]);

// 加载群@消息模块
nnkbot.loadModule('groupAt', [
  GroupCommandModule,
  ImageSearchModule,
  LocalPictureModule,
  HPicModule,
  GroupAIReplyModule,
]);

// 加载群消息默认监听
nnkbot.loadModule('group', [
  GroupCommandModule,
  LocalPictureModule,
  YkhrOnedriveModule,
  HPicModule,
  RepeaterModule,
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
