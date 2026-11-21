import fs from 'fs';
import path from 'path';
import { printError, printLog } from './print';

export function loadConfigFile(file: string) {
  const filePath = path.resolve(file);

  if (!fs.existsSync(filePath)) {
    const demoPath = path.resolve('config_demo.json');
    if (fs.existsSync(demoPath)) {
      fs.copyFileSync(demoPath, filePath);
      printLog(`[Config] 已生成 ${file}，请修改配置后重新运行程序。`);
      process.exit(0);
    }
    process.exit(1);
  }

  try {
    const json = fs.readFileSync(filePath, { encoding: 'utf8' });
    return JSON.parse(json);
  } catch (e) {
    printError('[Load Config Error]', e);
    process.exit(1);
  }
}
