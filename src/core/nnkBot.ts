import { printError, printLog } from '@/utils/print';
import { getAtCode, getReplyCode } from '@/utils/msgCode';
import { SimpleMessageData } from '@/types/event';
import { GroupJoinRequest, WSActionRes } from '@/types/ws';
import { NonokaCore } from './nnkCore';

class NonokaBot extends NonokaCore {
  /** 统一调用入口 */
  private async invoke(method: string, params: Record<string, any>, timeout?: number): Promise<WSActionRes | undefined> {
    try {
      const res = await this.nonokaWS.call(method, params, timeout);
      if (res.retcode === 0) return res;
      printError(`[WS Call Fail][${method}] ${res.wording || res.message || res.msg || res.retcode}`);
    } catch (e) {
      printError(`[WS Call Error][${method}] ${e}`);
    }
    return undefined;
  }

  /** 只关心成功与否的调用 */
  private async callOk(method: string, params: Record<string, any>) {
    return (await this.invoke(method, params)) !== undefined;
  }

  /** 需要返回数据的调用，失败或无数据返回 undefined */
  private async callData<T>(method: string, params: Record<string, any>, timeout?: number): Promise<T | undefined> {
    const res = await this.invoke(method, params, timeout);
    return res?.data ?? undefined;
  }

  /** 处理好友请求 */
  async setFriendAddRequest(flag: string | number, approve: boolean) {
    return this.callOk('set_friend_add_request', { flag: `${flag}`, approve });
  }

  /** 处理加群请求/邀请
   * @param {string} flag 请求 flag（加群申请用 GroupJoinRequest.request_id）
   * @param {boolean} approve 是否同意
   * @param {string} type add 为他人申请加群，invite 为邀请 bot 入群
   * @param {string} reason 拒绝理由
   */
  async setGroupAddRequest(
    flag: string | number,
    approve: boolean,
    type: 'add' | 'invite' = 'invite',
    reason = type === 'invite' ? '没授权呢，请联系Nonoka的主人' : '',
  ) {
    return this.callOk('set_group_add_request', {
      flag: `${flag}`, type, approve, reason,
    });
  }

  /** 发送私聊消息
   * @param {number} userId 对方QQ号
   * @param {string} msg 要发送的内容
   * @param {boolean} plainText 消息内容是否作为纯文本发送
   * @returns 成功返回 message_id
   */
  async sendPrivateMsg(userId: number, msg: string, plainText?: boolean): Promise<number | undefined> {
    if (!msg) return undefined;
    if (this.debugMode) printLog(`[Send Private Msg] ${msg}`);
    const data = await this.callData<{ message_id: number }>('send_private_msg', {
      user_id: userId,
      message: msg,
      auto_escape: !!plainText,
    });
    return data?.message_id;
  }

  /** 发送群消息
   * @param {number} groupId 群号
   * @param {string} msg 要发送的内容
   * @param {string} atUser 可选，要at的qq
   * @param {boolean} plainText 消息内容是否作为纯文本发送
   * @returns 成功返回 message_id
   */
  async sendGroupMsg(groupId: number, msg: string, atUser?: number | string, plainText?: boolean): Promise<number | undefined> {
    if (!msg) return undefined;
    const prefix = atUser ? `${getAtCode(`${atUser}`)} ` : '';
    if (this.debugMode) printLog(`[Send Group Msg] ${prefix}${msg}`);
    const data = await this.callData<{ message_id: number }>('send_group_msg', {
      group_id: groupId,
      message: `${prefix}${msg}`,
      auto_escape: !!plainText,
    });
    return data?.message_id;
  }

  /** 发送简单消息 (兼容群聊私聊，有 groupId 时发群)
   * @param {number} groupId 群号
   * @param {number} userId 对方QQ号
   * @param {string} msg 要发送的内容
   * @param {string} atUser 可选，要at的qq（仅群聊）
   * @returns 成功返回 message_id
   */
  async sendMsg(groupId?: number, userId?: number, msg?: string, atUser?: number | string) {
    if (!msg) return undefined;
    if (groupId) return this.sendGroupMsg(groupId, msg, atUser);
    if (userId) return this.sendPrivateMsg(userId, msg);
    return undefined;
  }

  /** 发送群回复消息
   * @param {number} groupId 群号
   * @param {string} msg 要发送的内容
   * @param {string} replyMsgId 要回复的消息id
   * @returns 成功返回 message_id
   */
  async sendGroupReplyMsg(groupId: number, msg: string, replyMsgId: number | string) {
    if (!msg) return undefined;
    return this.sendGroupMsg(groupId, `${getReplyCode(replyMsgId)} ${msg}`);
  }

  /** 发送群合并转发
   * @param {number} groupId 群号
   * @param {object} msg 转发节点数组，参照 https://docs.go-cqhttp.org/cqcode
   * @returns 成功返回 message_id
   */
  async sendGroupForwardMsg(groupId: number, msg: any[]): Promise<number | undefined> {
    if (msg.length === 0) return undefined;
    if (this.debugMode) printLog('[Send Group Forward Msg]\n', msg);
    const data = await this.callData<{ message_id: number }>('send_group_forward_msg', {
      group_id: groupId,
      messages: msg,
    });
    return data?.message_id;
  }

  /** 获取消息
   * @param {string} messageId 消息id
   */
  async getMessageFromId(messageId: number | string) {
    if (!messageId) return undefined;
    return this.callData<SimpleMessageData>('get_msg', { message_id: messageId });
  }

  /** 撤回消息
   * @param {number} messageId 消息id
   */
  async deleteMsg(messageId: number | string) {
    return this.callOk('delete_msg', { message_id: messageId });
  }

  /** 获取图片信息
   * @param {string} file 图片缓存文件名
   */
  async getImageInfo(file: string) {
    return this.callData<{ size: number; filename: string; url: string }>('get_image', { file });
  }

  /** 设置消息表情回应
   * @param {number} messageId 消息id
   * @param {number} emojiId 表情id，参照 QQ 表情 id 表
   * @param {boolean} set true 点上，false 取消
   */
  async setMsgEmojiLike(messageId: number | string, emojiId: number | string, set = true) {
    return this.callOk('set_msg_emoji_like', { message_id: messageId, emoji_id: emojiId, set });
  }

  /** 获取加群申请（来自群系统消息）
   * @param {number} groupId 可选，只返回该群的申请
   * @param {number} count 拉取的系统消息条数
   * @returns 失败返回 undefined
   */
  async getGroupJoinRequests(groupId?: number, count = 50) {
    const data = await this.callData<{ join_requests?: GroupJoinRequest[] }>('get_group_system_msg', { count });
    if (!data) return undefined;
    const list = data.join_requests ?? [];
    return groupId ? list.filter((r) => r.group_id === groupId) : list;
  }

  /** 群组踢人
   * @param {number} groupId 群号
   * @param {number} userId 要踢的QQ号
   * @param {boolean} rejectAddRequest 是否拒绝此人再次加群
   */
  async setGroupKick(groupId: number, userId: number, rejectAddRequest = false) {
    return this.callOk('set_group_kick', { group_id: groupId, user_id: userId, reject_add_request: rejectAddRequest });
  }

  /** 群组单人禁言
   * @param {number} groupId 群号
   * @param {number} userId 要禁言的QQ号
   * @param {number} duration 禁言秒数，0 为解除禁言
   */
  async setGroupBan(groupId: number, userId: number, duration: number) {
    return this.callOk('set_group_ban', { group_id: groupId, user_id: userId, duration });
  }

  /** 设置群名片
   * @param {number} groupId 群号
   * @param {number} userId 成员QQ号
   * @param {string} card 新名片，空字符串为删除名片
   */
  async setGroupCard(groupId: number, userId: number, card: string) {
    return this.callOk('set_group_card', { group_id: groupId, user_id: userId, card });
  }

  /** 上传群文件
   * @param {number} groupId 群号
   * @param {string} file 本地绝对路径 / URL / base64://
   * @param {string} name 群文件中显示的文件名
   * @param {string} folder 可选，目标文件夹id，默认根目录
   * @returns 成功返回 file_id
   */
  async uploadGroupFile(groupId: number, file: string, name: string, folder?: string) {
    const data = await this.callData<{ file_id: string | null }>('upload_group_file', {
      group_id: groupId,
      file,
      name,
      upload_file: true,
      ...(folder ? { folder } : {}),
    }, 5 * 60 * 1000);
    return data?.file_id ?? undefined;
  }
}

export default new NonokaBot();
