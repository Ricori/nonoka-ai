/* eslint-disable @typescript-eslint/indent */
import puppeteer from 'puppeteer';
import { TweetPost } from './tweet';

interface tweetDisplayData {
  avatarUrl: string;
  displayName: string;
  username: string;
  mainText: string;
  transText: string;
  hashTags: string[];
  time: string;
  day: string;
}
// 把换行转成 <br>
function nl2br(str: string) {
  return str.trim().replace(/\r?\n/g, '<br>');
}
function extractAndRemoveTags(text: string) {
  // 提取所有 tag（#开头，直到遇到空白或换行）
  const regex = /#([^\s#]+)/g;
  const tags: string[] = [];
  let match: RegExpExecArray | null = regex.exec(text);
  while (match !== null) {
    tags.push(`#${match[1]}`);
    match = regex.exec(text);
  }
  // 删除所有 tag（包括后面可能有的空格）
  const textWithoutTags = text.replace(regex, '');
  return {
    tags,
    text: textWithoutTags,
  };
}
function createHtml(tweetData: tweetDisplayData) {
  return `
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <style>
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        padding: 0;
        background: #ffffff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }
      .tweet {
        width: 598px;
        padding: 16px;
      }
      .header {
        align-items: stretch;
        box-sizing: border-box;
        display: flex;
        flex-basis: auto;
        flex-direction: row;
        flex-shrink: 0;
        list-style: none;
        position: relative;
      }
      .avatar {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        overflow: hidden;
        margin-right: 8px;
        flex-shrink: 0;
        flex-grow: 0;
        align-items: center;
        flex-basis: 40px;
      }
      .avatar img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .name {
        font-weight: 700;
        font-size: 15px;
        color: rgb(15, 20, 25);
        line-height: 20px;
      }
      .handle {
        font-size: 15px;
        color: rgb(83, 100, 113);
        word-wrap: break-word;
        line-height: 20px;
      }
      .content {
        padding-top: 12px;
      }
      .main-text {
        white-space: normal;
        word-break: break-word;
        color: rgb(15, 20, 25);
        font-size: 17px;
        line-height: 24px;
      }
      .hashtag {
        color: rgb(29, 155, 240);
        font-size: 17px;
        line-height: 24px;
      }
      .card {
        margin-top: 16px;
        font-size: 16px;
        background: #FBF5F5;
        padding: 12px;
        border-radius: 6px;
        font-family: Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      .ltr {
        color: rgb(15, 20, 25);
        font-size: 13px;
        line-height: 16px;
      }
      .ltr-blue {
        color: rgb(29, 155, 240);
        line-height: 16px;
      }
      .card-text {
        margin-top: 8px;
      }
      .card-hashtag {
        color: #1d9bf0;
      }
      .timg {
        width: 100%;
        margin-top: 8px;
        border-radius: 16px;
      }
      .footer {
        margin-top: 16px;
        color: rgb(83, 100, 113);
        font-size: 15px;
        line-height: 20px;
        font-family: Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
      }
    </style>
  </head>
  <body>
    <div class="tweet">
      <div class="header">
        <div class="avatar">
          <img src="${tweetData.avatarUrl}" />
        </div>
        <div>
          <div class="name">${tweetData.displayName}</div>
          <div class="handle">${tweetData.username}</div>
        </div>
      </div>
      <div class="content">
        <div class="main-text">
        ${nl2br(tweetData.mainText)}
        </div>
        ${tweetData.hashTags[0] ? `<br><div class="hashtag">${tweetData.hashTags[0]}</div>` : ''}
        ${tweetData.hashTags[1] ? `<div class="hashtag">${tweetData.hashTags[1]}</div>` : ''}
      </div>
      ${tweetData.transText
      ? `<div class="card">
      <div class="ltr">
        <span>由 ののかちゃん </span><span class="ltr-blue">翻译</span>
      </div>
      <div class="card-text">
      ${nl2br(tweetData.transText)}
      </div>
      ${tweetData.hashTags[0] ? `<br><div class="hashtag">${tweetData.hashTags[0]}</div>` : ''}
      ${tweetData.hashTags[1] ? `<div class="hashtag">${tweetData.hashTags[1]}</div>` : ''}
    </div>` : ''}
      <div class="footer">
        <span>${tweetData.time} · ${tweetData.day}</span>
      </div>
    </div>
  </body>
  </html>
  `;
}

function formatTime(ts: number) {
  const date = new Date(ts);
  const y = date.getFullYear();
  const m = date.getMonth() + 1; // 月份从 0 开始
  const d = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const period = hours < 12 ? '上午' : '下午';
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return {
    time: `${period}${h12}:${minutes}`,
    day: `${y}年${m}月${d}日`,
  };
}

export async function createScreenshot(data: TweetPost) {
  const { tags, text } = extractAndRemoveTags(data.tweetText);
  const { time, day } = formatTime(data.time);

  const html = createHtml({
    avatarUrl: data.userPofile,
    displayName: data.username,
    username: data.userScreenName,
    mainText: text,
    transText: data.translatedText,
    hashTags: tags,
    time,
    day,
  });

  const browser = await puppeteer.launch({
    headless: true,
  });
  const page = await browser.newPage();

  await page.setViewport({ width: 598, height: 1000, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'networkidle0' });

  try {
    const tweetElement = await page.$('.tweet');
    if (tweetElement) {
      const base64 = await tweetElement.screenshot({ encoding: 'base64' });
      const dataUrl = `data:image/png;base64,${base64}`;
      return dataUrl;
    }
    return undefined;
  } catch (err) {
    return undefined;
  } finally {
    await browser.close();
  }
}
