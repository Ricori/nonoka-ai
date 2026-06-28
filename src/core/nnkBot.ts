import { printError, printLog } from '@/utils/print';
import { getAtCode, getReplyCode } from '@/utils/msgCode';
import { SimpleMessageData } from '@/types/event';
import { NonokaCore } from './nnkCore';

class NonokaBot extends NonokaCore {
  /** 发送类调用：无需等待返回值，但要吞掉断线/超时导致的 reject，避免未捕获异常 */
  private fireCall(method: string, params: Record<string, any>) {
    this.nonokaWS.call(method, params).catch((e) => printError(`[WS Call Error][${method}] ${e}`));
  }

  /** 处理好友请求 */
  setFriendAddRequest(flag: string | number, approve: boolean) {
    this.fireCall('set_friend_add_request', { flag: `${flag}`, approve });
  }

  /** 处理拉群请求 */
  setGroupAddRequest(flag: string | number, approve: boolean) {
    this.fireCall('set_group_add_request', {
      flag: `${flag}`,
      type: 'invite',
      approve,
      reason: '没授权呢，请联系Nonoka的主人',
    });
  }

  /** 发送私聊消息
   * @param {number} userId 对方QQ号
   * @param {string} msg 要发送的内容
   * @param {string} plainText 消息内容是否作为纯文本发送
   */
  async sendPrivateMsg(userId: number, msg: string, plainText?: boolean) {
    if (msg.length === 0) return;
    if (this.debugMode) {
      printLog(`[Send Private Msg] ${msg}`);
    }
    this.fireCall('send_private_msg', {
      user_id: userId,
      message: msg,
      auto_escape: !!plainText,
    });
  }

  /** 发送群消息
   * @param {number} groupId 群号
   * @param {string} msg 要发送的内容
   * @param {string} atUser 可选，要at的qq
   * @param {string} plainText 消息内容是否作为纯文本发送
   */
  async sendGroupMsg(groupId: number, msg: string, atUser?: number | string, plainText?: boolean) {
    if (msg.length === 0) return;
    const prefix = atUser ? `${getAtCode(`${atUser}`)} ` : '';
    if (this.debugMode) {
      printLog(`[Send Group Msg] ${prefix}${msg}`);
    }
    this.fireCall('send_group_msg', {
      group_id: groupId,
      message: `${prefix}${msg}`,
      auto_escape: !!plainText,
    });
  }

  /** 发送简单消息 (兼容群聊私聊)
   * @param {number} groupId 群号
   * @param {number} userId 对方QQ号
   * @param {string} msg 要发送的内容
   * @param {string} atUser 可选，要at的qq
   */
  async sendMsg(groupId?: number, userId?: number, msg?: string, atUser?: number | string) {
    if (!msg) return;
    if (groupId) {
      this.sendGroupMsg(groupId, msg, atUser);
    } else if (userId) {
      this.sendPrivateMsg(userId, msg);
    }
  }

  /** 发送群回复消息
   * @param {number} groupId 群号
   * @param {string} msg 要发送的内容
   * @param {string} replyMsgId 要回复的消息id
   */
  async sendGroupReplyMsg(groupId: number, msg: string, replyMsgId: number | string) {
    if (msg.length === 0) return;
    const prefix = `${getReplyCode(replyMsgId)} `;
    if (this.debugMode) {
      printLog(`[Send Group Msg] ${prefix}${msg}`);
    }
    this.fireCall('send_group_msg', {
      group_id: groupId,
      message: prefix + msg,
    });
  }

  /** 发送合并转发
   * @param {number} groupId 对方QQ号
   * @param {object} msg 内容，参照 https://docs.go-cqhttp.org/cqcode
   */
  async sendGroupForwardMsg(groupId: number, msg: any[]) {
    if (msg.length === 0) return;
    if (this.debugMode) {
      printLog('[Send Group Forward Msg]\n', msg);
    }
    this.fireCall('send_group_forward_msg', {
      group_id: groupId,
      messages: msg,
    });
  }

  /** 获取消息
   * @param {string} messageId 消息id
   */
  async getMessageFromId(messageId: number | string) {
    if (!messageId) return;
    const res = await this.nonokaWS.call('get_msg', {
      message_id: messageId,
    });
    if (res.retcode === 0 && res.data) {
      return res.data as SimpleMessageData;
    }
    return undefined;
  }

  /** 撤回消息
   * @param {number} messageId 消息id
   */
  async deleteMsg(messageId: number) {
    this.fireCall('delete_msg', {
      message_id: messageId,
    });
  }

  /** 获取图片信息
   * @param {string} file 图片缓存文件名
   */
  async getImageInfo(file: string) {
    const res = await this.nonokaWS.call('get_image', {
      file,
    });
    if (res.retcode === 0 && res.data) {
      return res.data as { size: number; filename: string; url: string };
    }
    return undefined;
  }
}

export default new NonokaBot();
