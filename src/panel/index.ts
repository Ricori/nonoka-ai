import fs from 'fs';
import http from 'http';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { printError, printLog } from '@/utils/print';
import { handleConfigRoute } from './routes/config';
import { handleMemoryRoute } from './routes/memory';

const PAGE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'page.html');

export class AdminPanel {
  private server?: http.Server;

  private pageHtml = fs.readFileSync(PAGE_PATH, 'utf8');

  start() {
    const port = Number(process.env.ADMIN_PORT || 9616);
    const host = process.env.ADMIN_HOST || '127.0.0.1';
    const envToken = process.env.ADMIN_TOKEN;
    const isLocal = host === '127.0.0.1' || host === 'localhost';

    if (!envToken && !isLocal) {
      printError('[AdminPanel] 拒绝启动：绑定非本地地址时必须通过 ADMIN_TOKEN 环境变量设置固定令牌。');
      return;
    }

    const token = envToken || crypto.randomBytes(16).toString('hex');
    if (!envToken) {
      printLog(`[AdminPanel] 未设置 ADMIN_TOKEN，已生成临时令牌（重启后失效）: ${token}`);
    }

    this.server = http.createServer((req, res) => {
      this.handle(req, res, token).catch((error) => {
        printError('[AdminPanel Error]', error);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      });
    });
    this.server.listen(port, host, () => {
      printLog(`[AdminPanel] http://${host}:${port}/?token=${token}`);
    });
  }

  stop() {
    this.server?.close();
  }

  private checkAuth(req: http.IncomingMessage, url: URL, token: string) {
    const headerToken = req.headers['x-admin-token'];
    const queryToken = url.searchParams.get('token');
    return headerToken === token || queryToken === token;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, token: string) {
    const url = new URL(req.url || '/', 'http://x');

    if (!this.checkAuth(req, url, token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(this.pageHtml);
      return;
    }

    // 兼容旧的 /memory 书签，重定向到合并后的单页对应区块
    if (url.pathname === '/memory' && req.method === 'GET') {
      res.writeHead(302, { Location: `/?token=${encodeURIComponent(token)}#sec-memory` });
      res.end();
      return;
    }

    if (await handleConfigRoute(req, res, url)) return;
    if (await handleMemoryRoute(req, res, url)) return;

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }
}
