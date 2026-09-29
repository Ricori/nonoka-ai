import { extractMemory } from '@/service/llm';
import nnkbot from '@/core/nnkBot';
import { printError, printLog } from '@/utils/print';
import { getMemoryDb } from './db';
import { enqueueEmbedding } from './embedQueue';
import { splitSpeakerPrefix } from './segment';
import memoryStore from './store';
import type { EvidenceMessage } from './store';
import { usableMemory } from './policy';

/**
 * 记忆写入流水线：攒够一批消息就让 LLM 抽取，再与已有条目调和成增删改操作。
 *
 * 取代原来「整体重生成 6 条 trait」的做法——那样每次都要把旧印象重写一遍，
 * 长期事实和短期热点抢同样的格子，挤掉就再也回不来
 *
 * 抽取要花钱，所以触发上有三道闸，缺一不可：
 * 1. 只有「有信息量」的消息才计数。群里一半是 `[表情]`、`哈哈哈`、复读，
 *    它们既抽不出新记忆，又白占触发名额，还要在 prompt 里跟着走一遍
 * 2. 连续几轮什么都没学到就把阈值翻倍。记忆槽满了的老群友再抽多半是空转
 * 3. 同一个人两次抽取之间有冷却，刷屏的人不该一小时抽好几次
 */

/** 每攒够这么多条有信息量的消息触发一次，可被配置覆盖 */
const DEFAULT_THRESHOLD = 30;

/** 同一个人两次抽取的最小间隔分钟数，可被配置覆盖 */
const DEFAULT_COOLDOWN_MIN = 240;

/** 一次最多送多少条给 LLM。退避期间攒过头了也只送最近这些，prompt 不能无限涨 */
const EXTRACT_BATCH = 30;

/** 空转退避最多把阈值翻到几倍（30 -> 240） */
const MAX_BACKOFF = 8;

/** 对应上面的倍数，2^3 = 8 */
const MAX_BACKOFF_STEPS = 3;

/** 去掉标点表情后至少要剩这么多个字，才算一条有信息量的消息 */
const MIN_INFORMATIVE_CHARS = 4;

/** 抽取失败后隔多久重试。不吃满整个冷却，也不能立刻重来把失败的服务打穿 */
const RETRY_DELAY_MS = 5 * 60 * 1000;

/** 超过这么久没说话的人，缓冲区留着也等不到下一批，丢掉省内存 */
const IDLE_DROP_MS = 7 * 24 * 60 * 60 * 1000;

/** 每处理这么多条消息顺手清一次闲置缓冲区 */
const PRUNE_EVERY = 500;

/** formatMessage 把非文字内容换成的占位符，一概不算信息量 */
const PLACEHOLDER_RE = /\[(表情|图片|视频|语音|聊天记录|卡片消息|之前的图片)\]/g;

/**
 * 去掉占位符、链接、标点、emoji 之后还剩几个字。
 *
 * `[表情]`、`?`、`草`、`2333` 这种消息对抽取毫无价值，却和正经发言一样占一个名额，
 * 30 条里塞进去十几条就等于凭空多出三分之一的调用
 */
export function informativeLength(text: string): number {
  return text
    .replace(PLACEHOLDER_RE, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\s\p{P}\p{S}\p{Extended_Pictographic}]/gu, '')
    .length;
}

/** 自动人物档案只接受明确的本人陈述；宁可少记，转述、问句和引文不用于推断身份。 */
export function isSelfMemoryCandidate(text: string): boolean {
  if (/[?？]/.test(text)) return false;
  return /^(?:我(?!们|朋友|同学|同事|爸|妈|哥|姐|弟|妹|家人|听说|听他|听她|觉得|以为|猜|记得|想问)|本人)(?:是|在|有|没有|没|不|很|比较|喜欢|讨厌|住|读|学|做|从事|工作|毕业|买|养|玩|打|去|来|要|准备|计划|最近|今天|昨天|明天|上周|下周|这周|今年|以前|已经|刚|曾经|目前|现在|一直|平时|通常|最)/.test(text.trim());
}

interface PendingBuffer {
  messages: EvidenceMessage[];
  nickName: string;
  isExtracting: boolean;
  /** 上一条收下的正文，用来挡复读 */
  lastText: string;
  /** 最近一次收到这个人的消息，闲置回收用 */
  lastSeen: number;
  /** 下一次最早可以抽取的时间。成功后推一个冷却，失败后只推一个短重试间隔 */
  nextExtractAt: number;
  /** 连续几轮抽下来一点新东西都没有，用来退避 */
  emptyStreak: number;
  /** 上次抽取以来被过滤掉的消息数，只用来打日志看效果 */
  skipped: number;
}

class MemoryExtractor {
  /** 已@过bot、需要追踪的用户ID集合 */
  private trackedUsers = new Set<number>();

  private pendingBuffers = new Map<number, PendingBuffer>();

  private loaded = false;

  /** 距上次清理闲置缓冲区又过了多少条消息 */
  private sincePrune = 0;

  /** 黑名单里的人不再抽取记忆 */
  private isBlocked(userId: number): boolean {
    return nnkbot.config.aiReply.memory?.blackUserIds?.includes(userId) ?? false;
  }

  /** 触发阈值的基准值。每次现读配置，改完不用重启 */
  private baseThreshold(): number {
    const n = nnkbot.config.aiReply.memory?.extractThreshold;
    return typeof n === 'number' && n > 0 ? Math.floor(n) : DEFAULT_THRESHOLD;
  }

  private cooldownMs(): number {
    const n = nnkbot.config.aiReply.memory?.extractCooldownMin;
    return (typeof n === 'number' && n >= 0 ? n : DEFAULT_COOLDOWN_MIN) * 60 * 1000;
  }

  /** 退避后的实际阈值：连续空转 n 轮就翻 2^n 倍 */
  private thresholdFor(buffer: PendingBuffer): number {
    return this.baseThreshold() * Math.min(2 ** buffer.emptyStreak, MAX_BACKOFF);
  }

  /** 冷却期间也在攒，得有个上限，否则一个刷屏的人能把内存吃穿 */
  private maxBuffer(): number {
    return this.baseThreshold() * MAX_BACKOFF + EXTRACT_BATCH;
  }

  /** 已经有记忆的人继续追踪。懒加载，避免 import 时就去建库 */
  private ensureTracked() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const rows = getMemoryDb().prepare(
        "SELECT DISTINCT owner_id FROM memory WHERE scope = 'user'",
      ).all() as { owner_id: number }[];
      rows.forEach((r) => this.trackedUsers.add(r.owner_id));
      printLog(`[MemoryExtract] 已加载 ${this.trackedUsers.size} 个用户记忆`);
    } catch (e) {
      printError(`[MemoryExtract] 加载用户列表失败: ${e}`);
    }
  }

  /** 长期不说话的人把缓冲区丢掉。@过一次就永久追踪，不清理的话只增不减 */
  private prune(now: number) {
    this.sincePrune += 1;
    if (this.sincePrune < PRUNE_EVERY) return;
    this.sincePrune = 0;

    let dropped = 0;
    this.pendingBuffers.forEach((buffer, userId) => {
      // 正在抽的不能删：那批消息失败了还要放回这个缓冲区
      if (buffer.isExtracting || now - buffer.lastSeen < IDLE_DROP_MS) return;
      this.pendingBuffers.delete(userId);
      dropped += 1;
    });
    if (dropped > 0) {
      printLog(`[MemoryExtract] 清掉 ${dropped} 个闲置缓冲区，还剩 ${this.pendingBuffers.size} 个`);
    }
  }

  /**
   * 处理群消息：
   * - 若该消息 @了bot，将该用户加入追踪
   * - 若已追踪，累积有信息量的消息；达到阈值且过了冷却后异步触发抽取
   */
  onMessage(
    groupId: number,
    userId: number,
    nickName: string,
    message: string,
    isMentionMe: boolean,
    messageId: number,
    observedAt: number,
  ) {
    this.ensureTracked();
    memoryStore.noteNickName(groupId, userId, nickName);

    // 被拉黑的
    if (this.isBlocked(userId)) {
      return;
    }

    if (isMentionMe) this.trackedUsers.add(userId);
    if (!this.trackedUsers.has(userId)) return;

    const now = Date.now();
    this.prune(now);

    if (!this.pendingBuffers.has(userId)) {
      this.pendingBuffers.set(userId, {
        messages: [],
        nickName,
        isExtracting: false,
        lastText: '',
        lastSeen: now,
        nextExtractAt: 0,
        emptyStreak: 0,
        skipped: 0,
      });
    }

    const buffer = this.pendingBuffers.get(userId)!;
    buffer.nickName = nickName; // 保持最新昵称
    buffer.lastSeen = now;

    // 昵称是单独传给抽取的，`[昵称]说：` 这截前缀 30 条加起来是白烧的 token
    const { body } = splitSpeakerPrefix(message);
    const text = body.trim();

    // 表情、复读、太短的话直接不收：抽不出东西，却要占一个触发名额。
    // 只看本人说的那句，引文是别人的话，不能拿别人的字数把「？？」放行
    if (informativeLength(text) < MIN_INFORMATIVE_CHARS || text === buffer.lastText || !isSelfMemoryCandidate(text)) {
      buffer.skipped += 1;
      return;
    }
    buffer.lastText = text;

    buffer.messages.push({
      groupId, messageId, observedAt, text,
    });
    const cap = this.maxBuffer();
    if (buffer.messages.length > cap) {
      buffer.messages.splice(0, buffer.messages.length - cap);
    }

    this.maybeExtract(userId, now);
  }

  /** 三道闸都过了才真的发请求 */
  private maybeExtract(userId: number, now: number) {
    const buffer = this.pendingBuffers.get(userId);
    if (!buffer) return;
    if (buffer.isExtracting) return;
    if (buffer.messages.length < this.thresholdFor(buffer)) return;
    if (now < buffer.nextExtractAt) return;

    // 攒下的窗口整块取走，只把最近的一批送去抽取：
    // 会退避到这一步说明这个人的记忆已经饱和，越靠后的消息越值钱，旧的丢掉不心疼
    const window = buffer.messages.splice(0, buffer.messages.length);
    const batch = window.slice(-EXTRACT_BATCH);
    buffer.nextExtractAt = now + this.cooldownMs();
    this.triggerExtract(userId, buffer.nickName, batch, window.length).catch(() => { });
  }

  /** 后台异步抽取，不阻塞主流程 */
  private async triggerExtract(
    userId: number,
    nickName: string,
    messages: EvidenceMessage[],
    windowSize: number,
  ) {
    const buffer = this.pendingBuffers.get(userId);
    if (buffer) buffer.isExtracting = true;
    const skipped = buffer?.skipped ?? 0;
    if (buffer) buffer.skipped = 0;

    try {
      // alias 不送：这批全是本人的发言，从里面抽不出「别人怎么叫他」，
      // 送过去只是让每次 prompt 多背 8 条
      const existing = memoryStore.listUserMemories(userId)
        .filter((m) => ['trait', 'episode'].includes(m.kind) && !m.verified && !m.pinned && usableMemory(m))
        .map((m) => ({
          id: m.id, kind: m.kind, text: m.text, pinned: m.pinned,
        }));

      printLog(`[MemoryExtract] 开始抽取用户 ${nickName}(${userId}) 的记忆，`
        + `送 ${messages.length} 条${windowSize > messages.length ? `（窗口 ${windowSize} 条）` : ''}`
        + `${skipped > 0 ? `，过滤掉 ${skipped} 条无信息量消息` : ''}`);
      const ops = await extractMemory(nickName, messages.map((m) => m.text), existing);

      // 这批在路上时可能刚被拉黑，结果直接丢掉，不写库也不放回缓冲区
      if (this.isBlocked(userId)) {
        printLog(`[MemoryExtract] 用户 ${nickName}(${userId}) 已在黑名单，丢弃本批抽取结果`);
        return;
      }

      if (ops === null) {
        // 请求失败：把这批消息放回缓冲区头部，等下次一起重试，而不是无声丢弃。
        // 冷却也退回一个短重试间隔——失败不该白吃掉几个小时
        if (buffer) {
          buffer.messages.unshift(...messages);
          const cap = this.maxBuffer();
          if (buffer.messages.length > cap) {
            buffer.messages.splice(0, buffer.messages.length - cap);
          }
          buffer.nextExtractAt = Math.min(buffer.nextExtractAt, Date.now() + RETRY_DELAY_MS);
        }
        printError(`[MemoryExtract] 抽取用户 ${nickName}(${userId}) 失败，消息已放回缓冲区等待重试`);
        return;
      }

      // 单群批次记录来源群；跨群混合批次不随意归到最后一个群，记为跨群来源。
      const sourceGroups = new Set(messages.map((m) => m.groupId));
      const sourceGroupId = sourceGroups.size === 1 ? messages[0].groupId : null;
      const foreignNames = getMemoryDb().prepare(
        'SELECT DISTINCT nick FROM group_user_profile WHERE user_id != ? AND nick != ?',
      ).all(userId, nickName) as { nick: string }[];
      const safeOps = ops.filter((op) => {
        if (op.op === 'DELETE') return true;
        if ((op.confidence ?? 0.6) < 0.7 || !op.text) return false;
        // 其他群友被写成句子主语时，不把整条事实归给当前用户。
        return !/^(?:他|她|对方|某人|群友)/.test(op.text)
          && !foreignNames.some(({ nick }) => nick.length >= 2 && op.text!.startsWith(nick));
      });
      const result = memoryStore.applyOps(userId, sourceGroupId, safeOps);

      // 只是把已知的事又说了一遍不算学到东西，这种轮次照样该退避
      const learned = result.added.length + result.updated.length + result.deleted.length;
      if (buffer) {
        buffer.emptyStreak = learned > 0 ? 0 : Math.min(buffer.emptyStreak + 1, MAX_BACKOFF_STEPS);
      }
      if (learned === 0) {
        printLog(`[MemoryExtract] ${nickName}(${userId}) 本轮没有新记忆`
          + `${result.reaffirmed > 0 ? `（${result.reaffirmed} 条被再次印证）` : ''}`
          + `${buffer ? `，阈值升到 ${this.thresholdFor(buffer)}` : ''}`);
        return;
      }

      const evicted = memoryStore.evict(userId);

      // 淘汰掉的不用再算向量
      const doomed = new Set(evicted);
      const changed = [...new Set([...result.added, ...result.updated])].filter((id) => !doomed.has(id));
      const evidenceBatch = memoryStore.attachEvidence(changed, userId, messages);
      enqueueEmbedding(changed);

      printLog(`[MemoryExtract] ${nickName}(${userId}) 记忆更新：`
        + `新增 ${result.added.length}、更新 ${result.updated.length}、删除 ${result.deleted.length}`
        + `${result.reaffirmed > 0 ? `、再次印证 ${result.reaffirmed}` : ''}`
        + `${result.blocked > 0 ? `、挡下 ${result.blocked} 次对钉住条目的改动` : ''}`
        + `${evicted.length > 0 ? `、淘汰 ${evicted.length}` : ''}`
        + `${evidenceBatch === null ? '' : `、证据批次 ${evidenceBatch}`}`);
    } catch (e) {
      printError(`[MemoryExtract] 抽取用户 ${userId} 失败: ${e}`);
    } finally {
      if (buffer) buffer.isExtracting = false;
    }
  }
}

export default new MemoryExtractor();
