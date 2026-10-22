export interface WSActionRes {
  /** 状态, 表示 API 是否调用成功, 如果成功, 则是 OK */
  status: string,
  /** 状态码 */
  retcode: number,
  /** 错误消息(go-cqhttp) */
  msg?: string,
  /** 错误消息(NapCat) */
  message?: string,
  /** 对错误的详细解释(中文), 仅在 API 调用失败时有该字段 */
  wording: string,
  /** 响应数据 */
  data: any,
  /** 若请求时指定了 echo, 响应也会包含 echo */
  echo?: string,
}

/** get_group_system_msg 中的一条加群申请 */
export interface GroupJoinRequest {
  /** 处理申请时作为 flag 使用 */
  request_id: number,
  /** 申请人QQ（NapCat 沿用了 invitor 字段名） */
  invitor_uin: number,
  /** 申请人昵称 */
  requester_nick: string,
  group_id: number,
  group_name: string,
  /** 验证消息 */
  message: string,
  /** 是否已处理 */
  checked: boolean,
  /** 处理人QQ，未处理为 0 */
  actor: number,
}
