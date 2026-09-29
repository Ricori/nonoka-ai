import { backupDateKey } from '../storage/message';
import { getMeta, setMeta, type MemoryDatabase } from './db';
import { stripSpeakerPrefix } from './segment';

/**
 * 语义召回的载体：把一天的日志按固定行数切成重叠窗口，直接拿原文向量化。
 * 零模型调用、只花 embedding，命中即原文。实测召回与 LLM 话题摘要持平
 */

/** 一个窗口多少行。备份没有时间戳，没法按冷场断开，只能定长 */
export const WINDOW_SIZE = 12;

/** 相邻窗口错开多少行，留 4 行重叠，免得一段对话恰好被切在边界上两边都不像 */
export const WINDOW_STRIDE = 8;

/** 单行进向量的长度上限。转发的长公告会把整个窗口的语义拖过去 */
const MAX_LINE_CHARS = 100;

export const windowWatermarkKey = (groupId: number) => `window:${groupId}`;

export interface ChatLine {
  id: number;
  userId: number;
  nick: string | null;
  /** 已剥掉 `[昵称]说：` 前缀的正文 */
  body: string;
}

export function readDayLines(db: MemoryDatabase, groupId: number, dateKey: number): ChatLine[] {
  const rows = db.prepare(
    'SELECT id, user_id AS userId, nick, text FROM chat_line WHERE group_id = ? AND date_key = ? ORDER BY id',
  ).all(groupId, dateKey) as { id: number, userId: number, nick: string | null, text: string }[];
  return rows.map((r) => ({
    id: r.id, userId: r.userId, nick: r.nick, body: r.userId === 0 ? r.text : stripSpeakerPrefix(r.text),
  }));
}

/** 只过滤确定的无内容表达，短事实（如“我养猫”）、否定和不同人的相同回答仍保留。 */
export function prepareLines(lines: ChatLine[]): ChatLine[] {
  const seen = new Map<string, number>();
  return lines.filter((line, index) => {
    const body = line.body.replace(/\[(?:表情|图片|视频|语音|聊天记录|卡片消息|之前的图片)\]/g, '')
      .replace(/[\s\p{P}\p{S}]/gu, '');
    if (body.length <= 2 || /^(?:哈+|呵+|嘿+|嘻+|嗯+|哦+|啊+|233+|666+|笑死我了|哈哈笑死|确实|确实如此|好家伙|原来如此)$/u.test(body)) return false;
    // 不删中间标点，避免把“不能”与“不能？”当成同一句。
    const key = `${line.userId}:${line.body.trim().replace(/\s+/g, ' ')}`;
    const previous = seen.get(key);
    seen.set(key, index);
    return previous === undefined || index - previous > 20;
  });
}

interface WindowSpan {
  lineFrom: number;
  lineTo: number;
  text: string;
}

/**
 * 按 prepareLines 过滤后切窗。过滤只往回看，同一天追加行不会改变已有窗口的切法，
 * 所以当天可以只切满员的窗口，等这天结束再补尾巴
 */
export function planWindows(lines: ChatLine[], final: boolean): WindowSpan[] {
  const prepared = prepareLines(lines);
  const spans: WindowSpan[] = [];
  for (let i = 0; i < prepared.length; i += WINDOW_STRIDE) {
    const slice = prepared.slice(i, i + WINDOW_SIZE);
    if (slice.length < WINDOW_SIZE && !final) break;
    // bot 独白不单独成窗；和人类发言混在一起时照样作上下文
    if (slice.some((line) => line.userId !== 0)) {
      spans.push({
        lineFrom: slice[0].id,
        lineTo: slice[slice.length - 1].id,
        text: slice.map((line) => line.body.slice(0, MAX_LINE_CHARS)).join('\n'),
      });
    }
    // 尾巴已经被这个窗口整个盖住，再往后切只会得到它的子集
    if (i + WINDOW_SIZE >= prepared.length) break;
  }
  return spans;
}

/** 切一天的窗口并入库，返回新写入的（已有的靠 UNIQUE 跳过） */
export function buildDayWindows(
  db: MemoryDatabase,
  groupId: number,
  dateKey: number,
  final: boolean,
): { id: number, text: string }[] {
  const spans = planWindows(readDayLines(db, groupId, dateKey), final);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO chat_window (group_id, date_key, line_from, line_to, text) VALUES (?, ?, ?, ?, ?)',
  );
  return db.transaction(() => spans.flatMap((span) => {
    const info = insert.run(groupId, dateKey, span.lineFrom, span.lineTo, span.text);
    return info.changes === 1 ? [{ id: Number(info.lastInsertRowid), text: span.text }] : [];
  }))();
}

/**
 * 把水位之后的每一天切完，今天只切满员窗口。
 * 过去的日子切完就推水位，不再重读；今天每轮都会重扫一遍，行数有限不值得另记断点
 */
export function buildWindows(
  db: MemoryDatabase,
  groupId: number,
  since: number,
  now = Date.now(),
): { id: number, text: string }[] {
  const today = Number(backupDateKey(new Date(now)));
  const done = Number(getMeta(db, windowWatermarkKey(groupId)) ?? 0);
  const days = db.prepare(
    'SELECT DISTINCT date_key AS day FROM chat_line WHERE group_id = ? AND date_key > ? AND date_key >= ? ORDER BY date_key',
  ).all(groupId, done, since) as { day: number }[];

  return days.flatMap(({ day }) => {
    const final = day < today;
    const created = buildDayWindows(db, groupId, day, final);
    if (final) setMeta(db, windowWatermarkKey(groupId), String(day));
    return created;
  });
}
