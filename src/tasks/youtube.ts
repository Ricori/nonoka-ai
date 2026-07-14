import { SimpleIntervalJob, AsyncTask } from 'toad-scheduler';
import nnkbot from '@/core/nnkBot';
import nnkStorage from '@/core/nnkStorage';
import { printLog } from '@/utils/print';
import { getYoutubeLiveStatus } from '@/service/youtube/live';
import { rewriteToCDN } from '@/service/cdn';
import { getImgCode } from '@/utils/msgCode';
import { NonokaJob } from '@/core/nnkSchedule';

/** 已完成首次成功检查的频道。首次检查只记录当前状态、不推送，
 *  避免 bot 启动时把已经在进行中的直播当作新开播推送 */
const checkedChannels = new Set<string>();

async function checkYtLive(channelName: string, groupIds: number[]) {
  try {
    const status = await getYoutubeLiveStatus(channelName);
    if (!status) return;

    // 只有成功拿到状态才算完成首次检查，请求失败不算，下轮重试
    const isFirstCheck = !checkedChannels.has(channelName);
    checkedChannels.add(channelName);

    // 未开播时不清除已推送记录：直播检测偶尔会误判一次"未开播"，
    // 若在此清除，下一轮检测恢复正常后会把同一场直播再推一遍。
    // 新的一场直播 videoId 必然不同，仅靠 videoId 比对即可正确识别新直播。
    if (!status.isLive || !status.videoId) return;

    if (nnkStorage.getYtLastPushedVideoId(channelName) === status.videoId) return;
    nnkStorage.setYtLastPushedVideoId(channelName, status.videoId);

    // 启动后的首次检查：正在进行中的直播只记录 videoId，不推送
    if (isFirstCheck) return;

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
};

export default YtLivePushJob;
