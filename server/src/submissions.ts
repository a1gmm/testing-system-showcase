import { createHash, randomUUID } from 'node:crypto'
import type { DB } from './db.ts'
import type { User } from './handlers.ts'
import { frozenValidationScope, validateFrozenSubmission } from './offlineRules.ts'

export type SubmissionStatus = 'pending' | 'finalizing' | 'complete' | 'failed'
export type SubmissionInput = {
  clientSubmissionId: string
  roundId: string
  ownerId: string
  deviceId: string
  taskVersion: string
  ruleVersion: string
  draftRevision: number
  canonicalPayload: string
  payloadHash: string
  attachmentReceipts: string[]
}
export type SubmissionRecord = SubmissionInput & {
  receiptId: string
  status: SubmissionStatus
  publication: Record<string, unknown> | null
  errorCode: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}
export type CreateSubmissionPolicy = {
  managedDeviceId?: string
  expectedTaskVersion: string
  expectedRuleVersion: string
  requestNonce?: { nonce: string; issuedAt: string; expiresAt: string }
  now?: () => Date
  uuid?: () => string
}
function consumeRequestNonce(db: DB, deviceId: string | undefined, proof: CreateSubmissionPolicy['requestNonce']) {
  if (!proof) return
  try { db.prepare(`INSERT INTO device_request_nonces(device_id,nonce,issued_at,expires_at) VALUES(?,?,?,?)`).run(deviceId, proof.nonce, proof.issuedAt, proof.expiresAt) }
  catch (error: any) { if (/device_request_nonces|UNIQUE constraint/.test(error?.message || '')) throw new SubmissionError('DEVICE_PROOF_REPLAY', 409, '设备请求凭证已使用'); throw error }
}
export type FinalizePolicy = {
  now?: () => Date
  publish: (db: DB, submission: SubmissionRecord) => Record<string, unknown>
}

export class SubmissionError extends Error {
  readonly code: string
  readonly httpStatus: number
  readonly errorCode: string
  readonly httpCode: number
  constructor(code: string, httpStatus: number, message: string) { super(message); this.code = code; this.errorCode = code; this.httpStatus = httpStatus; this.httpCode = httpStatus }
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/
const hashPattern = /^[a-f0-9]{64}$/
function parseJson(value: string, fallback: unknown) { try { return JSON.parse(value) } catch { return fallback } }
function canonicalJson(value:unknown):string {
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value)
  if(typeof value==='number'){if(!Number.isFinite(value))throw new SubmissionError('PAYLOAD_NOT_CANONICAL',422,'提交内容包含非有限数值');return JSON.stringify(value)}
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`
  if(typeof value==='object'){const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)throw new SubmissionError('PAYLOAD_NOT_CANONICAL',422,'提交内容对象类型无效');return `{${Object.keys(value as object).sort().map(key=>{const item=(value as any)[key];if(item===undefined)throw new SubmissionError('PAYLOAD_NOT_CANONICAL',422,'提交内容包含未定义字段');return `${JSON.stringify(key)}:${canonicalJson(item)}`}).join(',')}}`}
  throw new SubmissionError('PAYLOAD_NOT_CANONICAL',422,'提交内容包含不支持的值')
}
function rowToRecord(row: any): SubmissionRecord {
  return {
    clientSubmissionId: row.client_submission_id, receiptId: row.receipt_id, roundId: row.round_id,
    ownerId: row.owner_id, deviceId: row.device_id, taskVersion: row.task_version, ruleVersion: row.rule_version,
    draftRevision: row.draft_revision, canonicalPayload: row.canonical_payload, payloadHash: row.payload_hash,
    attachmentReceipts: parseJson(row.attachment_receipts, []) as string[], status: row.status,
    publication: row.publication_json ? parseJson(row.publication_json, null) as Record<string, unknown> | null : null,
    errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
  }
}
function find(db: DB, id: string) { const row = db.prepare(`SELECT * FROM mobile_submissions WHERE client_submission_id=?`).get(id); return row ? rowToRecord(row) : null }
function assertActor(record: SubmissionRecord, actor: User) {
  if (record.ownerId !== actor.username) throw new SubmissionError('SUBMISSION_FORBIDDEN', 403, '无权访问该提交回执')
}
function auditMismatch(db:DB,existing:SubmissionRecord,input:SubmissionInput,actor:User,code:string){const at=new Date().toISOString();db.prepare(`INSERT INTO audit_log(record_id,who,username,action,detail,at) VALUES(?,?,?,?,?,?)`).run(existing.roundId,actor.name,actor.username,'mobile_submission_idempotency_mismatch',JSON.stringify({clientSubmissionId:input.clientSubmissionId,receiptId:existing.receiptId,storedHash:existing.payloadHash,receivedHash:input.payloadHash,code}),at)}
function assertCurrentAssignment(db: DB, input: SubmissionInput, actor: User, managedDeviceId?: string) {
  const round = db.prepare(`SELECT sampler_ids,assignment_status FROM rounds WHERE id=?`).get(input.roundId) as any
  if (!round) throw new SubmissionError('ROUND_NOT_FOUND', 404, '监测期次不存在')
  const assigned = parseJson(round.sampler_ids, []) as string[]
  if (!actor.roles.includes('sampler') || actor.status !== 'active' || round.assignment_status !== 'active' || assigned.filter(id => id === actor.username).length !== 1) throw new SubmissionError('OFFLINE_ASSIGNEE_REQUIRED', 403, '只有当前受派采样员可以提交')
  if (input.ownerId !== actor.username) throw new SubmissionError('SUBMISSION_OWNER_MISMATCH', 403, '提交归属与当前用户不一致')
  if (!managedDeviceId || input.deviceId !== managedDeviceId) throw new SubmissionError('MANAGED_DEVICE_REQUIRED', 403, '当前设备没有可验证的受管设备证明')
}
function validateInput(db: DB, input: SubmissionInput, actor: User, policy: CreateSubmissionPolicy) {
  assertCurrentAssignment(db, input, actor, policy.managedDeviceId)
  if (!idPattern.test(input.clientSubmissionId) || !Number.isInteger(input.draftRevision) || input.draftRevision < 0) throw new SubmissionError('SUBMISSION_INVALID', 422, '提交标识或修订号无效')
  if (input.taskVersion !== policy.expectedTaskVersion) throw new SubmissionError('TASK_VERSION_CONFLICT', 409, '任务版本已变化')
  if (input.ruleVersion !== policy.expectedRuleVersion) throw new SubmissionError('RULE_VERSION_RETIRED', 409, '规则版本已变化')
  if (!hashPattern.test(input.payloadHash) || createHash('sha256').update(input.canonicalPayload).digest('hex') !== input.payloadHash) throw new SubmissionError('PAYLOAD_HASH_INVALID', 422, '提交内容哈希不一致')
  const parsed = parseJson(input.canonicalPayload, null) as any
  if (!parsed || Object.keys(parsed).sort().join(',')!=='draftRevision,formCode,global,rows' || parsed.formCode !== 'HJ-TC-136' || parsed.draftRevision !== input.draftRevision || !Array.isArray(parsed.rows) || !parsed.global || typeof parsed.global!=='object') throw new SubmissionError('SUBMISSION_INVALID', 422, '提交内容不是受支持的冻结表单')
  if(canonicalJson(parsed)!==input.canonicalPayload)throw new SubmissionError('PAYLOAD_NOT_CANONICAL',422,'提交内容不是唯一规范序列化')
  validateFrozenSubmission(db,input.ruleVersion,parsed,frozenValidationScope(db,input.roundId))
  if (!Array.isArray(input.attachmentReceipts) || new Set(input.attachmentReceipts).size !== input.attachmentReceipts.length) throw new SubmissionError('ATTACHMENT_MANIFEST_INVALID', 422, '附件清单无效')
  const now=(policy.now ?? (()=>new Date()))().getTime()
  for (const receiptId of input.attachmentReceipts) {
    const attachment = db.prepare(`SELECT round_id,owner_id,device_id,status,lease_expires_at FROM staged_attachments WHERE receipt_id=?`).get(receiptId) as any
    if (!attachment || attachment.round_id !== input.roundId || attachment.owner_id !== input.ownerId || attachment.device_id !== input.deviceId || attachment.status !== 'uploaded_staged' || Date.parse(attachment.lease_expires_at) <= now) throw new SubmissionError('ATTACHMENT_NOT_READY', 409, '附件尚未完成安全暂存')
  }
}

export function createSubmission(db: DB, input: SubmissionInput, actor: User, policy: CreateSubmissionPolicy): SubmissionRecord {
  const existing = find(db, input.clientSubmissionId)
  if (existing) {
    assertActor(existing, actor)
    if (existing.payloadHash !== input.payloadHash) { auditMismatch(db,existing,input,actor,'IDEMPOTENCY_MISMATCH'); throw new SubmissionError('IDEMPOTENCY_MISMATCH', 409, '提交编号与内容不一致') }
    if (existing.roundId !== input.roundId || existing.ownerId !== input.ownerId || existing.deviceId !== input.deviceId
      || existing.taskVersion !== input.taskVersion || existing.ruleVersion !== input.ruleVersion || existing.draftRevision !== input.draftRevision
      || JSON.stringify(existing.attachmentReceipts) !== JSON.stringify(input.attachmentReceipts)) {
      auditMismatch(db,existing,input,actor,'IDEMPOTENCY_SCOPE_MISMATCH');throw new SubmissionError('IDEMPOTENCY_SCOPE_MISMATCH', 409, '提交编号与授权范围不一致')
    }
    assertCurrentAssignment(db, input, actor, policy.managedDeviceId)
    db.exec('BEGIN IMMEDIATE')
    try { consumeRequestNonce(db, policy.managedDeviceId, policy.requestNonce); db.exec('COMMIT') }
    catch (error) { db.exec('ROLLBACK'); throw error }
    return existing
  }
  validateInput(db, input, actor, policy)
  const at = (policy.now ?? (() => new Date()))().toISOString(), receiptId = (policy.uuid ?? randomUUID)()
  db.exec('BEGIN IMMEDIATE')
  try {
    consumeRequestNonce(db, policy.managedDeviceId, policy.requestNonce)
    db.prepare(`INSERT INTO mobile_submissions(client_submission_id,receipt_id,round_id,owner_id,device_id,task_version,rule_version,draft_revision,payload_hash,canonical_payload,attachment_receipts,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(input.clientSubmissionId, receiptId, input.roundId, input.ownerId, input.deviceId, input.taskVersion, input.ruleVersion, input.draftRevision, input.payloadHash, input.canonicalPayload, JSON.stringify(input.attachmentReceipts), 'pending', at, at)
    for (const attachmentReceipt of input.attachmentReceipts) db.prepare(`INSERT INTO staged_attachment_refs(receipt_id,ref_type,ref_id) VALUES(?,?,?)`).run(attachmentReceipt, 'submission', input.clientSubmissionId)
    db.prepare(`INSERT INTO audit_log(record_id,who,username,action,detail,at) VALUES(?,?,?,?,?,?)`).run(input.roundId, actor.name, actor.username, 'mobile_submission_created', JSON.stringify({ clientSubmissionId: input.clientSubmissionId, receiptId, payloadHash: input.payloadHash }), at)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  return find(db, input.clientSubmissionId)!
}

export function getSubmissionReceipt(db: DB, clientSubmissionId: string, actor: User): SubmissionRecord {
  const row=db.prepare(`SELECT * FROM mobile_submissions WHERE client_submission_id=? AND owner_id=?`).get(clientSubmissionId,actor.username)
  const record = row ? rowToRecord(row) : null
  if (!record) throw new SubmissionError('SUBMISSION_NOT_FOUND', 404, '没有找到该提交回执')
  return record
}
export function publicSubmissionReceipt(record:SubmissionRecord){return{clientSubmissionId:record.clientSubmissionId,receiptId:record.receiptId,roundId:record.roundId,payloadHash:record.payloadHash,status:record.status,errorCode:record.errorCode,createdAt:record.createdAt,updatedAt:record.updatedAt,completedAt:record.completedAt}}

export function finalizeSubmission(db: DB, clientSubmissionId: string, actor: User, policy: FinalizePolicy): SubmissionRecord {
  const record = getSubmissionReceipt(db, clientSubmissionId, actor)
  if (record.status === 'complete') return record
  if (record.status === 'failed') throw new SubmissionError(record.errorCode || 'SUBMISSION_FAILED', 409, '提交已进入不可重试失败状态')
  const at = (policy.now ?? (() => new Date()))().toISOString()
  if (record.status === 'pending') {
    db.exec('BEGIN IMMEDIATE')
    try { db.prepare(`UPDATE mobile_submissions SET status='finalizing',updated_at=? WHERE client_submission_id=? AND status='pending'`).run(at, clientSubmissionId); db.exec('COMMIT') }
    catch (error) { db.exec('ROLLBACK'); throw error }
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const latest = find(db, clientSubmissionId)!
    if (latest.status === 'complete') { db.exec('COMMIT'); return latest }
    if (latest.status !== 'finalizing') throw new SubmissionError('SUBMISSION_STATE_CONFLICT', 409, '提交状态无法完成发布')
    const publication = policy.publish(db, { ...latest, status: 'finalizing', updatedAt: at })
    db.prepare(`UPDATE mobile_submissions SET status='complete',publication_json=?,updated_at=?,completed_at=? WHERE client_submission_id=?`).run(JSON.stringify(publication), at, at, clientSubmissionId)
    db.prepare(`INSERT INTO audit_log(record_id,who,username,action,detail,at) VALUES(?,?,?,?,?,?)`).run(latest.roundId, actor.name, actor.username, 'mobile_submission_completed', JSON.stringify({ clientSubmissionId, receiptId: latest.receiptId }), at)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  return find(db, clientSubmissionId)!
}

export function recoverSubmissions(db: DB, policy: FinalizePolicy) {
  const pending=(db.prepare(`SELECT COUNT(*) n FROM mobile_submissions WHERE status='pending'`).get() as any).n as number
  const rows = db.prepare(`SELECT client_submission_id,owner_id FROM mobile_submissions WHERE status='finalizing' ORDER BY created_at`).all() as any[]
  let completed = 0,failed=0
  for (const row of rows) {
    const user = db.prepare(`SELECT username,name,roles,status FROM users WHERE username=?`).get(row.owner_id) as any
    if (!user) continue
    user.roles = parseJson(user.roles, [])
    try{finalizeSubmission(db, row.client_submission_id, user, policy); completed++}catch{failed++}
  }
  return { completed,pending,failed }
}
