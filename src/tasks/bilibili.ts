import { SimpleIntervalJob, AsyncTask } from 'toad-scheduler';
import nnkbot from '@/core/nnkBot';
import nnkStorage from '@/core/nnkStorage';
import { printLog } from '@/utils/print';
import getBiliDynamic, { Post } from '@/service/bilibili/dynamic';
import { getImgCode } from '@/utils/msgCode';
import { NonokaJob } from '@/core/nnkSchedule';

const MAX_IMAGES = 3;
/** 这个号的「今日速览」只推第一张图 */
const DAILY_DIGEST_UID = '629994228';

function buildMessage(uid: string, dy: Post) {
  if (uid === DAILY_DIGEST_UID && dy.description.includes('今日速览')) {
    return dy.images[0] ? getImgCode(dy.images[0]) : '';
  }
  const lines = [
    dy.title,
    dy.description,
    ...dy.images.slice(0, MAX_IMAGES).map((img) => getImgCode(img)),
  ];
  // 视频/专栏/直播等描述里已带地址，不再重复附动态链接
  if (!dy.description.includes('地址：')) lines.push(`动态链接：${dy.dylink}`);
  return lines.join('\n');
}

async function checkBiliDynamic(uid: string, groupIds: number[]) {
  try {
    const dy = await getBiliDynamic(uid);
    if (!dy || dy.pubDate <= nnkStorage.getBiliLatestDynamicTime(uid)) return;
    nnkStorage.setBiliLatestDynamicTime(uid, dy.pubDate);

    const msg = buildMessage(uid, dy);
    if (msg) groupIds.forEach((groupId) => nnkbot.sendGroupMsg(groupId, msg));
  } catch (err) {
    printLog(`[biliTask] Error: ${err}`);
  }
}

const task = new AsyncTask('biliTask', async () => {
  const { enable, cookie, config } = nnkbot.config.biliDynamicPush;
  if (!enable || !cookie || !nnkbot.getIsBotConnecting()) return;
  Object.entries(config)
    .filter(([, groupIds]) => Array.isArray(groupIds))
    .forEach(([uid, groupIds], i) => {
      setTimeout(() => checkBiliDynamic(uid, groupIds), i * 2000);
    });
});

const BilibiliNewSharedJob: NonokaJob = {
  job: new SimpleIntervalJob({ seconds: 180 }, task, { id: 'bilibiliNewShared' }),
  // 启动bot时将动态最新时间设置为现在，防止立即推送
  init: () => {
    const now = Date.now();
    Object.keys(nnkbot.config.biliDynamicPush.config).forEach((uid) => {
      nnkStorage.setBiliLatestDynamicTime(uid, now);
    });
  },
};

export default BilibiliNewSharedJob;
