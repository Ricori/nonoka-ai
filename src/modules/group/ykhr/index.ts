import { GroupMessageData } from '@/types/event';
import NonokaModuleBase from '@/modules/base';
import nnkbot from '@/core/nnkBot';
import { extractCQCodes, hasCQCode } from '@/utils/msgCode';
import { printError, printLog } from '@/utils/print';
import { sleep } from '@/utils/function';
import { getJobProgress, initGithubConfig, startTransfer } from './transfer';

export default class YkhrOnedriveModule extends NonokaModuleBase<GroupMessageData> {
  static NAME = 'YkhrOnedriveModule';

  /** 启动时校验 github 配置，未配置则中止启动 */
  static init = initGithubConfig;

  async checkConditions() {
    const { message, group_id: groupId } = this.data;

    // 只在 YKHR 群和测试群生效
    if (groupId !== 930639183 && groupId !== 829349264) return false;

    // 检查文件消息
    if (hasCQCode(message, 'file')) {
      if (message.includes('待轴') || message.includes('熟肉')) {
        return true;
      }
    }

    return false;
  }


  async run() {
    const { message, group_id: groupId, user_id: userId } = this.data;

    const cqObjs = extractCQCodes(message);
    const fileObj = cqObjs.find((cq) => cq.type === 'file');
    if (fileObj) {
      const file = fileObj.data.get('file') as string;
      const fileSize = fileObj.data.get('file_size');
      const url = fileObj.data.get('url') as string;

      if (fileSize && (Number(fileSize) > 1024 * 1024 * 1024)) {
        nnkbot.sendGroupMsg(groupId, `文件“${file}”(${(Number(fileSize) / (1024 * 1024)).toFixed(2)} MB) 过大，无法处理`, userId);
        return;
      }

      nnkbot.sendGroupMsg(groupId, `开始处理“${file}”(${(Number(fileSize) / (1024 * 1024)).toFixed(2)} MB)...`, userId);

      const parentPath = file.includes('待轴') ? '/剪辑' : '/全熟已压';
      const inputs = {
        file_url: url,
        file_name: file,
        target_folder: parentPath,
      };

      const runId = await startTransfer(inputs);
      if (!runId) {
        nnkbot.sendGroupMsg(groupId, `“${file}”上传 OneDrive 任务创建失败，请联系管理员。`, userId);
        return;
      }

      printLog(`[Github Transfer][${file}] Start monitoring task execution progress (Run ID: ${runId})...`);

      let isCompleted = false;
      let isSuccess = false;
      let retryCount = 0;
      while (!isCompleted && retryCount < 20) {
        const progress = await getJobProgress(runId);
        switch (progress.status) {
          case 'completed':
            isCompleted = true;
            if (progress.conclusion === 'success') {
              printLog(`[Github Transfer][${file}] Task successful.`);
              isSuccess = true;
            } else {
              isSuccess = false;
              printError(`[Github Transfer][${file}] Task execution failed. ${progress.conclusion}.`);
            }
            break;
          case 'in_progress':
            printLog(`[Github Transfer][${file}] Current execution progress: [${progress.stepName}] (Time elapsed ${retryCount * 30} seconds)...`);
            break;
          case 'queued':
            printLog(`[Github Transfer][${file}] Current status: GitHub is queuing to allocate servers...`);
            break;
          default:
            printLog(`[Github Transfer][${file}] Current status: ${progress.status}`);
            break;
        }
        if (!isCompleted) {
          retryCount++;
          await sleep(30000);
        }
      }

      if (!isCompleted) {
        printError(`[Github Transfer][${file}] Task timeout.`);
        nnkbot.sendGroupMsg(groupId, `“${file}”任务超时，请联系管理员。`, userId);
        return;
      }
      if (!isSuccess) {
        printError(`[Github Transfer][${file}] Task failed.`);
        nnkbot.sendGroupMsg(groupId, `上传 “${file}”到 OneDrive 失败，请联系管理员。`, userId);
        return;
      }

      nnkbot.sendGroupMsg(groupId, `“${file}”已成功上传至 OneDrive${parentPath} 目录。`, userId);
    }
  }
}
