
import yorubot from '@/core/yoruBot';
import yoruSchedule from '@/core/yoruSchedule';
import BilibiliNewSharedJob from '@/tasks/bilibili';
import SystemCleanupJob from '@/tasks/clean';
import TwitterPushJob from '@/tasks/twitter';
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
yorubot.loadModule('request', [RequestFriendModule]);

// 加载私聊消息模块
yorubot.loadModule('private', [
  AdminModule,
  ImageSearchModule,
  HPicModule,
  PrivateAIReplyModule,
]);

// 加载群@消息模块
yorubot.loadModule('groupAt', [
  GroupCommandModule,
  ImageSearchModule,
  LocalPictureModule,
  HPicModule,
  GroupAIReplyModule,
]);

// 加载群消息默认监听
yorubot.loadModule('group', [
  GroupCommandModule,
  LocalPictureModule,
  YkhrOnedriveModule,
  HPicModule,
  RepeaterModule,
  GroupAIReplyModule,
]);

// 加载定时任务
yoruSchedule.loadJob([
  SystemCleanupJob,
  BilibiliNewSharedJob,
  TwitterPushJob,
]);

// 夜夜酱，启 —— 动 ！！
yorubot.start();
