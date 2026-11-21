import { BOT_NAME_ALIASES } from '@/constants';

/**
 * 昵称匹配。群友嘴上叫的名字和档案里的昵称几乎不会逐字相等：
 * 「爱丽丝」对应的档案昵称可能是「爱丽丝offical」，「古今東西」对应「古今東西_Official」。
 * 所以不能拿消息里切出的词去查表，而要反过来——拿每个已知昵称去和消息正文对撞，
 * 取最长公共子串并打分。昵称总量只有几百个，全量扫一遍是微秒级的事。
 */

/** 零宽字符与变体选择符：肉眼看不见，却会让「高达吉士双牛堡‌」这种昵称永远对不上 */
const INVISIBLE = '\\u200b-\\u200f\\u2060\\ufeff\\ufe00-\\ufe0f';

/**
 * 昵称里的装饰成分：空白、零宽字符、各类标点括号、箭头符号、emoji（含代理对）。
 * 群友叫的是核心名，这些一律不参与匹配
 */
// 这两个字符组里有零宽连接符和变体选择符，会被 no-misleading-character-class 判为
// 可能把字形切开——这里正是要按码元把它们逐个删掉，切开即目的，故豁免
/* eslint-disable no-misleading-character-class */
const DECORATION_RE = new RegExp(
  `[\\s${INVISIBLE}\\u0021-\\u002f\\u003a-\\u0040\\u005b-\\u0060\\u007b-\\u007e`
  + '\\u2010-\\u205e\\u2190-\\u2bff\\u3000-\\u303f'
  + '\\uff01-\\uff0f\\uff1a-\\uff20\\uff3b-\\uff40\\uff5b-\\uff65\\ud800-\\udfff]',
  'g',
);

/** 消息里只清掉零宽字符：空格和标点要留着，latin 昵称靠它们判断词边界 */
const INVISIBLE_RE = new RegExp(`[${INVISIBLE}]`, 'g');
/* eslint-enable no-misleading-character-class */

/** 能构成名字的字符：汉字、假名、谚文、拉丁字母、数字。
 *  匹配片段必须整段由它们组成，用来挡掉 emoji 代理对被切半后的碎片 */
const NAME_SEG_RE = /^[一-龥぀-ヿ가-힣a-z0-9]+$/;

const LATIN_SEG_RE = /^[a-z0-9]+$/;

/**
 * 没有实义的字。整段都由它们组成的片段不能算认出了人，
 * 否则句子式昵称（「今天不想上班」「那你当我死了吧」）会被日常对话蹭中。
 * 这里只收虚词、代词、时间词——和 keywords.ts 的 STOP_CHARS 用途不同，
 * 那边是拿虚词当切词分隔符，会连轻动词一起切，这边只是判断片段是否空洞。
 */
const FILLER_CHARS = '的了是在有我你他她它们这那什么怎就都也和跟把被给会要去来吗吧呢啊个不没很还上下今天明昨时候现一';

/**
 * 助词。名字中间不会以助词收口，命中片段在昵称还没走完时就以助词开头或收尾，
 * 说明切在了句子中间：「33就剩最后的枪决了」曾靠「最后的」命中昵称「最后的绿色」，
 * 「一切的一切都…」曾靠「的一切」命中昵称「关于莉莉娅的一切」，都是这么来的。
 * 注意昵称自身的首尾不算——「是流逝啊啊啊」整段命中时结尾就是「啊」
 */
const PARTICLE_CHARS = '的了着过吗吧呢啊呀哦';

/**
 * 昵称首尾的系词和语气词。群友叫的是核心名：「是流逝啊啊啊」大家只叫「流逝」，
 * 把这两截算进覆盖率的分母，2 字的核心名就永远够不到阈值。
 * 刻意比 FILLER_CHARS 窄得多——只收纯语气成分，不含「好多上下今天」这类实词，
 * 否则分母缩太多会把「下班」蹭中「有一种下班的预感」这类误命中放进来
 */
const TRIM_CHARS = '是的了着过吗吧呢啊呀哦嘛啦哇喔噢';

/** 系统默认名和占位名，谁都可能用到，认人时一律忽略 */
const JUNK_ALIASES = new Set(['我的设备', 'qq用户', '匿名', '匿名用户', '游客', 'admin', 'unknown']);

/** 归一化后的昵称短于这个长度就不参与匹配：单字昵称拿去撞消息全是噪音 */
const MIN_ALIAS_LEN = 2;
/** 命中片段的最小长度，latin 另算——两字母词（ai、pc）在群聊里满地都是 */
const MIN_SEG_LEN = 2;
const MIN_LATIN_SEG_LEN = 3;
/** 片段占昵称的比例达到这个值就算认出了人，否则要靠绝对长度兜底 */
const MIN_COVERAGE = 0.4;
/** 够长的片段即使只覆盖昵称一小截也算命中，「爱丽丝」对「爱丽丝offical」就靠这条 */
const ENOUGH_SEG_LEN = 2;

const BOT_ALIASES = BOT_NAME_ALIASES.map((a) => a.toLowerCase());

/** 昵称归一化：去装饰、转小写，得到群友实际会叫的核心名 */
export function normalizeAlias(raw: string): string {
  return raw.replace(DECORATION_RE, '').toLowerCase();
}

/** 链接里全是任意字母串，很容易撞上 latin 昵称（曾有人贴 lovelive-anime.jp 的链接
 *  被认成昵称含 LoveLive 的群友），认人前整段去掉 */
const URL_RE = /(?:https?:\/\/|www\.)\S+/g;

/** 消息正文归一化：只转小写并去掉零宽字符，保留空格标点以便判断词边界 */
export function normalizeText(raw: string): string {
  return raw.replace(INVISIBLE_RE, '').replace(URL_RE, ' ').toLowerCase();
}

/** 最长公共子串，返回长度和它在 a、b 里各自的起点 */
function longestCommonSubstring(a: string, b: string): { len: number; aStart: number; bStart: number } {
  let best = 0;
  let aEnd = 0;
  let bEnd = 0;
  let prev = new Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) {
          best = cur[j];
          aEnd = i;
          bEnd = j;
        }
      }
    }
    prev = cur;
  }
  return { len: best, aStart: aEnd - best, bStart: bEnd - best };
}

function isAllFiller(seg: string): boolean {
  return [...seg].every((c) => FILLER_CHARS.includes(c));
}

/**
 * 昵称的核心名：剥掉首尾的系词和语气词。覆盖率要按核心名算，
 * 否则「流逝」占「是流逝啊啊啊」只有 2/6，达不到阈值
 */
function aliasCore(normAlias: string): string {
  let start = 0;
  let end = normAlias.length;
  while (start < end && TRIM_CHARS.includes(normAlias[start])) start += 1;
  while (end > start && TRIM_CHARS.includes(normAlias[end - 1])) end -= 1;
  const core = normAlias.slice(start, end);
  // 整个昵称都是语气词（少见）时退回原样，免得核心名空掉
  return core.length >= MIN_ALIAS_LEN ? core : normAlias;
}

/**
 * 片段是不是切在了句子中间。只有片段边界落在昵称内部时才算——
 * 片段正好顶到昵称的头或尾，那就是完整的名字，即使收尾是语气词也放行
 */
function isCutMidSentence(seg: string, alias: string, bStart: number): boolean {
  if (bStart > 0 && PARTICLE_CHARS.includes(seg[0])) return true;
  return bStart + seg.length < alias.length && PARTICLE_CHARS.includes(seg[seg.length - 1]);
}

/** latin 片段要求两侧是非字母，否则 alice 会被 malicious 蹭中、azu 会被 azusa 蹭中 */
function hasLatinBoundary(text: string, start: number, len: number): boolean {
  const isWordChar = (c: string | undefined) => c !== undefined && LATIN_SEG_RE.test(c);
  return !isWordChar(text[start - 1]) && !isWordChar(text[start + len]);
}

/**
 * 判断一条消息里有没有叫到某个昵称，返回匹配得分，0 表示没命中。
 * 得分只用于同一条消息内多人命中时排序，绝对值没有意义。
 *
 * @param normText 已经 normalizeText 过的消息正文（剥掉说话人前缀）
 * @param normAlias 已经 normalizeAlias 过的昵称
 */
export function matchAlias(normText: string, normAlias: string): number {
  if (normAlias.length < MIN_ALIAS_LEN || JUNK_ALIASES.has(normAlias)) return 0;

  // 一律拿核心名去撞，覆盖率也按核心名算
  const core = aliasCore(normAlias);
  const { len, aStart, bStart } = longestCommonSubstring(normText, core);
  if (len < MIN_SEG_LEN) return 0;

  const seg = normText.slice(aStart, aStart + len);
  if (!NAME_SEG_RE.test(seg) || isAllFiller(seg) || isCutMidSentence(seg, core, bStart)) return 0;

  // bot 自己的名字要排除，否则每次被叫都会命中昵称含「乃乃香」的群友。
  // 用 includes 而不是相等：命中片段是 bot 别名的一部分（「乃乃」）同样要拒，
  // 但昵称本身比 bot 别名更长时（「乃乃香爸爸」整段命中）说的确实是那个人，放行
  if (BOT_ALIASES.some((a) => a.includes(seg))) return 0;

  if (LATIN_SEG_RE.test(seg)) {
    if (len < MIN_LATIN_SEG_LEN) return 0;
    if (!hasLatinBoundary(normText, aStart, len)) return 0;
    // 昵称一侧也必须成词。只查消息侧不够：off 是 official 的中段、live 是 lovelive 的中段、
    // san 是 sanjen 的中段，而「off会」「看live」「san值」在群里天天出现，
    // 真实日志里这三个碎片一共误命中过 16 次
    if (!hasLatinBoundary(core, bStart, len)) return 0;
  }

  const coverage = len / core.length;
  if (coverage < MIN_COVERAGE && len < ENOUGH_SEG_LEN) return 0;

  // 群友省略的几乎都是后缀（「爱丽丝offical」→「爱丽丝」），命中在昵称开头是强信号
  const isPrefix = core.startsWith(seg);
  return len * 2 + coverage * 3 + (isPrefix ? 2 : 0);
}
