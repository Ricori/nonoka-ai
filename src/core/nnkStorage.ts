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
  private latestSNSUpdateTime = new Map<string, number>();

  /** 各 YouTube 频道已推送过的直播 videoId 历史 */
  private ytPushedVideoIds = new Map<string, string[]>();

  /** 每个频道保留的已推送 videoId 数量上限 */
  private static readonly YT_PUSHED_HISTORY_LIMIT = 10;


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
  setBiliLatestDynamicTime(uid: string, time: number) {
    this.latestSNSUpdateTime.set(`bili-${uid}`, time);
  }

  /** 获取某up最新动态时间 */
  getBiliLatestDynamicTime(uid: string) {
    return this.latestSNSUpdateTime.get(`bili-${uid}`) ?? 0;
  }

  /** 设置某推特用户最新推文时间 */
  setTwitterLatestTweetTime(username: string, time: number) {
    this.latestSNSUpdateTime.set(`twitter-${username}`, time);
  }

  /** 获取某推特用户最新推文时间 */
  getTwitterLatestTweetTime(username: string) {
    return this.latestSNSUpdateTime.get(`twitter-${username}`) ?? 0;
  }

  /** 检查某 YouTube 频道是否已推送过该 videoId */
  hasYtPushedVideoId(channelName: string, videoId: string) {
    return this.ytPushedVideoIds.get(channelName)?.includes(videoId) ?? false;
  }

  /** 记录某 YouTube 频道已推送的 videoId */
  addYtPushedVideoId(channelName: string, videoId: string) {
    const list = this.ytPushedVideoIds.get(channelName) ?? [];
    if (list.includes(videoId)) return;
    list.push(videoId);
    if (list.length > NonokaStorage.YT_PUSHED_HISTORY_LIMIT) list.shift();
    this.ytPushedVideoIds.set(channelName, list);
  }
}

export default new NonokaStorage();
