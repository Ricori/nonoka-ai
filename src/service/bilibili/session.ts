import crypto from 'crypto';
import Axios from 'axios';
import { botConfig, saveConfigToDisk } from '@/core/nnkConfig';
import { printError, printLog } from '@/utils/print';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const WBI_MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
];

/** 网页端 cookie 续期用的公钥，加密 refresh_{timestamp} 生成 correspondPath */
const REFRESH_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg
Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71
nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40
JNrRuoEUXpabUzGB8QIDAQAB
-----END PUBLIC KEY-----`;

const HALF_DAY = 12 * 3600 * 1000;

/** 程序自己补的 cookie（buvid、bili_ticket），只放内存，覆盖配置里的同名项 */
const extraCookies = new Map<string, string>();
let ticketAt = 0;
let wbiMixinKey = '';
let wbiAt = 0;
let refreshCheckAt = 0;
let preparing: Promise<void> | null = null;

function parseCookie(str: string) {
  const map = new Map<string, string>();
  str.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  });
  return map;
}

const stringifyCookie = (map: Map<string, string>) => [...map].map(([k, v]) => `${k}=${v}`).join('; ');

const ownCookie = () => parseCookie(botConfig.biliDynamicPush.cookie ?? '');

export function getCookie() {
  const map = ownCookie();
  extraCookies.forEach((v, k) => map.set(k, v));
  return stringifyCookie(map);
}

async function ensureBuvid() {
  if (ownCookie().has('buvid3') || extraCookies.has('buvid3')) return;
  const { data } = await Axios.get('https://api.bilibili.com/x/frontend/finger/spi', {
    headers: { 'User-Agent': UA },
    timeout: 10000,
  });
  extraCookies.set('buvid3', data.data.b_3);
  extraCookies.set('buvid4', encodeURIComponent(data.data.b_4));
}

async function ensureTicket() {
  if (Date.now() - ticketAt < HALF_DAY) return;
  const ts = Math.floor(Date.now() / 1000);
  const hexsign = crypto.createHmac('sha256', 'XgwSnGZ1p').update(`ts${ts}`).digest('hex');
  const { data } = await Axios.post('https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket', null, {
    params: {
      key_id: 'ec02', hexsign, 'context[ts]': ts, csrf: ownCookie().get('bili_jct') ?? '',
    },
    headers: { 'User-Agent': UA },
    timeout: 10000,
  });
  if (data.code !== 0) throw new Error(`GenWebTicket ${data.code} ${data.message}`);
  extraCookies.set('bili_ticket', data.data.ticket);
  extraCookies.set('bili_ticket_expires', String(data.data.created_at + data.data.ttl));
  ticketAt = Date.now();
}

async function ensureWbiKey() {
  if (wbiMixinKey && Date.now() - wbiAt < HALF_DAY) return;
  // 未登录时 nav 返回 -101，但 wbi_img 照样有
  const { data } = await Axios.get('https://api.bilibili.com/x/web-interface/nav', {
    headers: { cookie: getCookie(), 'User-Agent': UA },
    timeout: 10000,
  });
  const img = data.data?.wbi_img;
  if (!img) throw new Error(`nav 没有 wbi_img: ${data.code}`);
  const key = (url: string) => url.slice(url.lastIndexOf('/') + 1).split('.')[0];
  const raw = key(img.img_url) + key(img.sub_url);
  wbiMixinKey = WBI_MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32);
  wbiAt = Date.now();
}

async function refreshCookieIfNeeded() {
  if (Date.now() - refreshCheckAt < HALF_DAY) return;
  refreshCheckAt = Date.now();
  const conf = botConfig.biliDynamicPush;
  const csrf = ownCookie().get('bili_jct') ?? '';
  const headers = { cookie: conf.cookie, 'User-Agent': UA };

  const info = (await Axios.get('https://passport.bilibili.com/x/passport-login/web/cookie/info', {
    params: { csrf }, headers, timeout: 10000,
  })).data;
  if (info.code === -101) {
    printError('[Bilibili] cookie 已失效，请重新登录后更新 cookie 和 refreshToken');
    return;
  }
  if (info.code !== 0 || !info.data?.refresh) return;
  if (!conf.refreshToken) {
    printError('[Bilibili] cookie 需要续期，但没有配置 refreshToken');
    return;
  }

  const correspondPath = crypto.publicEncrypt(
    { key: REFRESH_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(`refresh_${info.data.timestamp}`),
  ).toString('hex');
  const html = (await Axios.get(`https://www.bilibili.com/correspond/1/${correspondPath}`, { headers, timeout: 10000 })).data;
  const refreshCsrf = String(html).match(/<div id="1-name">([^<]+)<\/div>/)?.[1];
  if (!refreshCsrf) throw new Error('correspond 页面里没有 refresh_csrf');

  const res = await Axios.post('https://passport.bilibili.com/x/passport-login/web/cookie/refresh', new URLSearchParams({
    csrf, refresh_csrf: refreshCsrf, source: 'main_web', refresh_token: conf.refreshToken,
  }), { headers, timeout: 10000 });
  if (res.data.code !== 0) throw new Error(`cookie/refresh ${res.data.code} ${res.data.message}`);

  const jar = ownCookie();
  (res.headers['set-cookie'] ?? []).forEach((c) => {
    const kv = c.split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  });
  const oldToken = conf.refreshToken;
  conf.cookie = stringifyCookie(jar);
  conf.refreshToken = res.data.data.refresh_token;
  saveConfigToDisk();
  printLog('[Bilibili] cookie 已自动续期');

  // 确认后旧 refresh_token 才作废，失败也不影响新 cookie
  await Axios.post('https://passport.bilibili.com/x/passport-login/web/confirm/refresh', new URLSearchParams({
    csrf: jar.get('bili_jct') ?? '', refresh_token: oldToken,
  }), { headers: { cookie: conf.cookie, 'User-Agent': UA }, timeout: 10000 });
}

async function runPrepare() {
  const steps: [string, () => Promise<void>][] = [
    ['cookie 续期', refreshCookieIfNeeded],
    ['buvid', ensureBuvid],
    ['bili_ticket', ensureTicket],
    ['wbi key', ensureWbiKey],
  ];
  for (let i = 0; i < steps.length; i += 1) {
    const [name, step] = steps[i];
    try {
      // eslint-disable-next-line no-await-in-loop
      await step();
    } catch (e) {
      printError(`[Bilibili] 准备 ${name} 失败: ${e.message}`);
    }
  }
}

/** 请求前补齐 cookie 和签名所需状态，多个 UID 并发调用时共用一次 */
export function prepareSession() {
  if (!preparing) preparing = runPrepare().finally(() => { preparing = null; });
  return preparing;
}

export function signWbi(params: Record<string, string | number>) {
  const withTs: Record<string, string | number> = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(withTs).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(withTs[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const wRid = crypto.createHash('md5').update(query + wbiMixinKey).digest('hex');
  return `${query}&w_rid=${wRid}`;
}
