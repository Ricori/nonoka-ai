import { createHash } from 'crypto';
import { Jieba, TfIdf } from '@node-rs/jieba';
import { dict, idf } from '@node-rs/jieba/dict';
import { BOT_NAME_ALIASES } from '@/constants';
import { USER_WORDS } from './userDict';

/** 消息正文前的说话人前缀，检索前要剥掉，否则昵称会被当成关键词 */
const PREFIX_RE = /^\[[^\]]*\](?:回复了[\s\S]*?的消息\([\s\S]*?\)，说：|提到我说：|说：)/;

/** 引文过长会被截断，导致整条前缀正则匹配不上，只好退回剥掉开头的 `[昵称]` */
const NICK_RE = /^\[[^\]]*\]/;

/** 回复型前缀，拆出被回复的人和引文 */
const REPLY_RE = /^\[[^\]]*\]回复了([\s\S]*?)的消息\(([\s\S]*?)\)，说：/;

/** 去掉 `[昵称]说：` 这类前缀只留正文。认人时也要用：
 *  不剥的话说话人自己的昵称永远命中自己，白占一个注入名额 */
export function stripSpeakerPrefix(message: string): string {
  const body = message.replace(PREFIX_RE, '');
  // 正则整条命中时开头已经不是 [ 了；没命中说明是被截断的引文，至少把昵称摘掉
  return body === message ? body.replace(NICK_RE, '') : body;
}

export interface SpeakerParts {
  /** 被回复的人，非回复型消息是空串 */
  replyTo: string;
  /** 引文原文，非回复型消息是空串 */
  quote: string;
  /** 这个人自己说的那句话 */
  body: string;
}

/**
 * 把 `[昵称]回复了X的消息(引文)，说：正文` 拆成三段，非回复型消息只有正文。
 *
 * 抽取记忆时要分开算：引文是别人的话，不能拿它的字数把「？？」这种回复放行，
 * 但整段扔掉又会让「刚通关」这类回复读不懂，只能留一小截当上下文
 */
export function splitSpeakerPrefix(message: string): SpeakerParts {
  const reply = message.match(REPLY_RE);
  if (reply) {
    return { replyTo: reply[1].trim(), quote: reply[2].trim(), body: message.slice(reply[0].length) };
  }
  return { replyTo: '', quote: '', body: stripSpeakerPrefix(message) };
}

/** 词典有几 MB，第一次真正分词时才加载 */
let jieba: Jieba | null = null;
let tfidf: TfIdf | null = null;

/** 真正补进去的自定义词，jieba 本来就认识的不算 */
let loadedWords: string[] = [];

/** 词典行格式 `词 词频 词性`。实测词频 3 压不过按单字切，100 够用，取整到 1000 留余量 */
const USER_WORD_FREQ = 1000;

function getJieba(): Jieba {
  if (!jieba) {
    const base = Jieba.withDict(dict);
    // 已经认识的词不重复加，否则会把它原有的词频改成我们这个值
    loadedWords = USER_WORDS.filter((w) => base.cut(w).length > 1);
    if (loadedWords.length > 0) {
      base.loadDict(Buffer.from(loadedWords.map((w) => `${w} ${USER_WORD_FREQ} n`).join('\n')));
    }
    jieba = base;
  }
  return jieba;
}

/**
 * 自定义词典的指纹。它变了意味着同一句话的分词结果会变，
 * 已经建好的全文索引必须重建，否则索引侧和查询侧对不上、直接召不回
 */
export function dictSignature(): string {
  getJieba();
  return createHash('sha1').update(loadedWords.join('\n')).digest('hex').slice(0, 12);
}

function getTfIdf(): TfIdf {
  if (!tfidf) tfidf = TfIdf.withDict(idf);
  return tfidf;
}

/** 至少含一个字母/数字/汉字才是有意义的 token，标点和空白丢掉 */
const TOKEN_RE = /[\p{L}\p{N}]/u;

/**
 * 分词并用空格连接，结果写进 FTS5 的 seg 列。
 * unicode61 不切 CJK，不先分词的话整段中文会变成一个 token，两字词永远命不中
 */
export function segment(text: string): string {
  return getJieba().cut(text).filter((w) => TOKEN_RE.test(w)).join(' ');
}

/**
 * 切出来了但没有检索价值的词，三类：
 * 一是 CQ 码转成的占位符（[图片] [表情]），拿去检索只会捞回一堆同样发过图的记录；
 * 二是泛用动词和时间词，什么话题都沾边，命中的基本都是不相关的旧账；
 * 三是 jieba 默认停用词表漏掉的疑问短语，它们权重不低但完全不携带话题信息
 */
const USELESS_WORDS = new Set([
  '图片', '表情', '视频', '语音', '记录', '聊天', '卡片', '消息', '分享', '文章', '之前',
  '记得', '知道', '觉得', '感觉', '时候', '这样', '那样', '现在', '今天', '明天', '昨天',
  '一样', '真的', '其实', '而且', '虽然', '如果', '为什', '怎样',
  '是不是', '有没有', '什么', '为什么', '怎么', '怎么办', '可以', '这个', '那个', '东西', '事情',
  '上次', '最近', '哪里', '一个', '多少', '什么时候',
]);

const BOT_ALIASES = new Set(BOT_NAME_ALIASES.map((a) => a.toLowerCase()));

/** 单字没有区分度 */
const MIN_LEN = 2;
/** 英文另算：两字母词（ai、pc）在群聊里满地都是，噪音远大于信息 */
const EN_MIN_LEN = 3;
const DEFAULT_TOP_K = 6;

const EN_RE = /^[a-z]+$/;

function usable(word: string): boolean {
  const lower = word.toLowerCase();
  if (USELESS_WORDS.has(word) || BOT_ALIASES.has(lower)) return false;
  return word.length >= (EN_RE.test(lower) ? EN_MIN_LEN : MIN_LEN);
}

export interface WeightedTerm {
  term: string;
  /** TF-IDF 权重，也就是稀有度。检索时按它给每一路加权 */
  weight: number;
}

/**
 * 从一句话里抽出检索词，按 TF-IDF 权重降序。
 * 排序维度是稀有度而不是长度——片段越长在历史日志里逐字出现的概率越低，
 * 真正可召回的短词反而会被长度排序挤掉
 */
export function weightedTerms(text: string, topK = DEFAULT_TOP_K): WeightedTerm[] {
  const body = stripSpeakerPrefix(text);
  // 多要几个再过滤，免得名额被停用词占掉
  const raw = getTfIdf().extractKeywords(getJieba(), body, topK * 3);

  const terms: WeightedTerm[] = [];
  for (const { keyword, weight } of raw) {
    if (usable(keyword)) terms.push({ term: keyword, weight });
    if (terms.length >= topK) break;
  }
  return terms;
}

export function queryTerms(text: string, topK = DEFAULT_TOP_K): string[] {
  return weightedTerms(text, topK).map((t) => t.term);
}
