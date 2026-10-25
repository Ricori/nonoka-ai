import nnkbot from '@/core/nnkBot';
import { printLog } from '@/utils/print';
import { getImgCode } from '@/utils/msgCode';
import { randomText, sleep } from '@/utils/function';
import { editImage, generateImage, type ImageResult } from '@/service/imageGen';
import type { ToolDef } from '@/service/llm';
import messageStorage from '../storage/message';
import { formatAssistantMessage } from '../format';
import { sendSegmentedReply } from '../replySender';

/**
 * 给模型用的画图工具。
 *
 * 出一张图要 20~130s，而群聊回复链路是同步阻塞的，所以这里**不等图**：
 * 工具立刻返回「已经开始画了」，模型照常出一句文字回复先发出去，
 * 后台画完再单独发一条图片消息。
 *
 * 正因为出图是异步的，「图交了没有」这件事模型自己是看不见的——
 * 后台发出去的图和翻车文案都不走 generateReply 那条会记历史的路。
 * 所以这里必须自己把状态维护起来（drawStates）并回写会话历史，
 * 否则模型下一轮只能靠猜，会出现「刚开始画就宣布画好了」这种前言不搭后语
 */

/** 默认出图尺寸 */
const DEFAULT_SIZE = '1024x1024';

/** 每群每日出图上限 */
const DEFAULT_DAILY_LIMIT = 5;

/** 同群两次出图之间的冷却（秒） */
const DEFAULT_COOLDOWN_SEC = 120;

/**
 * 图最早也要等这么久才发。
 *
 * 文字回复要先经过工具轮的网络往返、再经过 replySender 的打字延迟才发得完，
 * 万一哪天出图快得离谱，图先于文字落地就前言不搭后语了
 */
const MIN_DELIVER_DELAY = 5000;

/** 图已发出 / 翻车的状态还值得告诉模型多久。再久话题早过去了，重提反而突兀 */
const NOTICE_TTL = 6 * 60 * 1000;

const DRAW_IMAGE_TOOL: ToolDef = {
  name: 'draw_image',
  description: '画一张图发到群里。群友让你画点什么、或者话题聊到某个画面你想画给大家看的时候用。'
    + '注意图不会立刻出现：调用之后要一两分钟才画得完，画完系统会自动把图发到群里、还会自动配一句话。'
    + '所以调完这个工具你只能说一句让对方稍等，'
    + '不可以说图已经画好、不可以描述图的内容、不可以贴链接。',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '要画什么，尽量具体地描述画面内容、构图和风格，用中文或英文都可以。'
          + '不要写年龄和年级（「15岁」「高一」「高中生」「15-year-old」「high school」这类），'
          + '画风本身就决定了角色看起来多大，写了会被画图服务的内容审核拒掉，整张图都出不来。'
          + '直接写「少女」「女孩子」「anime girl」就够了。',
      },
    },
    required: ['prompt'],
  },
};

const EDIT_IMAGE_TOOL: ToolDef = {
  name: 'edit_image',
  description: '以刚才那位群友发给你的那张图为底做修改，改完发到群里。'
    + '群友把图发给你（或者引用了一张图）并让你改点什么的时候用。'
    + '底图由系统自动带上，你不用管是哪张。'
    + '和 draw_image 一样，改完的图要一两分钟才出来，届时会自动发出并配一句话，'
    + '你这次回复只能让对方稍等，不可以说已经改好、也不可以描述图的内容。',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '要怎么改，描述改完之后画面应该是什么样子。'
          + '和 draw_image 一样，不要写年龄和年级，会被内容审核拒掉。',
      },
    },
    required: ['prompt'],
  },
};

/**
 * 没底图时不下发 edit_image，模型看不见就不会去改别人的图。
 *
 * hasSrcImg 恒传 true 即两个工具恒定一起下发（cache 编排要的）：工具定义排在 system 前面，
 * 少下发一个就连整段人设一起全价重算（实测抽掉 tools 要重写 7916 token），
 * 代价是没底图时模型硬调 edit_image，由 runImageTool 兜底拒绝、多花一次工具轮
 */
export function getImageTools(hasSrcImg: boolean): ToolDef[] {
  return hasSrcImg ? [DRAW_IMAGE_TOOL, EDIT_IMAGE_TOOL] : [DRAW_IMAGE_TOOL];
}

/** 这个工具名是不是画图工具（generateReply 里分派用） */
export function isImageTool(name: string): boolean {
  return name === DRAW_IMAGE_TOOL.name || name === EDIT_IMAGE_TOOL.name;
}

function getConfig() {
  return nnkbot.config.aiReply.imageGen ?? {};
}

/** 这个群能不能画图。整块配置省略时默认开启，要关得显式写 enable: false */
export function isImageGenEnabled(groupId: number): boolean {
  const { enable = true, whiteGroupIds } = getConfig();
  if (!enable) return false;
  // 白名单留空即不启用白名单机制，与 hPic 的写法一致
  return !whiteGroupIds?.length || whiteGroupIds.includes(groupId);
}

/** 一个群最近一次出图走到哪一步了 */
interface DrawState {
  /** blocked 要和 failed 分开：原样重画一定还是被拦，得让模型知道该换说法 */
  status: 'drawing' | 'done' | 'failed' | 'blocked';
  /** 这一张画的是什么。注入提示时给模型看，免得它自己编一套说辞 */
  prompt: string;
  /** 状态写入时间，done / failed 超过 NOTICE_TTL 就不再注入 */
  at: number;
}

/** 各群的出图状态，与 nnkStorage 一样只放内存，重启清零 */
const drawStates = new Map<number, DrawState>();

/** 这个群的图是不是还在画。还在画就不接新的画图请求，也不主动插话 */
export function isDrawing(groupId: number): boolean {
  return drawStates.get(groupId)?.status === 'drawing';
}

function setDrawState(groupId: number, status: DrawState['status'], prompt: string) {
  drawStates.set(groupId, { status, prompt, at: Date.now() });
}

/**
 * 取要注入 system 的出图状态提示
 */
export function getDrawNotice(groupId: number): string | null {
  const state = drawStates.get(groupId);
  if (!state) return null;

  if (state.status === 'drawing') {
    return '你答应要画的那张图还在画，没画完，画完了会自动发出来。'
      + '这次回复要自然地体现出「还在画 / 马上就好」，不要再承诺一遍要画，也不要描述图里有什么。'
      + '绝对不可以说「画好了」「画完了」「发出来了」——图现在真的还没出来，说了就穿帮。';
  }

  // 画完 / 翻车的提示只在事发后一小段时间内注入
  if (Date.now() - state.at > NOTICE_TTL) return null;

  if (state.status === 'done') {
    return `你刚才画的那张图（${state.prompt}）已经发到群里了，大家都看得见，你也已经配过一句话了。`
      + '所以不要再说「还在画」「马上就好」，也不要重新画一张（除非群友明确又要了一张）。'
      + '现在就当图已经摆在眼前那样自然接话。';
  }

  if (state.status === 'blocked') {
    return `你刚才想画的那张图（${state.prompt}）被画图服务拒绝了，说这个内容不能画，你也已经跟大家说过一声了。`
      + '不要假装图已经发出去了，也不要接着说「还在画」。'
      + '要是还想画，必须换个画面或换种描述——原样再来一次照样会被拒。';
  }

  return `你刚才想画的那张图（${state.prompt}）画崩了，没能发出来，你也已经跟大家说过一声了。`
    + '不要假装图已经发出去了，也不要接着说「还在画」。群友要是还想要，可以重新画一张。';
}

/** 各群的出图额度，与 nnkStorage 一样只放内存，重启清零 */
const quota = new Map<number, { date: string, count: number, lastAt: number }>();

function today(): string {
  return new Date().toLocaleDateString();
}

/** 额度与冷却检查，通过返回 null，不通过返回给模型看的理由 */
function checkQuota(groupId: number): string | null {
  const { dailyLimit = DEFAULT_DAILY_LIMIT, cooldownSec = DEFAULT_COOLDOWN_SEC } = getConfig();
  const now = Date.now();
  const record = quota.get(groupId);

  // 跨天了就重新开始算
  if (!record || record.date !== today()) {
    quota.set(groupId, { date: today(), count: 0, lastAt: 0 });
    return null;
  }

  if (record.count >= dailyLimit) {
    return '今天画得太多了，已经画不动了，让对方明天再来。';
  }
  if (now - record.lastAt < cooldownSec * 1000) {
    return '刚画完一张还没缓过来，让对方等一会儿再说。';
  }
  return null;
}

/** 真的发起了一次出图才记账。先占坑，成败在 noteQuotaSettled 里结算 */
function noteQuotaUsed(groupId: number) {
  const record = quota.get(groupId) ?? { date: today(), count: 0, lastAt: 0 };
  quota.set(groupId, { date: today(), count: record.count + 1, lastAt: Date.now() });
}

/**
 * 一次出图收尾时结算额度与冷却。
 *
 * 冷却从图落地重新计时：从「开始画」算的话，一张图要画 120s、冷却也是 120s，
 * 等于图刚发出来就能立刻再画一张，冷却形同虚设。
 * 上游错误也不该吃掉用户的日额度，失败退回去
 */
function noteQuotaSettled(groupId: number, ok: boolean) {
  const record = quota.get(groupId);
  if (!record) return;
  quota.set(groupId, {
    ...record,
    count: ok ? record.count : Math.max(0, record.count - 1),
    lastAt: Date.now(),
  });
}

/** 图发出去时一起说的话。裸图甩出来太突兀，用人设的语气配一句才像真人交作业 */
const DONE_TEXTS = [
  '画好啦 || 欸嘿嘿 前辈快夸夸',
  '铛铛 || 乃乃香的大作',
  '喏 画完了～ || 还不错吧',
  '出炉了 || 前辈看看这个',
  '久等啦 || 乃乃香尽力了哦',
];

/** 出图失败时发的话。用人设的语气翻个车，比一声不吭强 */
const FAIL_TEXTS = [
  '呜哇 画到一半手滑了 || 这张不算',
  '欸 画崩了 || 乃乃香就当没画过',
  '呜呜 画不出来 || 下次一定',
];

/** 被内容审核拦下时发的话。跟画崩了不是一回事，说法也得不一样 */
const BLOCKED_TEXTS = [
  '欸 这个画不了 || 换一个嘛',
  '呜 这张被拦下来了 || 乃乃香也没办法',
  '这个不让画诶 || 前辈换个说法试试',
];

/**
 * 发一段 bot 自己的话：既发到群里，也记进会话历史。
 *
 * 走 sendSegmentedReply 而不是直接发：这些文案里的 `||` 是气泡分隔符，直接发会露出来。
 * 记历史这步不能省——出图是异步的，不经过 generateReply 里那次 addGroupChatConversations，
 * 漏记的话模型下一轮完全不知道自己交过图、道过歉，只能重新编一套说辞
 */
async function sayAndRemember(groupId: number, text: string) {
  messageStorage.addGroupChatConversations(groupId, formatAssistantMessage(text));
  await sendSegmentedReply(text, (msg) => nnkbot.sendGroupMsg(groupId, msg));
}

/** 后台跑的出图任务：画完配一句话再发图，失败发翻车文案，无论如何都要落状态 */
async function deliverImage(groupId: number, task: Promise<ImageResult>, label: string, prompt: string) {
  const startedAt = Date.now();
  let delivered = false;
  let blocked = false;

  try {
    const result = await task;
    blocked = result.blocked;

    // 图不能比文字回复先到，不够 MIN_DELIVER_DELAY 就补上
    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_DELIVER_DELAY) await sleep(MIN_DELIVER_DELAY - elapsed);

    if (result.file) {
      printLog(`[ImageTool] ${label} 出图完成 (${groupId})，耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`);
      // 状态先落再发话：发这几条要几秒，这期间进来的回复该按「图已交」来说，
      // 而不是读到过期的「还在画」
      delivered = true;
      setDrawState(groupId, 'done', prompt);
      await sayAndRemember(groupId, randomText(DONE_TEXTS));
      nnkbot.sendGroupMsg(groupId, getImgCode(result.file));
    } else {
      printLog(`[ImageTool] ${label} ${blocked ? '被内容审核拦下' : '出图失败'} (${groupId})`);
    }
  } catch (e) {
    printLog(`[ImageTool] ${label} 出图异常 (${groupId}): ${e}`);
  } finally {
    // 一定要落状态，否则一次失败就把这个群永久锁死
    if (!delivered) {
      setDrawState(groupId, blocked ? 'blocked' : 'failed', prompt);
      await sayAndRemember(groupId, randomText(blocked ? BLOCKED_TEXTS : FAIL_TEXTS)).catch(() => { });
    }
    noteQuotaSettled(groupId, delivered);
  }
}

/**
 * 本地执行一次画图工具。任何情况都返回一段给模型看的文本，不抛异常。
 *
 * srcImgUrl 是改图的底图，只来自「提到 bot 的那条消息」本身或它引用的消息
 */
export async function runImageTool(
  groupId: number,
  name: string,
  rawInput: unknown,
  srcImgUrl?: string,
): Promise<string> {
  const input = (rawInput ?? {}) as { prompt?: string };
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) {
    printLog(`[ImageTool] ${name} -> 缺少 prompt`);
    return '缺少 prompt 参数。';
  }

  if (!isImageGenEnabled(groupId)) {
    printLog(`[ImageTool] ${name} -> 本群未开启画图`);
    return '现在画不了图，告诉对方画不了就行。';
  }

  if (isDrawing(groupId)) {
    printLog(`[ImageTool] ${name} -> 上一张还在画`);
    return '上一张图还在画，画完才能画下一张，让对方先等等。';
  }

  const rejectReason = checkQuota(groupId);
  if (rejectReason) {
    printLog(`[ImageTool] ${name} -> ${rejectReason}`);
    return rejectReason;
  }

  if (name === 'edit_image' && !srcImgUrl) {
    // 正常情况下没底图就不会下发这个工具，走到这里说明模型硬调了
    printLog('[ImageTool] edit_image -> 没有底图');
    return '没有拿到要改的那张图，让对方把图重新发一遍。';
  }

  setDrawState(groupId, 'drawing', prompt);
  noteQuotaUsed(groupId);

  const { size = DEFAULT_SIZE } = getConfig();
  const task = name === 'edit_image'
    ? editImage(srcImgUrl!, prompt, size)
    : generateImage(prompt, size);

  printLog(`[ImageTool] ${name}(${prompt}) -> 开始出图 (${groupId})`);
  // 故意不 await：出图要 20~130s，等下去整条回复链路都得卡住
  deliverImage(groupId, task, name, prompt);

  // 说清楚「现在还没画完」：只靠工具描述压不住，模型被追问几轮之后
  // 很容易顺着「不许复读」的人设要求escalate成「画好了」
  return '已经开始画了，但是图现在还没出来，要一两分钟。画完系统会自动发到群里、还会自动配一句话，不用你操心。'
    + '你这次回复只能说一句让对方稍等，'
    + '绝对不能说「画好了」「画完了」「发出来了」，也不能描述图的内容或者贴链接。';
}
