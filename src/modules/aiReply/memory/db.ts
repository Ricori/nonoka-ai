import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { printError, printLog } from '@/utils/print';

export type MemoryDatabase = Database.Database;

const MEMORY_DB_PATH = path.resolve('data/memory/nonoka.db');

/** 基线 schema 对应的版本号。低于它的库已经不存在，见 BASELINE 注释 */
const BASELINE_VERSION = 9;

/**
 * v9 基线：v1~v9 的增量脚本压平成的最终形态，只对空库执行一次。
 * 线上库已统一迁到 v9（语义召回改用定长窗口、删掉 LLM 话题），逐版重放已无意义。
 *
 * 之后的 schema 变更走 MIGRATIONS，并把结果同步回这里，两边保持一致。
 */
const BASELINE = `
  -- ========== 字面检索层 ==========
  CREATE TABLE chat_line (
    id       INTEGER PRIMARY KEY,
    group_id INTEGER NOT NULL,
    user_id  INTEGER NOT NULL,
    date_key INTEGER NOT NULL,        -- yyyymmdd
    seq      INTEGER NOT NULL,        -- 文件内行号，保证同日顺序 + 幂等
    nick     TEXT,
    text     TEXT NOT NULL,           -- 已剥掉 [userId] 外壳的原文
    UNIQUE(group_id, date_key, seq)       -- 兼作 (group_id, date_key) 的索引
  );
  CREATE INDEX idx_chat_user ON chat_line(group_id, user_id, date_key);

  -- 普通表而非 external content：索引的是分词后的 seg，rowid 手工对齐 chat_line.id
  CREATE VIRTUAL TABLE chat_fts USING fts5(seg, tokenize='unicode61');

  -- ========== 语义记忆层 ==========
  CREATE TABLE memory (
    -- 硬删除后 id 不能复用：异步抽取拿旧 id 回来改，复用会改到别的条目上
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    scope         TEXT    NOT NULL,   -- 'user' | 'group'
    owner_id      INTEGER NOT NULL,   -- userId / groupId
    group_id      INTEGER,            -- 来源群，NULL 表示多群混合/人工；不作为用户档案可见性边界
    kind          TEXT    NOT NULL,   -- 'trait' | 'episode' | 'relation' | 'alias'
    text          TEXT    NOT NULL,
    first_seen    INTEGER NOT NULL,
    last_seen     INTEGER NOT NULL,
    hits          INTEGER NOT NULL DEFAULT 1,   -- 被重复印证的次数
    confidence    REAL    NOT NULL DEFAULT 0.6,
    pinned        INTEGER NOT NULL DEFAULT 0,   -- 人工钉住，永不淘汰/覆盖；失效的条目直接物理删除
    source        TEXT,                         -- 溯源：'MM-DD 原话片段'
    updated_at    INTEGER NOT NULL,
    verified      INTEGER NOT NULL DEFAULT 0    -- 人工确认过；未确认的身份类条目不参与回复
  );
  CREATE INDEX idx_mem_owner ON memory(scope, owner_id);

  CREATE VIRTUAL TABLE memory_fts USING fts5(seg, tokenize='unicode61');

  -- 抽取时的原始证据批次，只追加不修改，供记忆溯源
  CREATE TABLE memory_evidence_batch (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL,
    group_ids     TEXT    NOT NULL,
    message_ids   TEXT    NOT NULL,
    messages      TEXT    NOT NULL,
    observed_from INTEGER NOT NULL,
    observed_to   INTEGER NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX idx_evidence_batch_user ON memory_evidence_batch(user_id, created_at DESC);

  CREATE TABLE memory_evidence (
    memory_id  INTEGER NOT NULL,
    batch_id   INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (memory_id, batch_id),
    FOREIGN KEY (memory_id) REFERENCES memory(id),
    FOREIGN KEY (batch_id) REFERENCES memory_evidence_batch(id)
  );
  CREATE INDEX idx_memory_evidence_batch ON memory_evidence(batch_id);

  -- ========== 语义窗口层（聊天记录向量检索的载体）==========
  -- 日志按固定行数切的重叠窗口，零模型调用
  CREATE TABLE chat_window (
    id        INTEGER PRIMARY KEY,
    group_id  INTEGER NOT NULL,
    date_key  INTEGER NOT NULL,
    line_from INTEGER NOT NULL,       -- chat_line.id 区间
    line_to   INTEGER NOT NULL,
    text      TEXT    NOT NULL,       -- 拿去向量化的正文，已剥昵称
    UNIQUE(group_id, date_key, line_from)
  );

  CREATE TABLE embedding (
    ref_kind TEXT    NOT NULL,        -- 'memory' | 'window'
    ref_id   INTEGER NOT NULL,
    vec      BLOB    NOT NULL,        -- Float32Array
    PRIMARY KEY (ref_kind, ref_id)
  );

  -- ========== 运行时状态 ==========
  -- 群内当前昵称。同一个 QQ 用户在不同群可能使用不同群名片
  CREATE TABLE group_user_profile (
    group_id   INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    nick       TEXT    NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE INDEX idx_group_user_profile_nick ON group_user_profile(group_id, nick);

  -- 定时巩固的历史与积压状态
  CREATE TABLE consolidation_run (
    id                  INTEGER PRIMARY KEY,
    started_at          INTEGER NOT NULL,
    finished_at         INTEGER,
    status              TEXT    NOT NULL,
    pending_before      INTEGER NOT NULL,   -- 缺向量的窗口 + 记忆
    pending_after       INTEGER,
    oldest_pending_date INTEGER,            -- 最早一个缺向量窗口的日期
    ingested_lines      INTEGER NOT NULL DEFAULT 0,
    windows             INTEGER NOT NULL DEFAULT 0,
    embedded            INTEGER NOT NULL DEFAULT 0,
    evicted             INTEGER NOT NULL DEFAULT 0,
    error               TEXT
  );
  CREATE INDEX idx_consolidation_run_started ON consolidation_run(started_at DESC);
`;

/**
 * 基线之后的增量迁移，下标 + BASELINE_VERSION + 1 即为版本号。
 * 已经发布过的条目只能追加、不能修改，否则老库和新库会长成两个样子
 */
const MIGRATIONS: string[] = [];

const LATEST_VERSION = BASELINE_VERSION + MIGRATIONS.length;

/** meta 读写在热路径上（每条消息都会碰水位），按连接缓存 prepare 结果 */
const metaStmts = new WeakMap<MemoryDatabase, {
  get: Database.Statement;
  set: Database.Statement;
  del: Database.Statement;
}>();

function meta(db: MemoryDatabase) {
  let stmts = metaStmts.get(db);
  if (!stmts) {
    stmts = {
      get: db.prepare('SELECT value FROM meta WHERE key = ?'),
      set: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      del: db.prepare('DELETE FROM meta WHERE key = ?'),
    };
    metaStmts.set(db, stmts);
  }
  return stmts;
}

/** 读一条 meta，没有返回 null */
export function getMeta(db: MemoryDatabase, key: string): string | null {
  const row = meta(db).get.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/** 写一条 meta，存在则覆盖 */
export function setMeta(db: MemoryDatabase, key: string, value: string) {
  meta(db).set.run(key, value);
}

/** 删一条 meta */
export function delMeta(db: MemoryDatabase, key: string) {
  meta(db).del.run(key);
}

/** 空库建基线，非空库按 meta.schema_version 递增执行未应用的迁移，每步单独一个事务 */
function migrate(db: MemoryDatabase) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');

  let current = parseInt(getMeta(db, 'schema_version') ?? '0', 10) || 0;

  if (current === 0) {
    // 有表却没有版本号：不是空库，也不知道它长什么样，建基线只会撞表名，不如直接停
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_line'").get()) {
      throw new Error('记忆库已有数据表但缺少 meta.schema_version，拒绝在上面建基线 schema');
    }
    db.transaction(() => {
      db.exec(BASELINE);
      setMeta(db, 'schema_version', String(BASELINE_VERSION));
    })();
    printLog(`[MemoryDB] 建库并初始化至 v${BASELINE_VERSION}`);
    current = BASELINE_VERSION;
  } else if (current < BASELINE_VERSION) {
    // v1~v8 的增量脚本已被压平删除，这种库只能先用旧版本代码升到 v9
    throw new Error(`记忆库 schema v${current} 低于基线 v${BASELINE_VERSION}，请先用旧版本代码升级`);
  }

  for (let v = current; v < LATEST_VERSION; v++) {
    const sql = MIGRATIONS[v - BASELINE_VERSION];
    db.transaction(() => {
      db.exec(sql);
      setMeta(db, 'schema_version', String(v + 1));
    })();
    printLog(`[MemoryDB] schema 迁移至 v${v + 1}`);
  }
}

/**
 * 建连接 + 迁移到最新 schema。测试传临时路径，正常调用走 getMemoryDb()
 */
export function createMemoryDb(file: string = MEMORY_DB_PATH): MemoryDatabase {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new Database(file);
  // 只对空库生效：热历史每天滚动删除，空页得能还给文件系统，见 maintainMemory
  db.pragma('auto_vacuum = INCREMENTAL');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY'); // FTS / ORDER BY 的临时表不落盘
  db.pragma('cache_size = -32000'); // 32MB 页缓存，负数是 KiB 不是页数
  db.pragma('mmap_size = 268435456'); // 256MB，读多写少的库靠 mmap 省一次拷贝

  // 开库时没有并发读者，被上一轮长事务撑大的 WAL 只有这时能截断掉
  db.pragma('wal_checkpoint(TRUNCATE)');

  try {
    migrate(db);
  } catch (e) {
    db.close();
    printError(`[MemoryDB] schema 迁移失败: ${e}`);
    throw e;
  }
  return db;
}

let defaultDb: MemoryDatabase | null = null;

/** 默认记忆库单例，首次调用时才建连接 */
export function getMemoryDb(): MemoryDatabase {
  if (!defaultDb) {
    defaultDb = createMemoryDb();
    // 退出时收尾：不关的话 WAL 会一直留着，下次开库前白占几十 MB
    process.once('exit', () => closeMemoryDb());
  }
  return defaultDb;
}

/** 关掉单例连接并回收 WAL。重复调用无副作用 */
export function closeMemoryDb() {
  if (!defaultDb) return;
  const db = defaultDb;
  defaultDb = null;
  try {
    if (db.open) {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    }
  } catch (e) {
    printError(`[MemoryDB] 关闭失败: ${e}`);
  }
}
