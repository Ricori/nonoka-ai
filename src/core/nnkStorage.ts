interface RepeaterLog {
  msg: string;
  times: number;
  done: boolean;
}

class NonokaStorage {
  /** 自动同意好友请求的名单 */
  private toBeAddedList = new Set<number>();

  /** 复读记录 */
  private repeaterData = new Map<number, RepeaterLog>();

  joinToBeAddedList = (userId: number) => { this.toBeAddedList.add(userId); };

  getIsInToBeAddedList = (userId: number) => this.toBeAddedList.has(userId);

  deleteIdFromToBeAddedList = (userId: number) => { this.toBeAddedList.delete(userId); };

  saveRepeaterLog(groupId: number, msg: string) {
    const logObj = this.repeaterData.get(groupId);
    if (!logObj || logObj.msg !== msg) {
      this.repeaterData.set(groupId, { msg, times: 1, done: false });
      return 1;
    }
    if (logObj.done) return 0;
    logObj.times += 1;
    return logObj.times;
  }

  setRepeaterDone(groupId: number) {
    const logObj = this.repeaterData.get(groupId);
    if (logObj) logObj.done = true;
  }
}

export default new NonokaStorage();
