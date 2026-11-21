import { ToadScheduler, SimpleIntervalJob, CronJob } from 'toad-scheduler';
import { printLog } from '@/utils/print';

export interface ScheduledJob {
  job: SimpleIntervalJob | CronJob;
  init?: () => void;
}

class TaskScheduler {
  private scheduler = new ToadScheduler();

  loadJob(list: (SimpleIntervalJob | CronJob | ScheduledJob)[]) {
    let count = 0;
    list.forEach((item) => {
      const direct = item instanceof SimpleIntervalJob || item instanceof CronJob;
      const { job, init } = direct ? { job: item, init: undefined } : item;
      try {
        init?.();
        if (job instanceof CronJob) this.scheduler.addCronJob(job);
        else this.scheduler.addSimpleIntervalJob(job);
        count += 1;
      } catch {
        printLog('[Scheduler] Scheduled task add error.');
      }
    });
    printLog(`[Scheduler] Successfully added ${count} scheduled tasks.`);
  }

  stopAll() {
    this.scheduler.stop();
  }
}

export default new TaskScheduler();
