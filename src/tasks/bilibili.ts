import { SimpleIntervalJob, AsyncTask } from 'toad-scheduler';
import nnkbot from '@/core/nnkBot';
import nnkStorage from '@/core/nnkStorage';
import { printLog } from '@/utils/print';
import getBiliDynamic from '@/service/bilibili/dynamic';
import { getImgCode } from '@/utils/msgCode';
import { NonokaJob } from '@/core/nnkSchedule';

async function checkBiliDynamic(
  { uid, groupIds, myBiliCookie }: { uid: string, groupIds: number[], myBiliCookie: string },
) {
  try {
    const dyData = await getBiliDynamic(uid, myBiliCookie);
    if (dyData) {
      const newTime = dyData.pubDate;
      const latestTime = nnkStorage.getBiliLatestDynamicTime(uid);
      if (newTime > latestTime) {
        nnkStorage.setBiliLatestDynamicTime(uid, newTime);

        if (uid === '629994228' && dyData.description.includes('今日速览')) {
          if (dyData.images[0]) {
            groupIds.forEach((groupId) => {
              nnkbot.sendGroupMsg(groupId, getImgCode(dyData.images[0]));
            });
          }
          return;
        }

        const msgTextArr = [] as string[];
        msgTextArr.push(dyData.title);
        msgTextArr.push(dyData.description);

        const images = dyData.images ?? [];
        for (let i = 0; i < images.length; i += 1) {
          msgTextArr.push(getImgCode(images[i]));
          if (i > 1) {
            break;
          }
        }
        if (!dyData.description.includes('视频地址：')) {
          msgTextArr.push(`动态链接：${dyData.dylink}`);
        }
        const msg = msgTextArr.join('\n');

        groupIds.forEach((groupId) => {
          nnkbot.sendGroupMsg(groupId, msg);
        });
      }
    }
  } catch (err) {
    printLog(`[biliTask] Error: ${err}`);
  }
}


const task = new AsyncTask('biliTask', async () => {
  const botIsConnect = nnkbot.getIsBotConnecting();
  const config = nnkbot.config.biliDynamicPush;
  if (!config.enable || !config.cookie) return;
  if (botIsConnect) {
    Object.keys(config.config).forEach((uid: string, i: number) => {
      if (Array.isArray(config.config[uid])) {
        setTimeout(() => checkBiliDynamic({
          uid,
          groupIds: config.config[uid],
          myBiliCookie: config.cookie,
        }), i * 2000);
      }
    });
  }
});


const BilibiliNewSharedJob: NonokaJob = {
  job: new SimpleIntervalJob({ seconds: 180 }, task, { id: 'bilibiliNewShared' }),
  // 启动bot时将动态最新时间设置为现在，防止立即推送
  init: () => {
    Object.keys(nnkbot.config.biliDynamicPush.config).forEach((uid: string) => {
      nnkStorage.setBiliLatestDynamicTime(uid, new Date().getTime());
    });
  },
};

export default BilibiliNewSharedJob;
