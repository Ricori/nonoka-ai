import fs from 'fs';
import os from 'os';
import path from 'path';
import { createMemoryDb, delMeta, getMeta, setMeta, MemoryDatabase } from '@/modules/aiReply/memory/db';
import {
  dictSignature, queryTerms, segment, splitSpeakerPrefix, stripSpeakerPrefix,
} from '@/modules/aiReply/memory/segment';
import { ingestChatBackups, parseBackupLine } from '@/modules/aiReply/memory/ingest';
import { informativeLength } from '@/modules/aiReply/memory/extract';
import {
  blobToVec, deleteEmbeddings, getVectorDim, normalize, saveEmbedding, saveEmbeddings, searchSimilar, vecToBlob,
} from '@/modules/aiReply/memory/vector';
import {
  buildTermQueries, recallChat, recallMemory, rrfFuse,
} from '@/modules/aiReply/memory/retrieve';
import {
  consolidateMemoryTracked, getConsolidationBacklog, listConsolidationRuns,
} from '@/modules/aiReply/memory/consolidate';
import memoryStore from '@/modules/aiReply/memory/store';
import { CHAT_BACKUP_DIR, backupDateKey } from '@/modules/aiReply/storage/message';

/** 临时库跑完就删，不碰 data/memory 下的真实库 */
const TEST_DB = path.join(os.tmpdir(), `nonoka_test_${process.pid}.db`);

/** 用一个绝不会撞上真实群的号来造样本，跑完就删 */
const FAKE_GROUP = 88888888;
const DAY_MS = 24 * 60 * 60 * 1000;

let failed = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}\n      期望 ${e}\n      实际 ${a}`);
  }
}

/** 断言抛出也要关连接，否则 Windows 上临时库删不掉 */
function withDb(fn: (db: MemoryDatabase) => void) {
  const db = createMemoryDb(TEST_DB);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

async function withDbAsync(fn: (db: MemoryDatabase) => Promise<void>) {
  const db = createMemoryDb(TEST_DB);
  try {
    await fn(db);
  } finally {
    db.close();
  }
}

const EXPECTED_TABLES = [
  'chat_fts', 'chat_line', 'consolidation_run', 'embedding', 'group_user_profile',
  'memory', 'memory_evidence', 'memory_evidence_batch', 'memory_fts', 'meta', 'topic',
];

/** 基线版本 + 增量迁移条数，加一条迁移就要同步改这里 */
const SCHEMA_VERSION = '8';

function testSchema() {
  console.log('\n[schema]');
  withDb((db) => {
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as { name: string }[]).map((r) => r.name);
    check('建表齐全', EXPECTED_TABLES.filter((t) => tables.includes(t)), EXPECTED_TABLES);

    check('WAL 已开启', String(db.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal');
    check('schema_version 已落库', getMeta(db, 'schema_version'), SCHEMA_VERSION);

    const cols = (db.prepare('PRAGMA table_info(memory)').all() as { name: string }[]).map((c) => c.name);
    check('memory 列完整', cols, [
      'id', 'scope', 'owner_id', 'group_id', 'kind', 'text', 'first_seen',
      'last_seen', 'hits', 'confidence', 'pinned', 'superseded_by', 'source', 'updated_at', 'verified',
    ]);

    setMeta(db, 'probe', 'a');
    setMeta(db, 'probe', 'b');
    check('meta 写入是覆盖不是插重', getMeta(db, 'probe'), 'b');
    check('meta 读不存在的键给 null', getMeta(db, 'nope'), null);
    check('新库还没有巩固运行记录', listConsolidationRuns(db).length, 0);
  });
}

function testIdempotent() {
  console.log('\n[重复打开]');
  withDb((db) => {
    check('已是最新版就不重跑迁移', getMeta(db, 'schema_version'), SCHEMA_VERSION);
    check('老数据还在', getMeta(db, 'probe'), 'b');
  });
}

function testFts() {
  console.log('\n[FTS5]');
  withDb((db) => {
    const insert = db.prepare('INSERT INTO chat_fts(rowid, seg) VALUES (?, ?)');
    insert.run(1, '今天 中午 吃 一兰 拉面');
    insert.run(2, '今天中午吃一兰拉面'); // 没分词的对照组

    const hits = db.prepare('SELECT rowid FROM chat_fts WHERE chat_fts MATCH ? ORDER BY rowid').all('"拉面"') as { rowid: number }[];
    check('分词后能被中文词命中，没分词的整段是一个 token 命不中', hits.map((h) => h.rowid), [1]);

    const scored = db.prepare('SELECT bm25(chat_fts) AS s FROM chat_fts WHERE chat_fts MATCH ?').get('"拉面"') as { s: number };
    check('bm25() 返回负值，排序要取相反数', scored.s < 0, true);

    // 普通表用 DELETE 即可，特殊的 'delete' 命令只对 contentless / external content 表有效
    db.prepare('DELETE FROM chat_fts WHERE rowid = ?').run(1);
    const after = db.prepare('SELECT count(*) AS n FROM chat_fts WHERE chat_fts MATCH ?').get('"拉面"') as { n: number };
    check('删除能摘掉索引行', after.n, 0);

    // 这里手填的 rowid 会和后面导入测试的 chat_line.id 撞上，清干净再走
    db.exec('DELETE FROM chat_fts');
  });
}

function testSegment() {
  console.log('\n[分词]');
  check('剥掉说话人前缀', stripSpeakerPrefix('[雨漫]说：我周末要去爬山'), '我周末要去爬山');
  check('剥掉被截断的引文前缀', stripSpeakerPrefix('[雨漫]回复了我的消息(上次那个'), '回复了我的消息(上次那个');

  check('中文按词切开', segment('我周末要去爬山'), '我 周末 要 去 爬山');
  check('标点和空白不进索引', segment('在跑 Docker，和 K8S！'), '在 跑 Docker 和 K8S');

  console.log('\n[自定义词典]');
  check('默认词典缺的词补上后不再被切成单字', [segment('手办'), segment('小雏')], ['手办', '小雏']);
  check('补进去的词能进检索词，不再被最小长度滤掉', queryTerms('上次说的那个手办'), ['手办', '上次']);
  check('还没补的词照样被切开', segment('天妇罗'), '天 妇 罗');
  check('指纹稳定', dictSignature(), dictSignature());

  console.log('\n[检索词]');
  check('虚词全滤掉', queryTerms('[某人]说：是不是啊'), []);
  check('占位符没有检索价值', queryTerms('[雨漫]回复了我的消息([之前的图片])，说：[图片]'), []);
  check('bot 自己的名字不算检索词', queryTerms('[雨漫]提到我说：乃乃香你吃拉面吗'), ['拉面']);
  check('英文保留、两字母词滤掉', queryTerms('[某人]说：在跑 Docker 和 K8S'), ['Docker', 'K8S']);
  check(
    '按稀有度排序而不是长度：更短的「手办」排在更长的「秋叶原」前面',
    queryTerms('[某人]说：明天去秋叶原买手办然后吃拉面看电影', 3),
    ['手办', '秋叶原', '拉面'],
  );
}

function fixtureFile(daysAgo: number) {
  const key = backupDateKey(new Date(Date.now() - daysAgo * DAY_MS));
  return path.join(CHAT_BACKUP_DIR, `${FAKE_GROUP}_${key}.txt`);
}

/** 20 天前那条是「拉面」的强命中，用来验证相关性能压过时间近度 */
const DAY_20 = '[111][雨漫]说：一兰拉面真的好吃\n[333][路人]说：天妇罗也不错\n';
const DAY_3 = '[111][雨漫]说：我周末要去爬山\n[0][主动 0.12]爬山啊，注意别摔了\n[222][hina]说：爬山好累\n';
/** 第二条是「正文自带换行」的长消息：只有首行带 [userId][昵称] 前缀，后两行得接回去 */
const DAY_1 = '[111][雨漫]说：昨天在秋叶原买了手办\n'
  + '[222][hina]说：这家店好吃\n公告：周末有活动\n报名链接在群公告\n';
/** 追加验证增量导入：同一个文件后来又长出两行 */
const DAY_1_MORE = '[222][hina]说：我也想去秋叶原\n[0][被动][旧账 2][点名 1]秋叶原确实好逛\n';

function testParse() {
  console.log('\n[行解析]');
  check('群友行留前缀、单独取昵称', parseBackupLine('[111][雨漫]说：我周末要去爬山'), {
    userId: 111, nick: '雨漫', text: '[雨漫]说：我周末要去爬山', body: '我周末要去爬山',
  });
  check('bot 行剥掉触发标记', parseBackupLine('[0][被动][工具 2][点名 1]秋叶原确实好逛'), {
    userId: 0, nick: null, text: '秋叶原确实好逛', body: '秋叶原确实好逛',
  });
  // 关键词预注入时代写下的日志里是 [旧账 N]，解析侧要一直认它
  check('老日志里的旧账标记照样剥掉', parseBackupLine('[0][被动][旧账 2]秋叶原确实好逛')?.text, '秋叶原确实好逛');
  check('空行和杂行跳过', [parseBackupLine(''), parseBackupLine('随便一行')], [null, null]);
  // CRLF 文件按 \n 切完尾部留着 \r，正则里的 `.` 不匹配它，不剥掉整行会被静默丢掉
  check('CRLF 行照样解析', parseBackupLine('[111][雨漫]说：我周末要去爬山\r')?.body, '我周末要去爬山');
}

function testIngest() {
  console.log('\n[导入]');
  fs.writeFileSync(fixtureFile(20), DAY_20, 'utf-8');
  fs.writeFileSync(fixtureFile(3), DAY_3, 'utf-8');
  fs.writeFileSync(fixtureFile(1), DAY_1, 'utf-8');

  withDb((db) => {
    const first = ingestChatBackups(db, [FAKE_GROUP]);
    // 备份共 9 行，其中 2 行是上一条消息正文的换行续行，并进去后是 7 条消息
    check('三个文件共 7 条消息', [first.files, first.lines], [3, 7]);

    const count = () => (db.prepare('SELECT count(*) AS n FROM chat_line WHERE group_id = ?').get(FAKE_GROUP) as { n: number }).n;
    check('chat_line 条数与消息数一致', count(), 7);
    check('chat_fts 同步写入', (db.prepare('SELECT count(*) AS n FROM chat_fts').get() as { n: number }).n, 7);

    const merged = db.prepare(
      "SELECT text FROM chat_line WHERE group_id = ? AND text LIKE '%这家店好吃%'",
    ).get(FAKE_GROUP) as { text: string };
    check('正文里的换行续行接回上一条', merged.text, '[hina]说：这家店好吃 公告：周末有活动 报名链接在群公告');
    check(
      '续行的内容能被检索到（以前整段搜不着）',
      (db.prepare('SELECT count(*) AS n FROM chat_fts WHERE chat_fts MATCH ?').get(`"${segment('报名')}"`) as { n: number }).n,
      1,
    );

    const again = ingestChatBackups(db, [FAKE_GROUP]);
    check('重复跑不写重', [again.lines, count()], [0, 7]);

    fs.appendFileSync(fixtureFile(1), DAY_1_MORE, 'utf-8');
    const inc = ingestChatBackups(db, [FAKE_GROUP]);
    check('增量只处理新增行', [inc.files, inc.lines, count()], [1, 2, 9]);

    const row = db.prepare('SELECT user_id, nick, text FROM chat_line WHERE group_id = ? AND user_id = 0 ORDER BY id').get(FAKE_GROUP) as any;
    check('bot 行入库时标记已剥掉', [row.user_id, row.nick, row.text], [0, null, '爬山啊，注意别摔了']);

    const hits = db.prepare(
      'SELECT c.user_id FROM chat_fts f JOIN chat_line c ON c.id = f.rowid WHERE f.chat_fts MATCH ? AND c.group_id = ? ORDER BY c.id',
    ).all('"秋叶原"', FAKE_GROUP) as { user_id: number }[];
    check('中文词能召回，rowid 与 chat_line 对齐', hits.map((h) => h.user_id), [111, 222, 0]);

    const nick = db.prepare(
      'SELECT count(*) AS n FROM chat_fts f JOIN chat_line c ON c.id = f.rowid WHERE f.chat_fts MATCH ? AND c.group_id = ?',
    ).get('"雨漫"', FAKE_GROUP) as { n: number };
    check('说话人昵称不进索引，否则每条都命中自己', nick.n, 0);

    // 「天妇罗」不在词典里，索引侧被切成「天 妇 罗」；
    // 查询串不过一遍同样的分词就命不中，建 MATCH 语句时必须走 segment()
    const match = db.prepare('SELECT count(*) AS n FROM chat_fts WHERE chat_fts MATCH ?');
    check('查询串不分词就召不回词典外的词', (match.get('"天妇罗"') as { n: number }).n, 0);
    check('查询串同样分词后能召回', (match.get(`"${segment('天妇罗')}"`) as { n: number }).n, 1);

    // 词典一改，同一句话的切法就变了，旧索引必须整表重建，否则查询侧永远对不上
    db.prepare('DELETE FROM chat_fts WHERE rowid <= 3').run();
    setMeta(db, 'segment_dict', '被改脏了');
    ingestChatBackups(db, [FAKE_GROUP]);
    check('词典指纹变了会重建全文索引', (db.prepare('SELECT count(*) AS n FROM chat_fts').get() as { n: number }).n, 9);

    const backlog = getConsolidationBacklog([FAKE_GROUP], db);
    check('积压统计包含待处理天数、段数、行数和最老日期', backlog, {
      days: 3,
      chunks: 3,
      lines: 9,
      oldestDate: Number(backupDateKey(new Date(Date.now() - 20 * DAY_MS))),
    });
  });
}

async function testConsolidationTracking() {
  console.log('\n[巩固状态]');
  await withDbAsync(async (db) => {
    const fakeStats = {
      ingestedLines: 2, days: 1, topics: 4, embedded: 4, evicted: 1, skipped: 0,
    };
    await consolidateMemoryTracked([FAKE_GROUP], db, async () => fakeStats);
    const success = listConsolidationRuns(db, 1)[0];
    check('成功运行持久化状态、积压和产出', [
      success.status, success.pendingDaysBefore, success.pendingDaysAfter,
      success.processedDays, success.topics, success.embedded, success.evicted,
    ], ['success', 3, 3, 1, 4, 4, 1]);

    try {
      await consolidateMemoryTracked([FAKE_GROUP], db, async () => { throw new Error('probe failure'); });
    } catch {
      // Expected: the wrapper must persist failure and rethrow it to the scheduler.
    }
    const failedRun = listConsolidationRuns(db, 1)[0];
    check('失败运行保留错误和结束时间', [
      failedRun.status, failedRun.finishedAt !== null, failedRun.error,
    ], ['failed', true, 'Error: probe failure']);
  });
}

function testVector() {
  console.log('\n[向量]');
  withDb((db) => {
    for (const id of [1, 2, 3]) {
      db.prepare("INSERT INTO topic (id,group_id,date_key,summary,user_ids,line_from,line_to) VALUES (?,1,?,'测试','[]',1,1)")
        .run(id, Number(backupDateKey()));
    }
    const round = (v: Float32Array) => [...v].map((x) => Number(x.toFixed(4)));
    check('归一化成单位向量', round(normalize([3, 4, 0])), [0.6, 0.8, 0]);
    check('零向量不炸', round(normalize([0, 0, 0])), [0, 0, 0]);
    check('BLOB 往返不丢精度', round(blobToVec(vecToBlob(normalize([1, 2, 3])))), round(normalize([1, 2, 3])));

    saveEmbeddings(db, 'topic', [
      { refId: 1, vec: [1, 0, 0] },
      { refId: 2, vec: [0.9, 0.44, 0] },
      { refId: 3, vec: [0, 1, 0] },
    ]);
    check('维度写进 meta', getVectorDim(db), 3);

    const hits = searchSimilar(db, 'topic', [1, 0, 0], 3);
    check('按余弦降序', hits.map((h) => h.refId), [1, 2, 3]);
    check('同向的相似度为 1', Number(hits[0].score.toFixed(4)), 1);

    check('allowIds 能收窄范围', searchSimilar(db, 'topic', [1, 0, 0], 3, new Set([3])).map((h) => h.refId), [3]);
    check('维度对不上直接拒绝', saveEmbeddings(db, 'topic', [{ refId: 9, vec: [1, 0] }]), 0);

    saveEmbedding(db, 'topic', 1, [0, 0, 1]);
    check('覆盖写立刻生效（缓存已失效）', searchSimilar(db, 'topic', [1, 0, 0], 1).map((h) => h.refId), [2]);
    deleteEmbeddings(db, 'topic', [1, 2, 3]);
    check('删干净', searchSimilar(db, 'topic', [1, 0, 0], 5).length, 0);
    db.exec('DELETE FROM topic');
  });
}

function testRrf() {
  console.log('\n[RRF 融合]');
  const scores = rrfFuse([{ ids: [1, 2, 3] }, { ids: [3, 4] }]);
  check('两路都召回的排最前', [...scores.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]), [3, 1, 2, 4]);
  check('名次相同则得分相同', scores.get(2), scores.get(4));

  const weighted = rrfFuse([{ ids: [1], weight: 0.6 }, { ids: [2], weight: 0.4 }]);
  check('权重高的那一路的第一名压过权重低的第一名', weighted.get(1)! > weighted.get(2)!, true);
}

/** 造一条记忆并同步写 memory_fts */
function addMemory(db: MemoryDatabase, m: {
  ownerId: number, text: string, groupId?: number | null, kind?: string, superseded?: number,
}): number {
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO memory (scope, owner_id, group_id, kind, text, first_seen, last_seen, confidence, superseded_by, updated_at)
    VALUES ('user', ?, ?, ?, ?, ?, ?, 0.6, ?, ?)
  `).run(m.ownerId, m.groupId ?? FAKE_GROUP, m.kind ?? 'trait', m.text, now, now, m.superseded ?? null, now);

  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO memory_fts (rowid, seg) VALUES (?, ?)').run(id, segment(m.text));
  return id;
}

async function testRecall() {
  console.log('\n[检索词拆成多路]');
  const ramen = buildTermQueries('拉面好吃吗');
  check('一个检索词一路', ramen.map((q) => q.match), ['"拉面"', '"好吃"']);
  check('稀有的那个权重更高', ramen[0].weight > ramen[1].weight, true);
  check('权重加起来是 1', Number(ramen.reduce((s, q) => s + q.weight, 0).toFixed(6)), 1);
  check('词典外的词退回整句词组', buildTermQueries('天妇罗'), [{ match: '"天 妇 罗"', weight: 1 }]);
  check('引号转义，不会拼出坏语法', buildTermQueries('他说"拉面"好吃').map((q) => q.match), ['"拉面"', '"好吃"']);

  await withDbAsync(async (db) => {
    console.log('\n[聊天召回]');
    const texts = (hits: { text: string }[]) => hits.map((h) => h.text);

    const byRelevance = await recallChat(FAKE_GROUP, { query: '拉面好吃吗', days: 30, semantic: false }, db);
    check(
      '20 天前的强命中排在昨天弱命中的前面（旧实现里正好相反）',
      texts(byRelevance),
      ['[雨漫]说：一兰拉面真的好吃', '[hina]说：这家店好吃 公告：周末有活动 报名链接在群公告'],
    );

    const windowed = await recallChat(FAKE_GROUP, { query: '拉面好吃吗', days: 14, semantic: false }, db);
    check('窗口外的召不回来', texts(windowed), ['[hina]说：这家店好吃 公告：周末有活动 报名链接在群公告']);

    const akiba = await recallChat(FAKE_GROUP, { query: '秋叶原', days: 30, semantic: false }, db);
    check('bot 自己的发言不算旧账', akiba.map((h) => h.userId).includes(0), false);
    check('同一话题里多个人的发言都能召回', akiba.map((h) => h.userId).sort(), [111, 222]);

    const plain = await recallChat(FAKE_GROUP, { query: '爬山累不累', days: 30, semantic: false }, db);
    const boosted = await recallChat(FAKE_GROUP, {
      query: '爬山累不累', speakerIds: [222], days: 30, semantic: false,
    }, db);
    check('不指定说话人时两个人都在', plain.map((h) => h.userId).sort(), [111, 222]);
    check('指定说话人后他排到最前', boosted[0].userId, 222);
    check('指定说话人后只返回这个人的命中', boosted.map((h) => h.userId).sort(), [222]);

    console.log('\n[语义召回]');
    // 3 天前那段爬山对话（含 bot 那行）切成一个话题，给它一个向量
    const lines = db.prepare(
      "SELECT min(id) AS a, max(id) AS b FROM chat_line WHERE group_id = ? AND text LIKE '%爬山%'",
    ).get(FAKE_GROUP) as { a: number, b: number };
    db.prepare(
      "INSERT INTO topic (id, group_id, date_key, summary, user_ids, line_from, line_to) VALUES (1, ?, ?, '周末爬山', '[111,222]', ?, ?)",
    ).run(FAKE_GROUP, Number(backupDateKey(new Date(Date.now() - 3 * DAY_MS))), lines.a, lines.b);
    saveEmbeddings(db, 'topic', [{ refId: 1, vec: [1, 0, 0] }]);

    const literalOnly = await recallChat(FAKE_GROUP, { query: '登山运动', days: 30, semantic: false }, db);
    check('字面检索对同义词无能为力', literalOnly.length, 0);

    const semantic = await recallChat(FAKE_GROUP, {
      query: '登山运动', queryVec: Float32Array.from([1, 0, 0]), days: 30,
    }, db);
    check('话题向量命中后展开成原文，一个字都没重合也召回了', texts(semantic), [
      '[雨漫]说：我周末要去爬山', '[hina]说：爬山好累',
    ]);
    check('展开时同样排除 bot 的发言', semantic.map((h) => h.userId).includes(0), false);

    // 余弦只排序不判断有无：没有下限的话，全库最不相关的那条也会以 rank 1 进融合
    const unrelated = await recallChat(FAKE_GROUP, {
      query: '登山运动', queryVec: Float32Array.from([0.2, 0.98, 0]), days: 30,
    }, db);
    check('相似度低于下限就不算召回', unrelated.length, 0);

    // 话题展开会把整段对话都带出来，其中只发了表情/图片的行不该占注入名额
    db.prepare("INSERT INTO chat_line (group_id, user_id, date_key, seq, nick, text) VALUES (?, 222, 20260101, 99, 'hina', '[hina]说：[表情]')").run(FAKE_GROUP);
    const noise = db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number };
    db.prepare('INSERT INTO chat_fts (rowid, seg) VALUES (?, ?)').run(noise.id, segment('爬山'));
    const filtered = await recallChat(FAKE_GROUP, { query: '爬山累不累', days: 3650, semantic: false }, db);
    check('只发了表情的行不进结果', filtered.map((h) => h.id).includes(noise.id), false);

    console.log('\n[记忆召回]');
    const alive = addMemory(db, { ownerId: 111, text: '在读研究生，专业是计算机' });
    addMemory(db, { ownerId: 111, text: '以前说过喜欢吃拉面', superseded: -1 });
    addMemory(db, { ownerId: 222, text: '也在读研究生' });
    addMemory(db, { ownerId: 333, text: '别的群的研究生', groupId: 99999999 });

    const all = await recallMemory(FAKE_GROUP, { query: '研究生', semantic: false }, db);
    check('软删的条目不可见', all.map((h) => h.id).includes(alive + 1), false);
    check('用户档案跨群共享', all.map((h) => h.ownerId).sort(), [111, 222, 333]);

    const crossGroup = await recallMemory(FAKE_GROUP, {
      query: '研究生', aboutUserIds: [333], semantic: false,
    }, db);
    check('指定用户时也能召回其来源于别群的档案', texts(crossGroup), ['别的群的研究生']);

    const about = await recallMemory(FAKE_GROUP, { query: '研究生', aboutUserIds: [111], semantic: false }, db);
    check('问某个人就只翻他的档案（硬过滤）', about.map((h) => h.ownerId), [111]);
    check('翻出来的是没被软删的那条', texts(about), ['在读研究生，专业是计算机']);

    // 问「他是个什么样的人」时检索词是抽象的，跟具体事实对不上，但不该空手而归
    const broad = await recallMemory(FAKE_GROUP, { query: '是个什么样的人', aboutUserIds: [111], semantic: false }, db);
    check('指名道姓要档案时检索落空就兜底给档案', texts(broad), ['在读研究生，专业是计算机']);
    check('兜底同样不给软删的条目', broad.some((h) => h.text === '以前说过喜欢吃拉面'), false);

    const noOne = await recallMemory(FAKE_GROUP, { query: '是个什么样的人', semantic: false }, db);
    check('没指定人就不兜底，避免灌一堆无关档案', noOne.length, 0);
  });
}

/** (群, 日期, seq) 上有唯一约束，全局递增避免几次造数据撞车 */
let fakeSeq = 1000;

/** 造一段聊天并建好全文索引，返回这些行的 id */
function addLines(db: MemoryDatabase, groupId: number, dateKey: number, bodies: string[]): number[] {
  const insert = db.prepare(
    "INSERT INTO chat_line (group_id, user_id, date_key, seq, nick, text) VALUES (?, 777, ?, ?, 'qa', ?)",
  );
  const fts = db.prepare('INSERT INTO chat_fts (rowid, seg) VALUES (?, ?)');
  return bodies.map((body) => {
    fakeSeq += 1;
    const id = Number(insert.run(groupId, dateKey, fakeSeq, `[qa]说：${body}`).lastInsertRowid);
    fts.run(id, segment(body));
    return id;
  });
}

/** 造一个话题并给它一个向量 */
function addTopic(db: MemoryDatabase, groupId: number, dateKey: number, ids: number[], vec: number[]) {
  const info = db.prepare(
    "INSERT INTO topic (group_id, date_key, summary, user_ids, line_from, line_to) VALUES (?, ?, '造的话题', '[777]', ?, ?)",
  ).run(groupId, dateKey, ids[0], ids[ids.length - 1]);
  const id = Number(info.lastInsertRowid);
  saveEmbeddings(db, 'topic', [{ refId: id, vec }]);
  return id;
}

/**
 * 召回质量的回归测试。上面那些断言只管「召回得到吗」，这里管「召回的是不是那几条」——
 * 线上翻车的样子是能召回、但召回的全是同一段对话里的边角料
 */
async function testRecallQuality() {
  console.log('\n[召回质量]');
  // 检索有时间窗，日期得落在窗口里，不能写死一个过去的日子
  const DAY = Number(backupDateKey(new Date(Date.now() - 2 * DAY_MS)));

  await withDbAsync(async (db) => {
    const texts = (hits: { text: string }[]) => hits.map((h) => h.text.replace('[qa]说：', ''));
    // 和已有的爬山话题（[1,0,0]）正交，互不干扰
    const vec = Float32Array.from([0, 0, 1]);

    // 一个跨 12 行的话题，猫在末尾：取开头几行的老实现会全部捞回闲聊
    const long = addLines(db, FAKE_GROUP, DAY, [
      '今天好热啊', '是啊出不了门', '空调开到十八度', '电费要爆了', '中午吃的什么',
      '随便对付了一下', '下午还要开会', '又是加班的一天', '刚睡醒',
      '我家猫昨天生病了', '带猫去医院花了两千', '猫现在好多了',
    ]);
    addTopic(db, FAKE_GROUP, DAY, long, [0, 0, 1]);

    const picked = await recallChat(FAKE_GROUP, { query: '有人养猫吗', queryVec: vec, days: 30 }, db);
    check('话题里挑与查询相关的行，不是取开头', texts(picked).every((t) => t.includes('猫')), true);
    check('跨度大的话题也只给最相关的几行', picked.length, 3);

    // 两个话题都相关时，名额不该被第一个话题吃光
    const second = addLines(db, FAKE_GROUP, DAY, ['邻居也在养猫', '猫粮涨价了', '想再养一只猫']);
    addTopic(db, FAKE_GROUP, DAY, second, [0, 0.1, 0.99]);

    const spread = await recallChat(FAKE_GROUP, { query: '有人养猫吗', queryVec: vec, days: 30 }, db);
    check('第二个相关话题也能挤进结果', spread.some((h) => second.includes(h.id)), true);
    check('单个话题最多贡献 3 行', spread.filter((h) => long.includes(h.id)).length, 3);

    // 复读和附和换一个方向，免得被上面那些话题挤出名额——那样测的就不是过滤了
    const aside = Float32Array.from([0, 1, 0]);
    const dup = addLines(db, FAKE_GROUP, DAY, ['一起去看猫吧', '一起去看猫吧', '一起去看猫吧']);
    addTopic(db, FAKE_GROUP, DAY, dup, [0, 1, 0]);
    const short = addLines(db, FAKE_GROUP, DAY, ['不赖', '猫很可爱呀']);
    addTopic(db, FAKE_GROUP, DAY, short, [0, 0.99, 0.1]);

    const filtered = await recallChat(FAKE_GROUP, { query: '有人养猫吗', queryVec: aside, days: 30 }, db);
    check('复读只留一条', filtered.filter((h) => h.text.includes('一起去看猫吧')).length, 1);
    check('两个字的附和不占名额', filtered.some((h) => h.text.includes('不赖')), false);
    check('同一话题里有内容的那条留下', filtered.some((h) => h.text.includes('猫很可爱呀')), true);

    // 向量检索是全库的，别的群的话题相似度再高也不能串台
    const other = addLines(db, 99999999, DAY, ['我家的猫会开门', '猫真聪明']);
    addTopic(db, 99999999, DAY, other, [0, 0, 1]);

    const scoped = await recallChat(FAKE_GROUP, { query: '有人养猫吗', queryVec: vec, days: 30 }, db);
    check('别的群的话题不串台', scoped.some((h) => other.includes(h.id)), false);

    // 不串台只是底线。真正的问题是候选池：别的群的话题挤满 top30 后，
    // 本群那个稍弱一点的话题连进池子的机会都没有，检索必须先按群收窄
    for (let i = 0; i < 31; i++) {
      addTopic(db, 99999999, DAY, addLines(db, 99999999, DAY, [`别的群聊猫 ${i}`]), [0, 1, 0]);
    }
    const mine = addLines(db, FAKE_GROUP, DAY, ['本群的猫在睡觉']);
    addTopic(db, FAKE_GROUP, DAY, mine, [0, 0.9, 0.436]);

    const narrowed = await recallChat(FAKE_GROUP, { query: '有人养猫吗', queryVec: aside, days: 30 }, db);
    check('别的群灌满候选池时，本群的话题照样召回得到', narrowed.some((h) => mine.includes(h.id)), true);
  });
}

function testStore() {
  console.log('\n[记忆存取]');
  withDb((db) => {
    const U = 555;
    const OTHER_GROUP = FAKE_GROUP + 1;
    memoryStore.noteNickName(FAKE_GROUP, U, '雨漫', db);
    memoryStore.noteNickName(OTHER_GROUP, U, '浅秋', db);

    const trait = addMemory(db, { ownerId: U, kind: 'trait', text: '在读研究生' });
    const ep = addMemory(db, { ownerId: U, kind: 'episode', text: '最近在打黑神话' });
    const rel = memoryStore.addMemory({
      ownerId: U, kind: 'relation', text: '是乃乃香的同桌', pinned: true,
    }, db);
    memoryStore.addMemory({
      ownerId: U, kind: 'alias', text: '桃子姐', pinned: true,
    }, db);

    check('档案行：关系在前、印象在后、叫法进名字', memoryStore.formatMemoryLine(U, FAKE_GROUP, db),
      '[雨漫]（也叫：桃子姐） 关系：是乃乃香的同桌｜印象：在读研究生、最近在打黑神话');
    check('同一档案在不同群使用各自群名片', memoryStore.formatMemoryLine(U, OTHER_GROUP, db),
      '[浅秋]（也叫：桃子姐） 关系：是乃乃香的同桌｜印象：在读研究生、最近在打黑神话');
    check('无群上下文时退回最近昵称', memoryStore.getNickName(U, null, db), '浅秋');

    // 这轮回复不涉及的人只注认人必需的部分，印象留给 recall_memory 按需查
    const W = 556;
    memoryStore.noteNickName(FAKE_GROUP, W, '阿岩', db);
    memoryStore.addMemory({ ownerId: W, kind: 'trait', text: '爱吃辣' }, db);

    check('brief 档案行只留叫法和关系', memoryStore.formatMemoryLine(U, FAKE_GROUP, db, true),
      '[雨漫]（也叫：桃子姐） 关系：是乃乃香的同桌');
    check('brief 下只有印象的人整行省掉', memoryStore.formatMemoryLine(W, FAKE_GROUP, db, true), null);
    check('两档注入：full 全量、brief 精简、重复的人只出现一次',
      memoryStore.getMemoryContext(FAKE_GROUP, [U], [U, W], db),
      '[雨漫]（也叫：桃子姐） 关系：是乃乃香的同桌｜印象：在读研究生、最近在打黑神话');

    console.log('\n[ops 应用]');
    const r1 = memoryStore.applyOps(U, FAKE_GROUP, [
      { op: 'ADD', kind: 'trait', text: '住在广州', confidence: 0.9 },
      { op: 'UPDATE', id: ep, kind: 'episode', text: '已通关黑神话', confidence: 0.8 },
      { op: 'DELETE', id: trait },
    ], db);
    check('增删改都落地', [r1.added.length, r1.updated.length, r1.deleted.length], [1, 1, 1]);

    const evidenceAt = Date.now() - 1000;
    const evidenceBatch = memoryStore.attachEvidence([...r1.added, ...r1.updated], U, [
      {
        groupId: FAKE_GROUP, messageId: 7001, observedAt: evidenceAt, text: '我住在广州',
      },
      {
        groupId: OTHER_GROUP, messageId: 7002, observedAt: evidenceAt + 500, text: '黑神话已经通关了',
      },
    ], db);
    const evidence = memoryStore.listMemoryEvidence(ep, db);
    check('同一抽取批次只保存一份并关联到变更记忆', [evidenceBatch, evidence.length], [evidenceBatch, 1]);
    check('证据保留跨群、消息 ID、原文和时间范围', [
      evidence[0].groupIds, evidence[0].messageIds, evidence[0].messages,
      evidence[0].observedFrom, evidence[0].observedTo,
    ], [
      [FAKE_GROUP, OTHER_GROUP], [7001, 7002], ['我住在广州', '黑神话已经通关了'],
      evidenceAt, evidenceAt + 500,
    ]);

    const texts = () => memoryStore.listUserMemories(U, db).map((m) => m.text);
    check('软删的条目读不到了', texts().includes('在读研究生'), false);
    check('UPDATE 改的是同一行不是新增', texts().includes('已通关黑神话') && !texts().includes('最近在打黑神话'), true);

    const updated = memoryStore.listUserMemories(U, db).find((m) => m.id === ep)!;
    check('UPDATE 保留 first_seen 并累加 hits', [updated.firstSeen === updated.lastSeen, updated.hits], [false, 2]);

    const deleted = db.prepare('SELECT superseded_by FROM memory WHERE id = ?').get(trait) as { superseded_by: number };
    check('DELETE 是软删不是物理删', deleted.superseded_by, -1);
    check('软删的条目同时摘出全文索引',
      (db.prepare('SELECT count(*) AS n FROM memory_fts WHERE rowid = ?').get(trait) as { n: number }).n, 0);

    console.log('\n[pinned 保护]');
    const r2 = memoryStore.applyOps(U, FAKE_GROUP, [
      { op: 'UPDATE', id: rel, kind: 'relation', text: '已经绝交了' },
      { op: 'DELETE', id: rel },
    ], db);
    check('对钉住条目的改动全被挡下', [r2.blocked, r2.updated.length, r2.deleted.length], [2, 0, 0]);
    check('钉住的内容原样还在', texts().includes('是乃乃香的同桌'), true);

    const r3 = memoryStore.applyOps(U, FAKE_GROUP, [{ op: 'DELETE', id: 999999 }], db);
    check('认不出 id 的操作直接丢掉，不误伤', r3.deleted.length, 0);

    const before = texts().length;
    const hitsBefore = memoryStore.listUserMemories(U, db).find((m) => m.text === '住在广州')!.hits;
    const r4 = memoryStore.applyOps(U, FAKE_GROUP, [{ op: 'ADD', kind: 'trait', text: '住在广州' }], db);
    const hitsAfter = memoryStore.listUserMemories(U, db).find((m) => m.text === '住在广州')!.hits;
    check('同一句话又说一遍不新增，算又被印证一次',
      [texts().length, r4.added.length, r4.updated.length, r4.reaffirmed, hitsAfter - hitsBefore],
      [before, 0, 0, 1, 1]);

    console.log('\n[淘汰]');
    // 塞满上限之外的低分条目：置信度低、只被印证过一次
    for (let i = 0; i < 15; i++) {
      memoryStore.addMemory({
        ownerId: U, kind: 'episode', text: `随口说的第${i}件事`, confidence: 0.3,
      }, db);
    }
    const evicted = memoryStore.evict(U, db);
    check('episode 按自己的配额淘汰', memoryStore.listUserMemories(U, db).filter((m) => !m.pinned && m.kind === 'episode').length, 4);
    check('淘汰的是低分那批', evicted.length > 0 && texts().includes('住在广州'), true);
    check('钉住的永不淘汰', texts().includes('是乃乃香的同桌') && texts().includes('桃子姐'), true);

    console.log('\n[对外兼容形态]');
    check('getManualAliases 形态不变', [...memoryStore.getManualAliases(db).entries()], [[U, ['桃子姐']]]);
    check('hasMemory', [memoryStore.hasMemory(U, db), memoryStore.hasMemory(666, db)], [true, false]);
    check('没有昵称就没有档案行', memoryStore.formatMemoryLine(666, FAKE_GROUP, db), null);

    const POLICY_USER = 557;
    (['alias', 'relation', 'trait', 'episode'] as const).forEach((kind) => {
      for (let i = 0; i < 15; i++) {
        memoryStore.addMemory({ ownerId: POLICY_USER, kind, text: `${kind}-${i}` }, db);
      }
    });
    memoryStore.evict(POLICY_USER, db);
    const policyCounts = (['alias', 'relation', 'trait', 'episode'] as const).map(
      (kind) => memoryStore.listUserMemories(POLICY_USER, db).filter((m) => m.kind === kind).length,
    );
    check('每人 14 条，四类记忆使用独立配额', policyCounts, [2, 2, 6, 4]);
  });
}

/** 抽取的第一道闸：什么样的消息才配占一个触发名额 */
function testInformative() {
  console.log('\n[信息量过滤]');
  const MIN = 4;
  // 信息量只看本人说的那句，引文不参与计数
  const keeps = (text: string) => informativeLength(splitSpeakerPrefix(text).body.trim()) >= MIN;

  check('纯占位符不算信息量', [
    keeps('[雨漫]说：[表情]'),
    keeps('[雨漫]说：[图片]'),
    keeps('[雨漫]说：[图片][图片][表情]'),
  ], [false, false, false]);

  check('标点、emoji、颜文字不算字数', [
    keeps('[雨漫]说：？？？'),
    keeps('[雨漫]说：😂😂😂😂😂😂'),
    keeps('[雨漫]说：。。。'),
    keeps('[雨漫]说：/(ㄒoㄒ)/~~'),
  ], [false, false, false, false]);

  check('太短的附和收不进来', [
    keeps('[雨漫]说：草'),
    keeps('[雨漫]说：哈哈哈'),
    keeps('[雨漫]说：好的'),
  ], [false, false, false]);

  check('正经发言照收', [
    keeps('[雨漫]说：我下周要去广州出差'),
    keeps('[雨漫]提到我说：乃乃香帮我看看这个'),
    keeps('[雨漫]回复了桃子姐的消息(在打黑神话吗)，说：我上周就通关了'),
  ], [true, true, true]);

  check('只有链接的消息不算信息量', keeps('[雨漫]说：https://example.com/a/b/c'), false);
  check('图片配一句话照收', keeps('[雨漫]说：[图片] 这是我家新买的猫'), true);

  check('引文不参与计数，短回复照样挡在外面',
    keeps('[雨漫]回复了桃子姐的消息(你今天怎么一直没说话呀在忙什么)，说：？？'), false);

  const reply = splitSpeakerPrefix('[雨漫]回复了桃子姐的消息(在打黑神话吗)，说：我上周就通关了');
  check('回复型前缀拆成三段', [reply.replyTo, reply.quote, reply.body], ['桃子姐', '在打黑神话吗', '我上周就通关了']);
  check('普通消息只有正文', splitSpeakerPrefix('[雨漫]提到我说：乃乃香在吗').body, '乃乃香在吗');
}

/** v1~v7 已压平成基线，认不出来的库要当场报错，不能在上面继续建表 */
function testLegacySchemaRejected() {
  console.log('\n[老库拒绝]');
  const LEGACY_DB = path.join(os.tmpdir(), `nonoka_legacy_${process.pid}.db`);
  const clean = () => ['', '-wal', '-shm'].forEach((s) => fs.rmSync(`${LEGACY_DB}${s}`, { force: true }));

  /** 打开一次，返回抛出的错误信息；正常打开则返回空串 */
  const openError = (): string => {
    try {
      createMemoryDb(LEGACY_DB).close();
      return '';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  try {
    clean();
    const noVersion = createMemoryDb(LEGACY_DB);
    delMeta(noVersion, 'schema_version');
    noVersion.close();
    check('有表却没版本号的库不建基线', /拒绝在上面建基线/.test(openError()), true);

    clean();
    const oldVersion = createMemoryDb(LEGACY_DB);
    check('新库直接落到基线版本', getMeta(oldVersion, 'schema_version'), SCHEMA_VERSION);
    setMeta(oldVersion, 'schema_version', '3');
    oldVersion.close();
    check('低于基线的库拒绝打开', /低于基线/.test(openError()), true);
  } finally {
    clean();
  }
}

export async function testMemory() {
  const fixtures = [fixtureFile(20), fixtureFile(3), fixtureFile(1)];
  const existing = fixtures.filter((f) => fs.existsSync(f));
  if (existing.length > 0) {
    console.error(`样本文件已存在，先手动清理再跑：\n${existing.join('\n')}`);
    return;
  }

  try {
    testSchema();
    testIdempotent();
    testLegacySchemaRejected();
    testFts();
    testSegment();
    testInformative();
    testParse();
    fs.mkdirSync(CHAT_BACKUP_DIR, { recursive: true });
    testIngest();
    await testConsolidationTracking();
    testVector();
    testRrf();
    testStore();
    await testRecall();
    await testRecallQuality();
    console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    fixtures.forEach((f) => fs.rmSync(f, { force: true }));
    ['', '-wal', '-shm'].forEach((suffix) => fs.rmSync(`${TEST_DB}${suffix}`, { force: true }));
  }
}

await testMemory();
