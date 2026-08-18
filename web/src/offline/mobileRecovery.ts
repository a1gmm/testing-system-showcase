export type RecoveryAction='recheck_rules'|'rebuild_draft'|'correct_fields'|'reauthenticate'|'retry_query'|'contact_admin'
const actions:Record<string,RecoveryAction>={RULE_VERSION_RETIRED:'recheck_rules',TASK_VERSION_CONFLICT:'rebuild_draft',RULE_VALIDATION_FAILED:'correct_fields',OFFLINE_ASSIGNEE_REQUIRED:'reauthenticate',DEVICE_PROOF_REPLAY:'retry_query'}
export function recoveryActionFor(error:unknown):RecoveryAction{
  const value=error as any,code=String(value?.response?.data?.error_code??value?.error_code??value?.code??'')
  return actions[code]??'contact_admin'
}
export function recoveryText(action:RecoveryAction){return({recheck_rules:'规则版本已撤销，请联网取得新规则并重新检查。',rebuild_draft:'任务内容已变化，旧草稿会封存，请在新草稿中选择性复制。',correct_fields:'服务端规则检查未通过，请修正标出的字段。',reauthenticate:'当前派工或登录已失效，请重新认证。',retry_query:'请求结果未知，请查询回执，不要重复创建。',contact_admin:'操作未完成；本机数据已保留，请联系管理员查看错误码。'} as const)[action]}
