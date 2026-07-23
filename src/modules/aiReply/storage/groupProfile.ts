import fs from 'fs';
import path from 'path';
import { printError, printLog } from '@/utils/print';

const PROFILE_DIR = path.resolve(process.cwd(), 'data/memory/group');

export interface GroupProfile {
  groupId: number;
  /** 主动插话概率的整体缩放系数，1 为维持原状 */
  chanceScale: number;
  /** 注入 system 的群环境描述（多行文本，人工撰写） */
  profileText: string;
  updatedAt: number;
}

/** 没有档案文件的群一律按这份默认值走，行为与改造前一致 */
const DEFAULT_PROFILE = { chanceScale: 1, profileText: '', updatedAt: 0 };

interface CacheEntry {
  profile: GroupProfile;
  /** 缓存对应的文件修改时间与体积，两者一致才认为文件没被人工改过 */
  mtimeMs: number;
  size: number;
}

/**
 * 群档案：`data/memory/group/{groupId}.json`，由运营者手工维护。
 * 读取时按文件 mtime 判断缓存是否过期，改完 JSON 无需重启 bot。
 */
class GroupProfileStorage {
  private cache = new Map<number, CacheEntry>();

  constructor() {
    this.ensureDir();
    this.logExistingProfiles();
  }

  private ensureDir() {
    if (!fs.existsSync(PROFILE_DIR)) {
      fs.mkdirSync(PROFILE_DIR, { recursive: true });
    }
  }

  private logExistingProfiles() {
    try {
      const count = fs.readdirSync(PROFILE_DIR).filter((f) => f.endsWith('.json')).length;
      printLog(`[GroupProfile] 已加载 ${count} 个群档案`);
    } catch (e) {
      printError(`[GroupProfile] 读取群档案目录失败: ${e}`);
    }
  }

  private getFilePath(groupId: number) {
    return path.join(PROFILE_DIR, `${groupId}.json`);
  }

  /** 读盘并做字段兜底，任何异常都退回默认值，不能影响回复主流程 */
  private loadFromDisk(groupId: number): GroupProfile {
    const fallback: GroupProfile = { groupId, ...DEFAULT_PROFILE };
    try {
      const raw = JSON.parse(fs.readFileSync(this.getFilePath(groupId), 'utf-8'));
      const scale = Number(raw?.chanceScale);
      return {
        groupId,
        chanceScale: Number.isFinite(scale) && scale >= 0 ? scale : 1,
        profileText: typeof raw?.profileText === 'string' ? raw.profileText : '',
        updatedAt: Number(raw?.updatedAt) || 0,
      };
    } catch (e) {
      printError(`[GroupProfile] 群 ${groupId} 档案解析失败，按默认值处理: ${e}`);
      return fallback;
    }
  }

  /** 获取群档案，无文件时返回默认值（不自动建文件） */
  getProfile(groupId: number): GroupProfile {
    const stat = fs.statSync(this.getFilePath(groupId), { throwIfNoEntry: false });
    if (!stat) {
      this.cache.delete(groupId);
      return { groupId, ...DEFAULT_PROFILE };
    }

    const cached = this.cache.get(groupId);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.profile;
    }

    const profile = this.loadFromDisk(groupId);
    this.cache.set(groupId, { profile, mtimeMs: stat.mtimeMs, size: stat.size });
    printLog(`[GroupProfile] 群 ${groupId} 档案已加载: chanceScale=${profile.chanceScale}`);
    return profile;
  }
}

export default new GroupProfileStorage();
