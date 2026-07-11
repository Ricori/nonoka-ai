import { SimpleIntervalJob, AsyncTask } from 'toad-scheduler';
import nnkbot from '@/core/nnkBot';
import nnkStorage from '@/core/nnkStorage';
import { printLog } from '@/utils/print';
import { getYoutubeLiveStatus } from '@/service/youtube/live';
import { rewriteToCDN } from '@/service/cdn';
import { getImgCode } from '@/utils/msgCode';
import { NonokaJob } from '@/core/nnkSchedule';

async function checkYtLive(channelName: string, groupIds: number[]) {
  try {
    const status = await getYoutubeLiveStatus(channelName);
    if (!status) return;

    if (!status.isLive || !status.videoId) {
      nnkStorage.clearYtLastPushedVideoId(channelName);
      return;
    }

    if (nnkStorage.getYtLastPushedVideoId(channelName) === status.videoId) return;
    nnkStorage.setYtLastPushedVideoId(channelName, status.videoId);

    const msgTextArr = [] as string[];
    msgTextArr.push(`${status.title ?? '直播'} 开始了！`);
    if (status.thumbnail) msgTextArr.push(getImgCode(rewriteToCDN(status.thumbnail)));
    msgTextArr.push(`直播链接：https://www.youtube.com/watch?v=${status.videoId}`);
    msgTextArr.push(`实时翻译：https://live.nonoka.online/live?channel=@${channelName}`);
    const msg = msgTextArr.join('\n');
    printLog(`[ytLiveTask] Pushing live notification for channel ${channelName} to groups: ${groupIds.join(', ')}`);
    groupIds.forEach((groupId) => {
      nnkbot.sendGroupMsg(groupId, msg);
    });
  } catch (err) {
    printLog(`[ytLiveTask] Error (${channelName}): ${err}`);
  }
}

const task = new AsyncTask('ytLiveTask', async () => {
  const botIsConnect = nnkbot.getIsBotConnecting();
  const config = nnkbot.config.ytLivePush;
  if (!config.enable || !nnkbot.config.nonokaService.apiKey) return;
  if (botIsConnect) {
    Object.keys(config.config).forEach((channelName: string, i: number) => {
      if (Array.isArray(config.config[channelName])) {
        setTimeout(() => checkYtLive(channelName, config.config[channelName]), i * 1500);
      }
    });
  }
});

const YtLivePushJob: NonokaJob = {
  job: new SimpleIntervalJob({ seconds: 80 }, task, { id: 'ytLivePush', preventOverrun: true }),
  // 启动 bot 时预先拉取一次当前直播状态，避免重启时把正在进行中的直播当作新开播重复推送
  init: () => {
    Object.keys(nnkbot.config.ytLivePush.config).forEach((channelName: string) => {
      getYoutubeLiveStatus(channelName).then((status) => {
        if (status?.isLive && status.videoId) {
          nnkStorage.setYtLastPushedVideoId(channelName, status.videoId);
        }
      });
    });
  },
};

export default YtLivePushJob;
