import assert from 'node:assert/strict';
import http from 'http';
import nnkbot from '@/core/nnkBot';
import type { FormattedMessage } from '@/types/message';
import { GroupReplyTrigger, scoreMoment } from '@/modules/aiReply/group/trigger';
import { matchAlias, normalizeAlias, normalizeText } from '@/modules/aiReply/history/nameMatch';
import { runSearchTool } from '@/modules/aiReply/search/tools';
import { sanitizePrompt } from '@/service/imageGen';

const user = (message: string, isMentionMe = false): FormattedMessage => ({
  role: 'user', userId: 1, isMentionMe, message,
});

// -------- 主动插话门控 --------
{
  const plain = Array.from({ length: 20 }, () => user('[甲]说：今天吃什么'));
  const hot = [...plain.slice(5), ...Array.from({ length: 4 }, () => user('[甲]提到我说：在吗', true)), user('[甲]说：hh')];
  const selfTalk = [...plain.slice(5), ...Array.from({ length: 5 }, (): FormattedMessage => ({
    role: 'assistant', userId: 0, isMentionMe: false, message: '嗯嗯',
  }))];
  assert.ok(scoreMoment(hot) > 1);
  assert.equal(scoreMoment(selfTalk), 0);

  const t = new GroupReplyTrigger();
  let sumBase = 0; let sumChance = 0; let hotChance = 0;
  for (let i = 1; i <= 400; i += 1) {
    const r = t.evaluate(-1, i % 2 ? hot : plain, i * 1000);
    if (i > 100) {
      sumBase += r.baseChance; sumChance += r.chance;
      if (i % 2) hotChance += r.chance;
    }
  }
  assert.ok(Math.abs(sumChance / sumBase - 1) < 0.05, `预算偏差 ${sumChance / sumBase}`);
  assert.ok(hotChance > sumChance * 0.7);

  let last = 1;
  for (let i = 0; i < 200; i += 1) last = t.rollInitiative(-2, plain, i * 1000, () => 0)?.chance ?? 0;
  assert.equal(last, 0);
  console.log('✓ 插话门控：预算守恒、概率挪向群友找 bot 的时刻、bot 自说自话不加分、超预算后压到 0');
}

// -------- 认人 --------
{
  const hit = (message: string, nickName: string) => matchAlias(normalizeText(message), normalizeAlias(nickName)) > 0;
  assert.equal(hit('乃乃香你好', '乃乃香'), false);
  assert.equal(hit('乃乃香你好', '乃乃香爸爸'), false);
  assert.equal(hit('智乃老师又开始了吗', '千野智乃'), true);
  assert.equal(hit('小雏说话', '朔洇雏子'), false);
  assert.equal(hit('azusa 唱得好', 'azu'), false);
  assert.equal(hit('今天好热', '有一种下班的预感'), false);
  console.log('✓ 认人：bot 名不认成群友，省略姓能认，相近名/英文片段/日常词不误命中');
}

// -------- 画图 prompt 年龄清理 --------
{
  assert.equal(sanitizePrompt('动画风格，15岁高一少女，金色双马尾'), '动画风格，少女，金色双马尾');
  const en = sanitizePrompt('A cute 15-year-old anime girl with twin-tails, wearing a high school uniform. Soft lighting.');
  assert.ok(!/15|year[\s-]?old|high[\s-]?school/i.test(en), en);
  assert.ok(en.includes('anime girl') && en.includes('uniform'), en);
  console.log('✓ 画图 prompt：中英文年龄与年级都被抹掉，主体不误伤');
}

// -------- 搜索每群日额度 --------
{
  const PORT = 8788;
  let upstreamHits = 0;
  let fail = false;
  const stub = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      upstreamHits += 1;
      res.writeHead(fail ? 502 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fail
        ? { success: false, error: 'search failed' }
        : { success: true, answer: '多云', results: [{ title: '天气', url: 'https://x.test', snippet: '多云' }] }));
    });
  }).listen(PORT, '127.0.0.1');
  // 全部指向假服务端，不烧真实额度
  nnkbot.config.nonokaService = { baseUrl: `http://127.0.0.1:${PORT}`, apiKey: 'testkey', cdnHost: '' };
  nnkbot.config.aiReply.search = {
    enable: true, whiteGroupIds: [], dailyLimit: 2, count: 5,
  };
  try {
    const search = (g: number) => runSearchTool(g, 'web_search', { query: 'x' });
    assert.ok((await search(70007)).includes('【概要】'));
    assert.ok((await search(70007)).includes('【概要】'));
    upstreamHits = 0;
    assert.ok((await search(70007)).includes('今天查得太多了'));
    assert.equal(upstreamHits, 0);
    assert.ok((await search(80008)).includes('【概要】'));
    // 上游失败也要记账，否则一直失败等于额度无限
    fail = true;
    await search(90009);
    await search(90009);
    fail = false;
    assert.ok((await search(90009)).includes('今天查得太多了'));
    console.log('✓ 搜索额度：超额不打上游，按群隔离，失败也计数');
  } finally {
    stub.close();
  }
}
