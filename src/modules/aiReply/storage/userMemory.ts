import fs from 'fs';
import path from 'path';
import { summarizeUserTraits } from '@/service/llm';
import { printError, printLog } from '@/utils/print';

const SUMMARY_THRESHOLD = 6; // 每攒够 20 句触发一次
const MAX_TRAITS = 6; // 核心特征上限：6个
const MEMORY_DIR = path.resolve(process.cwd(), 'data/memory/user');

interface UserMemoryFile {
  userId: number;
  nickName: string;
  /** 最多 6 条核心特征短句 */
  traits: string[];
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

  /** 内存缓存，避免频繁读盘 (key: userId) */
  private cache = new Map<number, UserMemoryFile>();

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

  private loadUser(userId: number): UserMemoryFile | null {
    if (this.cache.has(userId)) {
      return this.cache.get(userId)!;
    }
    const data = this.loadUserFromDisk(userId);
    if (data) this.cache.set(userId, data);
    return data;
  }

  private saveUser(data: UserMemoryFile) {
    this.cache.set(data.userId, data);
    fs.writeFileSync(this.getFilePath(data.userId), JSON.stringify(data, null, 2), 'utf-8');
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
        this.saveUser({
          userId,
          nickName,
          traits: newTraits.slice(0, MAX_TRAITS),
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
   * 仅返回有记忆数据的用户。
   */
  getMemoryContext(userIds: number[]): string {
    const parts: string[] = [];
    for (const userId of userIds) {
      const data = this.loadUser(userId);
      if (data && data.traits.length > 0) {
        parts.push(`[${data.nickName}] ${data.traits.join('、')}`);
      }
    }
    if (parts.length === 0) return '';
    return parts.join('\n');
  }
}

export default new UserMemoryStorage();
