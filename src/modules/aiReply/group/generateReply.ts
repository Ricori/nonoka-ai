import { getLLMReplyWithTools, PROMPT_LAYOUT, type ToolDef } from '@/service/llm';
import nnkbot from '@/core/nnkBot';
import { printLog } from '@/utils/print';
import type { FormattedMessage } from '@/types/message';
import messageStorage from '../storage/message';
import memoryStore from '../memory/store';
import groupProfileStorage from '../storage/groupProfile';
import { MEMORY_TOOLS, runMemoryTool } from '../memory/tools';
import {
  getDrawNotice, getImageTools, isDrawing, isImageGenEnabled, isImageTool, runImageTool,
} from '../imageGen/tools';
import {
  SEARCH_TOOLS, isSearchEnabled, isSearchTool, runSearchTool,
} from '../search/tools';
import { getMentionedUserIds } from '../history/mention';
import {
  formatAssistantMessage, formatDrawNoticeMessage,
  formatInitiativePromptMessage, formatUserMemoryPromptMessage,
} from '../format';

/**
 * 要下发的工具集。
 *
 * lean 编排按「还在画」「没底图」这类单轮状态裁剪，少发的 token 直接省下来；
 * cache 编排只按群配置分，因为工具定义排在 system 前面、一变就连整段人设一起作废
 * （实测主动插话抽掉 tools 那次，人设 7916 token 原样重写一遍）。
 * 裁剪不下发时，临时状态由 runImageTool / runSearchTool 兜底拒绝，每条出口都返回给模型看的理由
 */
function buildTools(groupId: number, srcImgUrl?: string): ToolDef[] {
  const lean = PROMPT_LAYOUT === 'lean';
  // 还在画的这一轮不给画图工具——不该排队画第二张
  const canDraw = isImageGenEnabled(groupId) && !(lean && isDrawing(groupId));
  return [
    ...MEMORY_TOOLS,
    ...(canDraw ? getImageTools(!lean || !!srcImgUrl) : []),
    ...(isSearchEnabled(groupId) ? SEARCH_TOOLS : []),
  ];
}

/** 会主动插话、却还没写群档案的群，先按陌生群对待，免得把主场的语气带过去 */
const DEFAULT_PROFILE_TEXT = '陌生群，关系空白：少说话，语气收敛，优先只回应直接向你说话的人';

/** 取注入 system 的群环境描述：有档案用档案，
 *  没档案但会主动插话的群用保守默认文案，其余（只在被 @ 时回复）不注入 */
function getGroupContext(groupId: number): string | undefined {
  const { profileText } = groupProfileStorage.getProfile(groupId);
  if (profileText) return profileText;
  if (nnkbot.config.aiReply.initiativeList.includes(groupId)) return DEFAULT_PROFILE_TEXT;
  return undefined;
}

/**
 * 每次回复允许模型调几轮召回工具。
 *
 * 旧账不再由关键词启发式预先塞进 prompt，改成模型自己按需去查——
 * 它才是最好的查询生成器：同义扩展、指代消解、意图推断都是免费的。
 * 主动插话给 0 轮：随口插一句不值得多花一次网络往返
 */
const DEFAULT_TOOL_ROUNDS = { mention: 1, initiative: 0 };

function getToolRounds(isInitiativeReply: boolean): number {
  const key = isInitiativeReply ? 'initiative' : 'mention';
  return nnkbot.config.aiReply.memory?.toolRounds?.[key] ?? DEFAULT_TOOL_ROUNDS[key];
}

/**
 * 只在这几条里找触发本次回复的那条 @。
 *
 * 回复有 3.5s 防抖，这期间可能又插进来几条别人的消息，所以不能只看最后一条；
 * 但也不能翻遍整个 30 条窗口——那会把十几轮之前的旧图当成这次要改的图
 */
const TRIGGER_LOOKBACK = 5;

/**
 * 取改图的底图。
 *
 * 只认「提到 bot 的那条消息」带的图：它自己发的图，或者它引用的那条消息里的图
 */
function getSrcImgUrl(history: FormattedMessage[]): string | undefined {
  const mention = history
    .slice(-TRIGGER_LOOKBACK)
    .reverse()
    .find((m) => m.role === 'user' && m.isMentionMe);
  return mention?.imgUrl ?? mention?.refImgUrl;
}

/** 主动插话没有说话对象，又不给工具轮（`DEFAULT_TOOL_ROUNDS.initiative`），
 *  查不了 recall_memory，只能靠预注入：最近这几个发言的人都给全量档案 */
const INITIATIVE_FULL_USERS = 5;

/**
 * 这轮回复是冲着谁说的：防抖窗口里 @ 过 bot 的人，都算。
 * @ 已经被挤出窗口时退回到最后一个发言的人
 */
function getTriggerUserIds(history: FormattedMessage[]): number[] {
  const recent = history.slice(-TRIGGER_LOOKBACK).filter((m) => m.role === 'user' && m.userId !== 0);
  const mentionMe = recent.filter((m) => m.isMentionMe).map((m) => m.userId);
  if (mentionMe.length) return [...new Set(mentionMe)];
  const last = recent.at(-1);
  return last ? [last.userId] : [];
}

/** 组装群聊上下文（会话历史 + 群友记忆 + 主动插话提示）并调用 LLM 生成回复；
 *  生成成功后会把回复记入该群会话历史 */
export async function generateGroupReply(
  groupId: number,
  isInitiativeReply: boolean,
  initiativeChance: number | null = null,
): Promise<string | null> {
  const history = messageStorage.getGroupChatConversations(groupId);

  // 近期发言的人只注认人必需的部分（叫法、关系），印象让模型用 recall_memory 按需查
  const recentUserIds = [...new Set(
    history.slice(-10).filter((m) => m.role === 'user').map((m) => m.userId),
  )];

  // 全量档案只给这轮真正相关的人：说话的对象（主动插话没有，改成最近几个发言的人），加上被点到名的人
  const fullUserIds = isInitiativeReply
    ? recentUserIds.slice(-INITIATIVE_FULL_USERS)
    : getTriggerUserIds(history);
  const mentionedUserIds = getMentionedUserIds(groupId, history, new Set(fullUserIds));
  if (mentionedUserIds.length > 0) {
    printLog(`[GenerateReply] ${groupId} 认出被提到的群友: ${mentionedUserIds.join(', ')}`);
  }

  const userMemoryContext = memoryStore.getMemoryContext(
    groupId,
    [...fullUserIds, ...mentionedUserIds],
    recentUserIds,
  );
  const userMemoryPrompt = formatUserMemoryPromptMessage(userMemoryContext);

  // 档案行接在会话历史之后：稳定内容在前、易变内容在后，缓存前缀才不会被顶掉
  const messages = [
    ...history,
    ...(userMemoryPrompt ? [userMemoryPrompt] : []),
  ];
  if (isInitiativeReply) {
    // 主动发起会话的提示词
    messages.push(formatInitiativePromptMessage());
  }

  // 出图状态注入。「还在画」让它别催自己，「已发出」让它别再喊还在画、别重复画，「画崩了」让它别假装图已经交了
  const drawNotice = getDrawNotice(groupId);
  if (drawNotice) {
    messages.push(formatDrawNoticeMessage(drawNotice));
  }

  const context = getGroupContext(groupId);
  const rounds = getToolRounds(isInitiativeReply);
  const srcImgUrl = getSrcImgUrl(history);

  let toolCalls = 0;
  // 0 轮（主动插话）走同一条路，只是一轮都不许调工具：lean 编排下服务端也就不下发工具定义，
  // cache 编排下照发、由服务端 tool_choice:none 挡住，这样缓存前缀跨「被动/主动」是同一条
  const aiReplyText = await getLLMReplyWithTools(
    messages,
    context,
    buildTools(groupId, srcImgUrl),
    (name, input) => {
      toolCalls += 1;
      if (isImageTool(name)) return runImageTool(groupId, name, input, srcImgUrl);
      if (isSearchTool(name)) return runSearchTool(groupId, name, input);
      return runMemoryTool(groupId, name, input);
    },
    rounds,
  );

  if (aiReplyText) {
    // 记忆自己的回复，并带上触发方式供备份日志标注
    const assistantMessage = formatAssistantMessage(
      aiReplyText,
      isInitiativeReply,
      initiativeChance,
      toolCalls,
      mentionedUserIds.length,
    );
    messageStorage.addGroupChatConversations(groupId, assistantMessage);
  }
  return aiReplyText;
}
