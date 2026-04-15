import axios, { AxiosError } from 'axios';
import path from 'path';
import fs from 'fs';
import { printError, printLog } from '../../../utils/print';
import { sleep } from '../../../utils/function';

interface TransferInputs {
  file_url: string;
  file_name: string;
  target_folder?: string;
}

interface GithubConfig {
  owner: string;
  repo: string;
  workflowFile: string;
  token: string;
}

interface ProgressInfo {
  status: 'queued' | 'in_progress' | 'completed' | 'unknown';
  conclusion?: string | null;
  stepName?: string;
  html_url?: string;
}

const CONFIG_FILE_NAME = 'config_github.json';
const CONFIG_PATH = path.join(process.cwd(), CONFIG_FILE_NAME);

let githubConfig: GithubConfig;

export function initGithubConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const defaultConfig: GithubConfig = {
      owner: 'YOUR_GITHUB_USERNAME',
      repo: 'YOUR_PRIVATE_REPO_NAME',
      workflowFile: 'transfer.yml',
      token: 'YOUR_PERSONAL_ACCESS_TOKEN',
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2), 'utf8');
    printLog(`[Github Transfer] 配置文件已自动创建: ${CONFIG_PATH}`);
    printLog('[Github Transfer] 请打开该文件，填入你的真实 GitHub 信息后，再次运行本程序！');
    process.exit(1);
  }
  try {
    const rawData = fs.readFileSync(CONFIG_PATH, 'utf8');
    const config = JSON.parse(rawData) as GithubConfig;
    if (config.owner === 'YOUR_GITHUB_USERNAME' || config.token.includes('YOUR_PERSONAL_ACCESS_TOKEN')) {
      printLog('[Github Transfer] 检测到你尚未修改默认配置！');
      printLog(`[Github Transfer] 请先打开 ${CONFIG_FILE_NAME} 填入真实的 GitHub 信息。`);
      process.exit(1);
    }
    githubConfig = config;
  } catch (error) {
    printError(`[Github Transfer] 读取或解析配置文件失败: ${(error as Error).message}\n`);
    process.exit(1);
  }
}


function createGithubClient(token: string) {
  return axios.create({
    baseURL: 'https://api.github.com',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2026-03-10',
    },
  });
}

async function triggerWorkflow(config: GithubConfig, inputs: TransferInputs, branch: string = 'main') {
  const client = createGithubClient(config.token);
  const url = `/repos/${config.owner}/${config.repo}/actions/workflows/${config.workflowFile}/dispatches`;

  try {
    await client.post(url, {
      ref: branch,
      inputs: {
        file_url: inputs.file_url,
        file_name: inputs.file_name,
        target_folder: inputs.target_folder || '/test',
      },
    });
  } catch (error) {
    const err = error as AxiosError;
    printError('[Github Transfer] Error:', err.response?.data || err.message);
    throw new Error('Workflow Error.');
  }
}


async function getLatestRunId(config: GithubConfig, triggerTime: Date): Promise<number | null> {
  const client = createGithubClient(config.token);
  const url = `/repos/${config.owner}/${config.repo}/actions/workflows/${config.workflowFile}/runs`;
  try {
    const response = await client.get(url, {
      params: { event: 'workflow_dispatch', per_page: 5 },
    });
    const runs = response.data.workflow_runs;

    // 匹配触发时间之后创建的最新任务 (允许 10 秒时间差)
    const latestRun = runs.find((run: any) => {
      const runCreateTime = new Date(run.created_at).getTime();
      return runCreateTime >= triggerTime.getTime() - 10000;
    });

    return latestRun ? latestRun.id : null;
  } catch (error) {
    printError('[Github Transfer] Error: Failed to get Run ID.', (error as AxiosError).message);
    return null;
  }
}


export async function getJobProgress(runId: number): Promise<ProgressInfo> {
  if (!githubConfig) return { status: 'unknown' };
  const client = createGithubClient(githubConfig.token);
  const runUrl = `/repos/${githubConfig.owner}/${githubConfig.repo}/actions/runs/${runId}`;
  const jobsUrl = `${runUrl}/jobs`;

  try {
    // 先查询整体状态
    const runRes = await client.get(runUrl);
    const { status, conclusion, html_url } = runRes.data;

    // 如果已完成，直接返回结果
    if (status === 'completed') {
      return { status: 'completed', conclusion, html_url };
    }

    // 如果正在执行，深入查询当前进行到了哪一步 (Job/Step)
    if (status === 'in_progress') {
      const jobsRes = await client.get(jobsUrl);
      const { jobs } = jobsRes.data;

      let stepName = 'unknown';
      if (jobs && jobs.length > 0) {
        const currentStep = jobs[0].steps.find((step: any) => step.status === 'in_progress');
        if (currentStep) {
          stepName = currentStep.name;
        }
      }
      return { status: 'in_progress', stepName, html_url };
    }

    // 其他状态通常是 queued (排队中) 或 waiting
    return { status: status || 'queued', html_url };
  } catch (error) {
    return { status: 'unknown' };
  }
}

export async function startTransfer(inputs: TransferInputs) {
  if (!githubConfig) {
    initGithubConfig();
  }
  const triggerTime = new Date();
  try {
    await triggerWorkflow(githubConfig, inputs);
    printLog(`[Github Transfer][${inputs.file_name}] Transfer trigger request sent successfully!`);
    await sleep(5000);
    let runId = await getLatestRunId(githubConfig, triggerTime);
    let findRetries = 3;
    while (!runId && findRetries > 0) {
      await sleep(3000);
      runId = await getLatestRunId(githubConfig, triggerTime);
      findRetries--;
    }
    if (!runId) {
      printError(`[Github Transfer][${inputs.file_name}] Error: Unable to find the latest instance RunID. Please check.`);
      return null;
    }
    return runId;
  } catch (error) {
    return null;
  }
}
