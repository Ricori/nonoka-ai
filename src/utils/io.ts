import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { printError, printLog } from './print';


export async function downloadFile(
  url: string,
  destDir: string,
  filename: string,
  options: { retries?: number; retryDelay?: number; timeoutMs?: number } = {},
): Promise<string> {
  const { retries = 3, retryDelay = 3000, timeoutMs = 180000 } = options;
  const destPath = path.resolve(destDir, filename);

  if (fs.existsSync(destPath)) {
    printLog(`[Download] File already exists, skipping: ${destPath}`);
    return destPath;
  }

  fs.mkdirSync(path.resolve(destDir), { recursive: true });

  const tmpPath = `${destPath}.tmp`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      printLog(`[Download] Attempt ${attempt}/${retries}: ${filename}`);
      const response = await axios.get(url, {
        responseType: 'stream',
        timeout: timeoutMs,
      });

      const totalBytes = parseInt(response.headers['content-length'] ?? '0', 10);
      let downloadedBytes = 0;
      let lastLoggedPercent = -1;

      await new Promise<void>((resolve, reject) => {
        const writer = fs.createWriteStream(tmpPath);
        response.data.on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length;
          if (totalBytes > 0) {
            const percent = Math.floor((downloadedBytes / totalBytes) * 100);
            if (percent !== lastLoggedPercent && percent % 20 === 0) {
              lastLoggedPercent = percent;
              printLog(`[Download] ${filename}: ${percent}% (${(downloadedBytes / 1024 / 1024).toFixed(2)} MB / ${(totalBytes / 1024 / 1024).toFixed(2)} MB)`);
            }
          }
        });
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
        response.data.on('error', reject);
      });

      fs.renameSync(tmpPath, destPath);
      printLog(`[Download] Done: ${destPath}`);
      return destPath;
    } catch (err: any) {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      printError(`[Download] Attempt ${attempt} failed: ${filename} -`, err.message);
      if (attempt < retries) {
        await new Promise((r) => { setTimeout(r, retryDelay); });
      } else {
        throw new Error(`[Download] Failed after ${retries} retries: ${filename}`);
      }
    }
  }

  throw new Error('[Download] Unexpected error');
}

export function loadConfigFile(file: string) {
  const filePath = path.resolve(file);

  if (!fs.existsSync(filePath)) {
    const demoPath = path.resolve('config_demo.json');
    if (fs.existsSync(demoPath)) {
      fs.copyFileSync(demoPath, filePath);
      printLog(`[Config] 已从生成 ${file}，请修改配置后重新运行程序。`);
      process.exit(0);
    }
    process.exit(1);
  }

  try {
    const json = fs.readFileSync(filePath, { encoding: 'utf8' });
    const config = JSON.parse(json);
    return config;
  } catch (e) {
    printError('[Load Config Error]', e);
    process.exit(1);
  }
}
