export interface WSActionRes {
  /** 状态, 表示 API 是否调用成功, 如果成功, 则是 OK */
  status: string,
  /** 状态码 */
  retcode: 0,
  /** 错误消息, 仅在 API 调用失败时有该字段 */
  msg: string,
  /** 对错误的详细解释(中文), 仅在 API 调用失败时有该字段 */
  wording: string,
  /** 响应数据 */
  data: any,
  /** 若请求时指定了 echo, 响应也会包含 echo */
  echo?: string,
}
