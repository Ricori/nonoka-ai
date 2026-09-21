import { printError, printLog } from '@/utils/print';
import { backupDateKey } from '../storage/message';
import { getMemoryDb } from '../memory/db';
import memoryStore from '../memory/store';
import { stripSpeakerPrefix } from '../memory/segment';
import { HISTORY_DAYS } from '../memory/policy';
import { matchAlias, normalizeAlias, normalizeText } from './nameMatch';

/**
 * 昵称索引：userId -> 这个人用过的全部名字。
 *
 * 群友问「XXX是谁」时，光靠「最近发过言的人」永远找不到 XXX——他此刻很可能没在说话。
 * 这里从聊天记录反推出「名字 -> userId」的映射，让被提到的人也能被认出来。
 *
 * 别名全自动派生，不需要人工维护：每条记录都带发言时的昵称，
 * 归一下就能拿到每个人的历史昵称，连改名前的旧名一起收进来——
 * 这恰恰是只存当前昵称的档案做不到的（改了名，旧名就永远对不上了）。
 *
 * 数据源是 `chat_line` 表而不是备份文件：同样的内容，一条 GROUP BY 就出来了，
 * 不用把几百个文件逐行读一遍
 */

/**
 * 只看这么多天内的记录。更早的昵称基本没人再叫了，留着只会扩大误命中面
 */
const INDEX_DAYS = HISTORY_DAYS;

/** 一条消息最多认出几个人，多了大概率是误命中 */
const MAX_CANDIDATES = 4;

/** 一个 userId 的全部曾用名 */
interface UserAliases {
  /** 归一化昵称 -> 最后一次见到的日期 yyyymmdd，撞名时用来判断谁更近活跃 */
  aliases: Map<string, number>;
  /** 出现过的群。解析时只认同群的人，避免跨群撞名张冠李戴 */
  groups: Set<number>;
}

class AliasIndex {
  private byUser = new Map<number, UserAliases>();

  /** 日志建底是一次性的，首次解析时才做，避免拖慢启动 */
  private built = false;

  private builtDate = '';

  invalidate() {
    this.byUser.clear();
    this.built = false;
  }

  private entryOf(userId: number): UserAliases {
    let entry = this.byUser.get(userId);
    if (!entry) {
      entry = { aliases: new Map(), groups: new Set() };
      this.byUser.set(userId, entry);
    }
    return entry;
  }

  /**
   * 记下某人在某群用过的昵称。日志建底走这里，收到新消息时也走这里——
   * 改名后当天就能认出新名字，不用等下次重启
   */
  note(groupId: number, userId: number, nickName: string, date = Number(backupDateKey())) {
    // bot 自己不进索引
    if (userId === 0) return;
    const alias = normalizeAlias(nickName);
    if (!alias) return;

    const entry = this.entryOf(userId);
    entry.groups.add(groupId);
    if (date > (entry.aliases.get(alias) ?? 0)) {
      entry.aliases.set(alias, date);
    }
  }


  /**
   * 并入人工写在 data/memory/user/{userId}.json 的 aliases。
   * 自动派生只能拿到日志里出现过的写法，圈内外号、本名这类和昵称毫无字面关系的叫法
   * 只能人工补。返回补进去的条数。
   *
   * 只给已经在日志里露过面的人加：索引靠 groups 做同群约束，
   * 一个群都没出现过的人无从归属，硬加进去会变成跨群误命中
   */
  private addManualAliases(): number {
    const today = Number(backupDateKey());
    let added = 0;

    memoryStore.getManualAliases().forEach((aliases, userId) => {
      const entry = this.byUser.get(userId);
      if (!entry) return;
      aliases.forEach((raw) => {
        const alias = normalizeAlias(raw);
        // 人工确认过的叫法按「今天见过」算，撞名时压过日志里的旧名
        if (alias && !entry.aliases.has(alias)) {
          entry.aliases.set(alias, today);
          added += 1;
        }
      });
    });
    return added;
  }

  /**
   * 管理面板加完别名后立刻并进索引，省得为一条别名重启 bot。
   * 返回 false 表示这人在日志里一次都没露过面，无从判断属于哪个群，只能等下次建底
   */
  noteManualAlias(userId: number, raw: string): boolean {
    // 还没建底就什么都不用做，build() 会连人工别名一起读进来
    if (!this.built) return true;

    const entry = this.byUser.get(userId);
    const alias = normalizeAlias(raw);
    if (!entry || !alias) return false;

    entry.aliases.set(alias, Number(backupDateKey()));
    return true;
  }

  /** 查 chat_line 建底，失败不致命：索引空着只是认不出人，不影响回复 */
  private build() {
    this.built = true;
    this.builtDate = backupDateKey();
    const oldest = Number(backupDateKey(new Date(Date.now() - INDEX_DAYS * 24 * 60 * 60 * 1000)));

    try {
      // 每个「群 + 人 + 昵称」只出一行，顺带把最后一次用这个名字的日期带出来
      const rows = getMemoryDb().prepare(`
        SELECT group_id, user_id, nick, max(date_key) AS date_key FROM chat_line
        WHERE date_key >= ? AND user_id != 0 AND nick IS NOT NULL AND nick != ''
        GROUP BY group_id, user_id, nick
      `).all(oldest) as { group_id: number, user_id: number, nick: string, date_key: number }[];

      rows.forEach((r) => this.note(r.group_id, r.user_id, r.nick, r.date_key));
      const manual = this.addManualAliases();
      const aliasCount = [...this.byUser.values()].reduce((n, e) => n + e.aliases.size, 0);
      printLog(`[AliasIndex] 已从 ${rows.length} 条昵称记录建立 ${this.byUser.size} 人 / ${aliasCount} 个昵称的索引`
        + `（其中 ${manual} 个来自档案里人工填的 aliases）`);
    } catch (e) {
      printError(`[AliasIndex] 建立昵称索引失败: ${e}`);
    }
  }

  /**
   * 从一条群消息里认出被提到的群友，按匹配得分降序返回 userId。
   * 只返回和本群有过交集的人；有没有档案可注入由调用方判断
   */
  resolve(groupId: number, message: string, preferExact = false): number[] {
    if (this.built && this.builtDate !== backupDateKey()) this.invalidate();
    if (!this.built) this.build();

    const text = normalizeText(stripSpeakerPrefix(message));
    if (!text) return [];
    if (preferExact) {
      const exact = [...this.byUser.entries()].filter(([, entry]) => entry.groups.has(groupId)
        && entry.aliases.has(normalizeAlias(message))).map(([id]) => id);
      if (exact.length) return exact;
    }

    const scored: { userId: number; score: number; lastSeen: number }[] = [];
    this.byUser.forEach((entry, userId) => {
      if (!entry.groups.has(groupId)) return;

      let score = 0;
      let lastSeen = 0;
      entry.aliases.forEach((date, alias) => {
        const s = matchAlias(text, alias);
        if (s > 0) {
          score = Math.max(score, s);
          lastSeen = Math.max(lastSeen, date);
        }
      });
      if (score > 0) scored.push({ userId, score, lastSeen });
    });

    // 同名的人取最近还在活跃的那个：`azu`、`泽叶` 这类昵称在群里真的被两个号用过
    scored.sort((a, b) => b.score - a.score || b.lastSeen - a.lastSeen);
    return scored.slice(0, MAX_CANDIDATES).map((c) => c.userId);
  }
}

export default new AliasIndex();
