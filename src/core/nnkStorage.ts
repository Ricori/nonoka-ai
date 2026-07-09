interface RepeaterLog {
  msg: string,
  times: number,
  done: boolean,
}

class NonokaStorage {
  /** 自动同意好友请求的名单  */
  private toBeAddedList = new Set<number>();

  /** 复读记录  */
  private repeaterData = new Map<number, RepeaterLog>();

  /** 各平台最新内容时间 (key: "bili-{uid}" | "twitter-{username}") */
  private lastestSNSUpdateTime = new Map<string, number>();

  /** 各 YouTube 频道上次已推送直播的 videoId，用于判断是否是新的一场直播 */
  private ytLastPushedVideoId = new Map<string, string>();


  /** 新增好友到待添加名单 */
  joinToBeAddedList = (userId: number) => { this.toBeAddedList.add(userId); };

  /** 检查是否在待添加的好友名单中 */
  getIsInToBeAddedList = (userId: number) => this.toBeAddedList.has(userId);

  /** 在待添加的好友名单中删除某用户 */
  deleteIdFromToBeAddedList = (userId: number) => { this.toBeAddedList.delete(userId); };

  /** 记录某群复读情况
   * @param {number} groupId 群号
   * @param {string} msg 消息
   * @returns 如果已经复读则返回0，否则返回当前复读次数
   */
  saveRepeaterLog(groupId: number, msg: string) {
    const logObj = this.repeaterData.get(groupId);
    // 没有记录或另起复读则新建记录
    if (!logObj || logObj.msg !== msg) {
      const newLog: RepeaterLog = { msg, times: 1, done: false };
      this.repeaterData.set(groupId, newLog);
      return 1;
    }
    // 已经复读过则跳过
    if (logObj.done) return 0;
    logObj.times += 1;
    return logObj.times;
  }

  /** 标记某群已复读
   *  @param {number} groupId 群号
  */
  setRepeaterDone(groupId: number) {
    const logObj = this.repeaterData.get(groupId);
    if (logObj) {
      logObj.done = true;
    }
  }

  /** 设置某up最新动态时间 */
  setBiliLastestDynamicTime(uid: string, time: number) {
    this.lastestSNSUpdateTime.set(`bili-${uid}`, time);
  }

  /** 获取某up最新动态时间 */
  getBiliLastestDynamicTime(uid: string) {
    return this.lastestSNSUpdateTime.get(`bili-${uid}`) ?? 0;
  }

  /** 设置某推特用户最新推文时间 */
  setTwitterLastestTweetTime(username: string, time: number) {
    this.lastestSNSUpdateTime.set(`twitter-${username}`, time);
  }

  /** 获取某推特用户最新推文时间 */
  getTwitterLastestTweetTime(username: string) {
    return this.lastestSNSUpdateTime.get(`twitter-${username}`) ?? 0;
  }

  /** 设置某 YouTube 频道上次已推送直播的 videoId */
  setYtLastPushedVideoId(channelId: string, videoId: string) {
    this.ytLastPushedVideoId.set(channelId, videoId);
  }

  /** 获取某 YouTube 频道上次已推送直播的 videoId */
  getYtLastPushedVideoId(channelId: string) {
    return this.ytLastPushedVideoId.get(channelId);
  }

  /** 清除某 YouTube 频道的推送记录（下播后调用，以便下次开播能重新推送） */
  clearYtLastPushedVideoId(channelId: string) {
    this.ytLastPushedVideoId.delete(channelId);
  }
}

export default new NonokaStorage();
