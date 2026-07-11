import nnkbot from '@/core/nnkBot';
import { EventKind, ModuleContext, NonokaModule } from '@/core/nnkModule';
import { GroupMessageData } from '@/types/event';
import { extractCQCodes, hasCQCode } from '@/utils/msgCode';
import { printError, printLog } from '@/utils/print';
import { sleep } from '@/utils/function';
import { getJobProgress, initGithubConfig, startTransfer } from './transfer';

/** match 命中时传递给 run 的文件信息 */
interface FileHit {
  file: string;
  fileSize?: string;
  url: string;
}

class YkhrOnedriveModule extends NonokaModule<GroupMessageData, FileHit> {
  readonly name = 'YkhrOnedriveModule';

  readonly events: EventKind[] = ['group:plain'];

  /** 启动时校验 github 配置，未配置则中止启动 */
  init() {
    initGithubConfig();
  }

  match(ctx: ModuleContext<GroupMessageData>): FileHit | false {
    const { message, group_id: groupId } = ctx.data;

    // 只在配置的群生效
    if (!nnkbot.config.ykhrOneDrive.groupIds.includes(groupId)) return false;

    // 检查文件消息
    if (hasCQCode(message, 'file')) {
      if (message.includes('待轴') || message.includes('熟肉')) {
        const fileObj = extractCQCodes(message).find((cq) => cq.type === 'file');
        if (fileObj) {
          return {
            file: fileObj.data.get('file') as string,
            fileSize: fileObj.data.get('file_size'),
            url: fileObj.data.get('url') as string,
          };
        }
      }
    }

    return false;
  }

  async run(ctx: ModuleContext<GroupMessageData>, hit: FileHit) {
    const { file, fileSize, url } = hit;

    if (fileSize && (Number(fileSize) > 1024 * 1024 * 1024)) {
      ctx.reply(`文件“${file}”(${(Number(fileSize) / (1024 * 1024)).toFixed(2)} MB) 过大，无法处理`, { at: true });
      return;
    }

    ctx.reply(`开始处理“${file}”(${(Number(fileSize) / (1024 * 1024)).toFixed(2)} MB)...`, { at: true });

    const parentPath = file.includes('待轴') ? '/剪辑' : '/全熟已压';
    const inputs = {
      file_url: url,
      file_name: file,
      target_folder: parentPath,
    };

    const runId = await startTransfer(inputs);
    if (!runId) {
      ctx.reply(`“${file}”上传 OneDrive 任务创建失败，请联系管理员。`, { at: true });
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
      ctx.reply(`“${file}”任务超时，请联系管理员。`, { at: true });
      return;
    }
    if (!isSuccess) {
      printError(`[Github Transfer][${file}] Task failed.`);
      ctx.reply(`上传 “${file}”到 OneDrive 失败，请联系管理员。`, { at: true });
      return;
    }

    ctx.reply(`“${file}”已成功上传至 OneDrive${parentPath} 目录。`, { at: true });
  }
}

export default new YkhrOnedriveModule();
