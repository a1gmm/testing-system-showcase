import type { DB } from './db.ts'
import { ensureSampleSlots } from './mobileSampleSlots.ts'

export class OfflineRuleError extends Error {
  readonly code:string
  readonly errorCode:string
  readonly httpStatus:number
  readonly httpCode:number
  constructor(code:string,httpStatus:number,message:string){super(message);this.code=code;this.errorCode=code;this.httpStatus=httpStatus;this.httpCode=httpStatus}
}

const globalFields=['org','orgSign','samplingDate'] as const
const rowFields=['sampleSlotId','sampleNo','point','time','item','volume','preserve','waterColor','smell','oil','floating','anomaly','note'] as const
const exact=(value:unknown,fields:readonly string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&JSON.stringify(Object.keys(value as object).sort())===JSON.stringify([...fields].sort())

export function activeOfflineRuleVersion(db:DB,formCode='HJ-TC-136'){
  const row=db.prepare(`SELECT rule_version FROM offline_rule_versions WHERE form_code=? AND status='active' ORDER BY updated_at DESC,rule_version DESC LIMIT 1`).get(formCode) as any
  if(!row)throw new OfflineRuleError('RULE_VERSION_RETIRED',409,'当前规则版本已撤销，请联网重新检查')
  return String(row.rule_version)
}

export function setOfflineRuleStatus(db:DB,ruleVersion:string,status:'active'|'retired',reason=''){
  const result=db.prepare(`UPDATE offline_rule_versions SET status=?,reason=?,updated_at=? WHERE rule_version=?`).run(status,reason,new Date().toISOString(),ruleVersion) as any
  if(!result.changes)throw new OfflineRuleError('RULE_VERSION_UNKNOWN',409,'规则版本不存在')
}

export function frozenValidationScope(db:DB,roundId:string){
  const round=db.prepare(`SELECT items,plan_date,due_date FROM rounds WHERE id=?`).get(roundId) as any
  if(!round)throw new OfflineRuleError('ROUND_NOT_FOUND',404,'监测期次不存在')
  let items:any[]=[];try{items=JSON.parse(round.items||'[]')}catch{throw new OfflineRuleError('TASK_VERSION_CONFLICT',409,'任务样品计划损坏')}
  const sampleSlotIds=ensureSampleSlots(db,roundId,items).map(slot=>slot.sampleSlotId)
  return{sampleSlotIds,samplingDate:round.plan_date||round.due_date}
}

export function validateFrozenSubmission(db:DB,ruleVersion:string,payload:any,scope:{sampleSlotIds:string[];samplingDate:string}){
  const rule=db.prepare(`SELECT form_code,status FROM offline_rule_versions WHERE rule_version=?`).get(ruleVersion) as any
  if(!rule||rule.status!=='active')throw new OfflineRuleError('RULE_VERSION_RETIRED',409,'该规则版本已撤销，请重新检查')
  if(rule.form_code!=='HJ-TC-136'||payload?.formCode!==rule.form_code||!Number.isInteger(payload?.draftRevision)||!exact(payload.global,globalFields)||!Array.isArray(payload.rows)||payload.rows.some((row:unknown)=>!exact(row,rowFields))){
    throw new OfflineRuleError('RULE_VALIDATION_FAILED',422,'冻结表单结构不符合规则版本')
  }
  const submittedSlots=payload.rows.map((row:any)=>row.sampleSlotId)
  if(JSON.stringify(submittedSlots)!==JSON.stringify(scope.sampleSlotIds)||new Set(submittedSlots).size!==submittedSlots.length)throw new OfflineRuleError('TASK_VERSION_CONFLICT',409,'样品槽位已变化')
  if(payload.global.samplingDate!==scope.samplingDate||payload.rows.some((row:any)=>typeof row.point!=='string'||!row.point.trim()||typeof row.time!=='string'||!row.time.trim()||typeof row.item!=='string'||!row.item.trim())){
    throw new OfflineRuleError('RULE_VALIDATION_FAILED',422,'现场记录存在必填或日期错误')
  }
  return{ruleVersion}
}
