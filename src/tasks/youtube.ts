import { SimpleIntervalJob, AsyncTask } from 'toad-scheduler';
import nnkbot from '@/core/nnkBot';
import nnkStorage from '@/core/nnkStorage';
import { printLog } from '@/utils/print';
import { getYoutubeLiveStatus } from '@/service/youtube/live';
import { getImgCode } from '@/utils/msgCode';

async function checkYtLive(channelId: string, groupIds: number[]) {
  try {
    const status = await getYoutubeLiveStatus(channelId);
    if (!status) return;

    if (!status.isLive || !status.videoId) {
      nnkStorage.clearYtLastPushedVideoId(channelId);
      return;
    }

    if (nnkStorage.getYtLastPushedVideoId(channelId) === status.videoId) return;
    nnkStorage.setYtLastPushedVideoId(channelId, status.videoId);

    const msgTextArr = [] as string[];
    msgTextArr.push(`${status.title ?? '主播'} 开始直播了！`);
    if (status.thumbnail) msgTextArr.push(getImgCode(status.thumbnail));
    msgTextArr.push(`直播链接：https://www.youtube.com/watch?v=${status.videoId}`);
    const msg = msgTextArr.join('\n');

    groupIds.forEach((groupId) => {
      nnkbot.sendGroupMsg(groupId, msg);
    });
  } catch (err) {
    printLog(`[ytLiveTask] Error (${channelId}): ${err}`);
  }
}

const task = new AsyncTask('ytLiveTask', async () => {
  const botIsConnect = nnkbot.getIsBotConnecting();
  const config = nnkbot.config.ytLivePush;
  if (!config.enable || !nnkbot.config.nonokaService.apiKey) return;
  if (botIsConnect) {
    Object.keys(config.config).forEach((channelId: string, i: number) => {
      if (Array.isArray(config.config[channelId])) {
        setTimeout(() => checkYtLive(channelId, config.config[channelId]), i * 1500);
      }
    });
  }
});

const YtLivePushJob = new SimpleIntervalJob({ seconds: 60 }, task, { id: 'ytLivePush', preventOverrun: true });

// 启动 bot 时预先拉取一次当前直播状态，避免重启时把正在进行中的直播当作新开播重复推送
Object.keys(nnkbot.config.ytLivePush.config).forEach((channelId: string) => {
  getYoutubeLiveStatus(channelId).then((status) => {
    if (status?.isLive && status.videoId) {
      nnkStorage.setYtLastPushedVideoId(channelId, status.videoId);
    }
  });
});

export default YtLivePushJob;
