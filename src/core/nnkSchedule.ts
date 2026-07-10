import { ToadScheduler, SimpleIntervalJob } from 'toad-scheduler';
import { printLog } from '../utils/print';

/** 带启动初始化的定时任务定义 */
export interface NonokaJob {
  job: SimpleIntervalJob;
  /** 可选的启动初始化，任务加载时执行一次 */
  init?: () => void;
}

class NnkSchedule {
  private scheduler = new ToadScheduler();

  loadJob(list: (SimpleIntervalJob | NonokaJob)[]) {
    let count = 0;
    list.forEach((item) => {
      const { job, init } = item instanceof SimpleIntervalJob ? { job: item, init: undefined } : item;
      try {
        init?.();
        this.scheduler.addSimpleIntervalJob(job);
        count += 1;
      } catch (error) {
        printLog('[NonokaSchedule] Scheduled task Add Error.');
      }
    });
    printLog(`[NonokaSchedule] Successfully added ${count} scheduled tasks.`);
  }

  getById(id: string) {
    return this.scheduler.getById(id);
  }

  startById(id: string) {
    this.scheduler.startById(id);
  }

  stopById(id: string) {
    this.scheduler.stopById(id);
  }

  stopAll() {
    this.scheduler.stop();
  }

  removeById(id: string) {
    return this.scheduler.removeById(id);
  }
}

export default new NnkSchedule();
