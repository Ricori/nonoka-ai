import fs from 'fs';
import path from 'path';
import { summarizeUserTraits } from '@/service/llm';
import { printError, printLog } from '@/utils/print';

const SUMMARY_THRESHOLD = 30; // 每攒够 30 句触发一次
const MAX_TRAITS = 6; // 核心特征上限：6个
const MEMORY_DIR = path.resolve(process.cwd(), 'data/memory/user');

interface UserMemoryFile {
  userId: number;
  nickName: string;
  /** 最多 6 条核心特征短句 */
  traits: string[];
  /** 与 bot 的关系 / 群内身份，人工维护，LLM 总结绝不覆盖 */
  relations?: string[];
  updatedAt: number;
}

interface PendingBuffer {
  messages: string[];
  nickName: string;
  isSummarizing: boolean;
}

class UserMemoryStorage {
  /** 已@过bot、需要追踪的用户ID集合 */
  private trackedUsers = new Set<number>();

  /** 待总结的消息缓冲 (key: userId) */
  private pendingBuffers = new Map<number, PendingBuffer>();

  /** 内存缓存，避免频繁读盘 (key: userId)，按文件 mtime + 体积判断是否过期 */
  private cache = new Map<number, { data: UserMemoryFile, mtimeMs: number, size: number }>();

  constructor() {
    this.ensureDir();
    this.loadTrackedUsersFromDisk();
  }

  private ensureDir() {
    if (!fs.existsSync(MEMORY_DIR)) {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
    }
  }

  /** 启动时从磁盘加载已有用户的追踪状态 */
  private loadTrackedUsersFromDisk() {
    try {
      const files = fs.readdirSync(MEMORY_DIR);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const userId = parseInt(file.replace('.json', ''), 10);
          if (!Number.isNaN(userId)) {
            this.trackedUsers.add(userId);
          }
        }
      }
      printLog(`[UserMemory] 已加载 ${this.trackedUsers.size} 个用户记忆`);
    } catch (e) {
      printError(`[UserMemory] 加载用户列表失败: ${e}`);
    }
  }

  private getFilePath(userId: number) {
    return path.join(MEMORY_DIR, `${userId}.json`);
  }

  private loadUserFromDisk(userId: number): UserMemoryFile | null {
    try {
      const content = fs.readFileSync(this.getFilePath(userId), 'utf-8');
      return JSON.parse(content) as UserMemoryFile;
    } catch {
      return null;
    }
  }

  /** 读档案；relations 允许人工直接改 JSON，所以文件变了就重新读盘 */
  private loadUser(userId: number): UserMemoryFile | null {
    const stat = fs.statSync(this.getFilePath(userId), { throwIfNoEntry: false });
    if (!stat) {
      this.cache.delete(userId);
      return null;
    }

    const cached = this.cache.get(userId);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.data;
    }

    const data = this.loadUserFromDisk(userId);
    if (data) this.cache.set(userId, { data, mtimeMs: stat.mtimeMs, size: stat.size });
    return data;
  }

  private saveUser(data: UserMemoryFile) {
    fs.writeFileSync(this.getFilePath(data.userId), JSON.stringify(data, null, 2), 'utf-8');
    // 让缓存失效，下次读盘时连同 mtime 一起刷新
    this.cache.delete(data.userId);
  }

  /**
   * 处理群消息：
   * - 若该消息 @了bot，将该用户加入追踪
   * - 若已追踪，累积消息；达到阈值后异步触发总结
   */
  onMessage(userId: number, nickName: string, message: string, isMentionMe: boolean) {
    if (isMentionMe) {
      this.trackedUsers.add(userId);
    }

    if (!this.trackedUsers.has(userId)) return;

    if (!this.pendingBuffers.has(userId)) {
      this.pendingBuffers.set(userId, { messages: [], nickName, isSummarizing: false });
    }

    const buffer = this.pendingBuffers.get(userId)!;
    buffer.nickName = nickName; // 保持最新昵称
    buffer.messages.push(message);

    if (buffer.messages.length >= SUMMARY_THRESHOLD && !buffer.isSummarizing) {
      const messagesToSummarize = buffer.messages.splice(0, SUMMARY_THRESHOLD);
      this.triggerSummarize(userId, buffer.nickName, messagesToSummarize).catch(() => { });
    }
  }

  /** 后台异步总结，不阻塞主流程 */
  private async triggerSummarize(userId: number, nickName: string, messages: string[]) {
    const buffer = this.pendingBuffers.get(userId);
    if (buffer) buffer.isSummarizing = true;

    try {
      const existing = this.loadUser(userId);
      const existingTraits = existing?.traits ?? [];

      printLog(`[UserMemory] 开始总结用户 ${nickName}(${userId}) 的特征...`);
      const newTraits = await summarizeUserTraits(nickName, messages, existingTraits);

      if (newTraits.length > 0) {
        // relations 是人工维护的，整对象覆盖写时必须原样带上
        const relations = this.loadUser(userId)?.relations;
        this.saveUser({
          userId,
          nickName,
          traits: newTraits.slice(0, MAX_TRAITS),
          ...(relations?.length ? { relations } : {}),
          updatedAt: Date.now(),
        });
        printLog(`[UserMemory] 用户 ${nickName}(${userId}) 特征更新: [${newTraits.join(', ')}]`);
      }
    } catch (e) {
      printError(`[UserMemory] 总结用户 ${userId} 失败: ${e}`);
    } finally {
      if (buffer) buffer.isSummarizing = false;
    }
  }

  /** 获取指定用户的特征列表 */
  getTraits(userId: number): string[] {
    return this.loadUser(userId)?.traits ?? [];
  }

  /**
   * 根据当前对话中出现的用户ID，生成注入 prompt 的记忆上下文。
   * 仅返回有记忆数据的用户；关系是人工确认过的，排在 LLM 总结的印象之前。
   */
  getMemoryContext(userIds: number[]): string {
    return userIds
      .map((userId) => this.formatMemoryLine(userId))
      .filter((line): line is string => line !== null)
      .join('\n');
  }

  /** 单个群友的一行档案文本，没有可用内容时返回 null */
  private formatMemoryLine(userId: number): string | null {
    const data = this.loadUser(userId);
    if (!data) return null;

    if (!data.relations?.length) {
      // 绝大多数群友没有关系条目，维持原格式，不平白改动 prompt
      return data.traits.length ? `[${data.nickName}] ${data.traits.join('、')}` : null;
    }

    const traits = data.traits.length ? `｜印象：${data.traits.join('、')}` : '';
    return `[${data.nickName}] 关系：${data.relations.join('；')}${traits}`;
  }
}

export default new UserMemoryStorage();
