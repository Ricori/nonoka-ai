import { botConfig } from '@/config';
import { printLog } from '@/utils/print';
import type { ToolDef } from '@/service/llm';
import { searchWeb, type SearchHit } from '@/service/search';

/**
 * 给模型用的联网搜索工具。
 *
 * 出口在服务端（bot 跑在墙内），这边只管什么时候调、怎么把结果讲给模型听。
 * 和召回工具一样跑在 bot 侧的工具循环里
 */

/** 单条结果进上下文的长度上限。服务端已经截到 200，这里再收一道。
 *  一次搜索的全文会作为 input token 在后续每一轮里继续算，不能太长 */
const MAX_SNIPPET_CHARS = 140;

/** 默认返回几条 */
const DEFAULT_COUNT = 5;

/** 每群每日搜索上限 */
const DEFAULT_DAILY_LIMIT = 20;

const SEARCH_TOOL: ToolDef = {
  name: 'web_search',
  description: '上网查现在的信息。'
    + '当话题涉及会过期的东西——新闻时事、比赛结果、股价汇率、天气、新番/游戏/软件的最新动态、'
    + '某个东西"现在怎么样了"——而你手上的信息可能已经过时或者根本不知道时，用这个查一下再说话。'
    + '不要用它查：群友的事（那是 recall_memory）、群里聊过的话（那是 recall_chat）、'
    + '你自己的事、以及闲聊吐槽这种根本不需要事实的场合。'
    + '拿不准就先查——比起编一个听起来对的答案，查一下再回答要好得多。',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词，像正常用搜索引擎那样写。'
          + '别把群友的原话整句抄进来，提炼成真正要查的东西，例如「原神 5.3 版本 更新内容」',
      },
      recency: {
        type: 'string',
        enum: ['day', 'week', 'month', 'year'],
        description: '限定结果的时间范围。问"今天/最近"这类时效性强的事情时填，'
          + '查不会变的知识时不要填，填了反而搜不到',
      },
      topic: {
        type: 'string',
        enum: ['news'],
        description: '只在明确要找新闻报道时填 news，其他情况不填',
      },
    },
    required: ['query'],
  },
};

export const SEARCH_TOOLS: ToolDef[] = [SEARCH_TOOL];

/** 这个工具名是不是搜索工具（generateReply 里分派用） */
export function isSearchTool(name: string): boolean {
  return name === SEARCH_TOOL.name;
}

function getConfig() {
  return botConfig.aiReply.search ?? {};
}

/** 这个群能不能搜。整块配置省略时默认开启，要关得显式写 enable: false */
export function isSearchEnabled(groupId: number): boolean {
  const { enable = true, whiteGroupIds } = getConfig();
  if (!enable) return false;
  // 白名单留空即不启用白名单机制，与 imageGen 的写法一致
  return !whiteGroupIds?.length || whiteGroupIds.includes(groupId);
}

/** 各群的搜索额度，与出图额度一样只放内存，重启清零 */
const quota = new Map<number, { date: string, count: number }>();

function today(): string {
  return new Date().toLocaleDateString();
}

/** 额度检查，通过返回 null，不通过返回给模型看的理由 */
function checkQuota(groupId: number): string | null {
  const { dailyLimit = DEFAULT_DAILY_LIMIT } = getConfig();
  const record = quota.get(groupId);
  // 跨天了就重新开始算
  if (!record || record.date !== today()) return null;
  if (record.count >= dailyLimit) {
    return '今天查得太多了，查不动了。这次只能靠自己已经知道的说，别提搜索的事。';
  }
  return null;
}

function noteQuotaUsed(groupId: number) {
  const record = quota.get(groupId);
  const count = record && record.date === today() ? record.count + 1 : 1;
  quota.set(groupId, { date: today(), count });
}

function truncate(text: string): string {
  return text.length > MAX_SNIPPET_CHARS ? `${text.slice(0, MAX_SNIPPET_CHARS)}…` : text;
}

/**
 * 把结果讲给模型听。
 *
 * 末尾那句约束是必要的：不加的话它会把 URL 整条贴进群里，
 * 和画图工具那边「不可以贴链接」是同一个道理
 */
function formatResult(answer: string | undefined, hits: SearchHit[]): string {
  if (hits.length === 0 && !answer) {
    return '这个没搜到什么有用的结果。别硬编，如实说没查到就行。';
  }

  const lines: string[] = [];
  if (answer) lines.push(`【概要】${truncate(answer)}`);
  hits.forEach((h, i) => {
    const meta = [h.date, h.site].filter(Boolean).join(' ');
    lines.push(`${i + 1}. ${meta ? `(${meta}) ` : ''}${h.title} —— ${truncate(h.snippet)}`);
  });
  lines.push('以上是刚查到的。用自己的话讲出来，可以提一句是哪里看到的，'
    + '但不要贴网址、不要列成一二三条、也不要说"我搜了一下"这种机械的话。');
  return lines.join('\n');
}

/** 本地执行一次搜索工具，任何情况都返回一段给模型看的文本，不抛异常 */
export async function runSearchTool(groupId: number, name: string, rawInput: unknown): Promise<string> {
  const input = (rawInput ?? {}) as { query?: string, recency?: string, topic?: string };
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  // 每条出口都要留日志：只在成功时打印的话，失败在日志里是隐形的
  if (!query) {
    printLog(`[SearchTool] ${name} -> 缺少 query`);
    return '缺少 query 参数。';
  }

  if (!isSearchEnabled(groupId)) {
    printLog(`[SearchTool] ${name} -> 本群未开启搜索`);
    return '现在查不了，这次只能靠自己已经知道的说。';
  }

  const rejectReason = checkQuota(groupId);
  if (rejectReason) {
    printLog(`[SearchTool] ${name}(${query}) -> 超出日额度`);
    return rejectReason;
  }

  try {
    const { count = DEFAULT_COUNT } = getConfig();
    // 先记账再发起：失败也算一次，否则一直失败会把额度当成无限的往上游打
    noteQuotaUsed(groupId);
    const result = await searchWeb(query, {
      count,
      topic: input.topic === 'news' ? 'news' : undefined,
      timeRange: input.recency,
    });

    if (!result) {
      printLog(`[SearchTool] web_search(${query}) -> 查询失败`);
      return '搜索出错了，这次没查到。别装作查到了，如实说没查着。';
    }

    printLog(`[SearchTool] web_search(${query}`
      + `${input.recency ? `, recency=${input.recency}` : ''}${input.topic ? `, topic=${input.topic}` : ''}`
      + `) -> ${result.hits.length} 条${result.answer ? '，带概要' : ''}`);
    return formatResult(result.answer, result.hits);
  } catch (e) {
    // 工具挂了不该让整轮回复失败，告诉模型查不到就行
    printLog(`[SearchTool] ${name} 执行失败: ${e}`);
    return '搜索出错了，这次没查到。别装作查到了，如实说没查着。';
  }
}
