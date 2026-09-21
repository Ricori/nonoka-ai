import fs from 'fs';
import path from 'path';
import type { Statement } from 'better-sqlite3';
import { printError, printLog } from '@/utils/print';
import { CHAT_BACKUP_DIR } from '../storage/message';
import {
  getMemoryDb, getMeta, setMeta, type MemoryDatabase,
} from './db';
import { dictSignature, segment, stripSpeakerPrefix } from './segment';
import { historySince, usableMemorySql } from './policy';
import { maintainMemory } from './maintenance';

/**
 * 把 data/memory/chat/*.txt 导进 chat_line + chat_fts。
 *
 * SQLite 只是派生索引，备份 txt 才是唯一真相：整个库删掉重跑一次就能全量重建。
 * 幂等靠 UNIQUE(group_id, date_key, seq)，增量靠 meta 里每群每日的水位。
 */

/** 备份文件名 `{groupId}_{yyyymmdd}.txt` */
const FILE_RE = /^(\d+)_(\d{8})\.txt$/;

/** 备份行格式 `[userId]内容` */
const LINE_RE = /^\[(\d+)\](.*)$/;

/** 行首的 `[昵称]` */
const NICK_RE = /^\[([^\]]*)\]/;

/** bot 自己的行额外带触发标记，见 storage/message.ts 的 backupTriggerMark。
 *  `旧账` 是 `工具` 在关键词预注入时代的前身，老日志里还有，一并认掉 */
const BOT_MARK_RE = /^(?:\[(?:主动 [\d.]+|被动|工具 \d+|旧账 \d+|点名 \d+)\])+/;

interface ParsedLine {
  userId: number;
  nick: string | null;
  /** 入库原文，群友的行保留 `[昵称]说：` 前缀，注入时直接用 */
  text: string;
  /** 拿去分词的正文，前缀已剥掉 */
  body: string;
}

/**
 * CRLF 文件按 \n 切完会留下尾部的 \r，而正则里的 `.` 不匹配 \r，
 * 不剥掉的话 `(.*)$` 匹配不上，整行会被当成格式不对静默丢掉
 */
function stripCr(raw: string): string {
  return raw.endsWith('\r') ? raw.slice(0, -1) : raw;
}

/** 解析一行备份，格式不对或内容为空返回 null */
export function parseBackupLine(raw: string): ParsedLine | null {
  const line = stripCr(raw);

  const m = LINE_RE.exec(line);
  if (!m) return null;

  const userId = Number(m[1]);
  // bot 自己的行没有昵称前缀，只需剥掉触发标记
  const text = userId === 0 ? m[2].replace(BOT_MARK_RE, '') : m[2];
  if (!text) return null;

  return {
    userId,
    nick: userId === 0 ? null : NICK_RE.exec(text)?.[1] ?? null,
    text,
    body: indexBody(userId, text),
  };
}

/** 拿去分词的正文。bot 自己的行本来就没有 `[昵称]说：` 前缀 */
function indexBody(userId: number, text: string): string {
  return userId === 0 ? text : stripSpeakerPrefix(text);
}

interface FileMessage {
  /** 首行在文件里的行号，决定这条消息的 seq */
  seq: number;
  parsed: ParsedLine;
}

/**
 * 把一个备份文件解析成消息序列。
 *
 * 备份是一行一条消息，但群友粘的长公告、转发内容正文里自带换行，
 * 会被写成好几行 —— 只有带 `[userId][昵称]` 前缀的首行认得出来，
 * 后续行不接回去就整段检索不到（实测占全库 2.4%）。
 * 判据是「不以 `[数字]` 开头」，`[图片]` 这种占位符照样接得回去
 */
function parseFileMessages(lines: string[]): FileMessage[] {
  const messages: FileMessage[] = [];

  lines.forEach((raw, seq) => {
    const parsed = parseBackupLine(raw);
    if (parsed) {
      messages.push({ seq, parsed });
      return;
    }

    const tail = stripCr(raw).trim();
    const prev = messages[messages.length - 1];
    // 接回上一条。用空格而不是换行连接：注入时一条命中占一行，正文里带换行会把格式冲散
    if (prev && tail !== '') {
      prev.parsed.text += ` ${tail}`;
      prev.parsed.body += ` ${tail}`;
    }
  });

  return messages;
}

/** 词典指纹存这里，变了就得重建全文索引 */
const DICT_KEY = 'segment_dict';

/** 重建时每批读多少行。不能用 iterate：游标没关的时候同一个连接不许写 */
const REBUILD_CHUNK = 5000;

/** 按 id 分批遍历一张表，sql 需以 `WHERE id > ? ORDER BY id LIMIT ?` 收尾 */
function eachRow<T extends { id: number }>(db: MemoryDatabase, sql: string, fn: (row: T) => void) {
  const stmt = db.prepare(sql);
  let lastId = 0;
  for (; ;) {
    const rows = stmt.all(lastId, REBUILD_CHUNK) as T[];
    if (rows.length === 0) return;
    rows.forEach(fn);
    lastId = rows[rows.length - 1].id;
  }
}

/**
 * 自定义词典改过就把两张 FTS 表按现有数据重建。
 * 索引侧和查询侧必须用同一套分词，不然「手办」这类词换了切法后就再也召不回
 */
function rebuildFtsIfDictChanged(db: MemoryDatabase) {
  const signature = dictSignature();
  if (getMeta(db, DICT_KEY) === signature) return;

  const { n } = db.prepare('SELECT count(*) AS n FROM chat_line').get() as { n: number };
  if (n > 0) printLog(`[Ingest] 分词词典已变更，重建 ${n} 行全文索引...`);

  db.transaction(() => {
    db.exec('DELETE FROM chat_fts');
    const insertChat = db.prepare('INSERT INTO chat_fts (rowid, seg) VALUES (?, ?)');
    eachRow<{ id: number, user_id: number, text: string }>(
      db,
      'SELECT id, user_id, text FROM chat_line WHERE id > ? ORDER BY id LIMIT ?',
      (row) => insertChat.run(row.id, segment(indexBody(row.user_id, row.text))),
    );

    db.exec('DELETE FROM memory_fts');
    const insertMem = db.prepare('INSERT INTO memory_fts (rowid, seg) VALUES (?, ?)');
    eachRow<{ id: number, text: string }>(
      db,
      `SELECT id, text FROM memory m WHERE ${usableMemorySql()} AND id > ? ORDER BY id LIMIT ?`,
      (row) => insertMem.run(row.id, segment(row.text)),
    );

    setMeta(db, DICT_KEY, signature);
  })();
}

/** 读一个备份文件的行。末尾换行切出来的空串不算一行，否则下次追加时这个位置会被水位跳过 */
function readBackupLines(file: string): string[] {
  const lines = fs.readFileSync(path.join(CHAT_BACKUP_DIR, file), 'utf-8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 解析规则的版本。改了 parseFileMessages 的行为就 +1，启动时会按新规则修正已入库的正文 */
const INGEST_VERSION = '2';
const VERSION_KEY = 'ingest_version';

/**
 * 解析规则变了之后，按新规则重新解析备份文件，**就地**修正已入库行的正文。
 *
 * 不能删表重导：`chat_line.id` 会重新编号，而 `topic.line_from/line_to` 指着这些 id，
 * 重编一次所有话题就都指错地方了
 */
function repairParsedText(db: MemoryDatabase, files: { file: string, groupId: number, dateKey: number }[]) {
  if (getMeta(db, VERSION_KEY) === INGEST_VERSION) return;

  const select = db.prepare('SELECT id, text FROM chat_line WHERE group_id = ? AND date_key = ? AND seq = ?');
  const update = db.prepare('UPDATE chat_line SET text = ? WHERE id = ?');
  const reindex = db.prepare('UPDATE chat_fts SET seg = ? WHERE rowid = ?');

  let fixed = 0;
  db.transaction(() => {
    files.forEach(({ file, groupId, dateKey }) => {
      parseFileMessages(readBackupLines(file)).forEach(({ seq, parsed }) => {
        const row = select.get(groupId, dateKey, seq) as { id: number, text: string } | undefined;
        if (row && row.text !== parsed.text) {
          update.run(parsed.text, row.id);
          reindex.run(segment(parsed.body), row.id);
          fixed += 1;
        }
      });
    });
    setMeta(db, VERSION_KEY, INGEST_VERSION);
  })();

  if (fixed > 0) printLog(`[Ingest] 解析规则已更新，就地修正 ${fixed} 行正文并重建其索引`);
}

export interface IngestStats {
  /** 有新增行的文件数 */
  files: number;
  lines: number;
}

/** 导一个备份文件的新增部分，返回真正写进去的行数 */
function ingestFile(
  db: MemoryDatabase,
  insertLine: Statement,
  insertFts: Statement,
  file: string,
  groupId: number,
  dateKey: number,
): number {
  const metaKey = `ingest:${groupId}:${dateKey}`;
  const done = Number(getMeta(db, metaKey) ?? -1);

  const lines = readBackupLines(file);
  if (lines.length - 1 <= done) return 0;

  // 整个文件都要解析：一条消息的后续行要接回首行，只从水位往后切会丢掉上下文
  const messages = parseFileMessages(lines);

  // 两表的 rowid 靠手工对齐，必须同一个事务，否则中途失败会飘
  return db.transaction(() => {
    let written = 0;
    for (const { seq, parsed } of messages) {
      if (seq > done) {
        const info = insertLine.run(groupId, parsed.userId, dateKey, seq, parsed.nick, parsed.text);
        // UNIQUE 撞了说明这行早入过库，此时 lastInsertRowid 是上一条的，不能拿去写 FTS
        if (info.changes === 1) {
          insertFts.run(info.lastInsertRowid, segment(parsed.body));
          written++;
        }
      }
    }
    setMeta(db, metaKey, String(lines.length - 1));
    return written;
  })();
}

/**
 * 扫备份目录做增量导入。可重复调用，已入库的行不会重复写。
 * groupIds 只给测试和单群回填用，正常全量不传
 */
export function ingestChatBackups(
  db: MemoryDatabase = getMemoryDb(),
  groupIds?: number[],
): IngestStats {
  const stats: IngestStats = { files: 0, lines: 0 };
  rebuildFtsIfDictChanged(db);

  let entries: string[];
  try {
    entries = fs.readdirSync(CHAT_BACKUP_DIR);
  } catch {
    // 一条群消息都还没备份过，目录不存在属正常情况
    return stats;
  }

  const only = groupIds?.length ? new Set(groupIds) : null;
  const since = historySince();

  // 按文件名排序即按群、按日期，同群的 chat_line.id 大致随时间递增
  const files = entries.sort().flatMap((file) => {
    const m = FILE_RE.exec(file);
    if (!m) return [];
    const groupId = Number(m[1]);
    if (only && !only.has(groupId)) return [];
    if (Number(m[2]) < since) return [];
    return [{ file, groupId, dateKey: Number(m[2]) }];
  });

  repairParsedText(db, files);

  const insertLine = db.prepare(
    'INSERT OR IGNORE INTO chat_line (group_id, user_id, date_key, seq, nick, text) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertFts = db.prepare('INSERT INTO chat_fts (rowid, seg) VALUES (?, ?)');

  files.forEach(({ file, groupId, dateKey }) => {
    try {
      const n = ingestFile(db, insertLine, insertFts, file, groupId, dateKey);
      if (n > 0) {
        stats.files += 1;
        stats.lines += n;
      }
    } catch (e) {
      // 单个文件坏掉不该拖垮整个导入，水位没推进，下次还会重试
      printError(`[Ingest] 导入 ${file} 失败: ${e}`);
    }
  });

  return stats;
}

/** 启动时的全量导入，同步跑完再进主流程。失败不致命，检索空转而已 */
export function ingestOnStartup() {
  try {
    const t = Date.now();
    maintainMemory();
    const { files, lines } = ingestChatBackups();
    if (lines > 0) {
      printLog(`[Ingest] 已导入 ${files} 个备份文件 / ${lines} 行，耗时 ${Date.now() - t}ms`);
    }
  } catch (e) {
    printError(`[Ingest] 全量导入失败: ${e}`);
  }
}
