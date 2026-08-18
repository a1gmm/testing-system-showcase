// HTTP 层：纯 node:http，零依赖。把路由接到 handlers。
import { createServer } from 'node:http'
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, extname } from 'node:path'
import { openDb, resolveLegacyStagingDir } from './db.ts'
import {
  createSample, listSamples, getSample, addHandover, confirmHandover, listHandovers, listPendingHandovers, addPretreatment, listPretreatments, addQc, listQc,
  listHandoverSheets, getHandoverSheet, updateHandoverSheet, sendHandoverSheet, confirmHandoverSheet,
  listTestNotices, getTestNotice, createNoticeFromSheet, updateTestNotice, issueTestNotice, claimTestTask, cancelTestTask, resampleSample, unclaimTask, withdrawRecord, sampleStorage,
  maskSampleForUser, maskSheetForUser, decodeNotice,
  addReportDelivery, listReportDeliveries, archiveIndex, setRetention, disposeRetention, getRetention, techReviewContract, findReportsBySample, getOrgProfile, updateOrgProfile,
  assignTestTasks, listTestTasks, listTesters,
  saveRecord, saveRecordsBatch, getRecord, getRecordById, getAudit,
  createContract, updateContract, listContracts, getContract, generateSamples, saveContractQuote, terminateContract,
  listPoints, upsertPoint, setPointActual,
  listCustomers, upsertCustomer, getCustomerContracts,
  acceptContract, createScheme, getScheme, reviewScheme,
  listRounds, listDueRounds, sampleRound, assignRound, listAllRounds, getRoundDetail, generateRoundReport, saveRoundField,
  confirmRoundField, contractAlerts,
  saveRoundSheet, getRoundSheet, listRoundSheets,
  failRound, rescheduleRound, adjustRoundDue, cancelRound, roundQcRequirements,
  getProject, listProjects, setContractDoc, getContractRow,
  listRecords, reviewRecord, flagRecheck,
  listSamplers,
  seedInstruments, listInstruments, createInstrument, checkoutInstrument, returnInstrument, listCheckouts,
  listRefMaterials, createRefMaterial, deleteRefMaterial, listReagents, createReagent, deleteReagent, resourceAlerts, seedResources,
  generateReport, getReport, listReports, checkReport, issueReport, updateReport, voidReport, rejectReport, deleteReport, generateContractReport,
  addSystemRecord, listSystemRecords, updateSystemRecord,
  addSubcontract, listSubcontracts, updateSubcontract,
  statsOverview, statsYearly, revokeTestNotice,
  login, logout, sessionUser, listUsers, createUser, updateUser, resetPassword, changeOwnPassword, hasRole, seedUsers, ROLE_LABEL,
  needsPasswordChange, corsHeaderValue,
  logAction, listAudit,
  addAttachment, listAttachments, getAttachment, deleteAttachment, ATTACH_ENTITY_TYPES, type AttachEntityType,
  contractForUser, canSeeRecordAudit, urlTokenAllowed, maskUserList, canManageAttachment, attachRoleErrorText,
  assertRoundAccess, assertReportReadAccess,
  issueOfflineTaskPackage,
  currentOfflineTaskScope,
  stageAttachment, getStagedAttachmentStatus, cancelStagedAttachment,
  gcStagedAttachments, startStagingGcTimer,
  type User,
} from './handlers.ts'
import { randomUUID, createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { PERM, REPORT_READ_ROLES, type PermAction } from './permissions.ts'
import { detectImageMime } from './attachmentSecurity.ts'
import { createSubmission, getSubmissionReceipt, publicSubmissionReceipt, recoverSubmissions } from './submissions.ts'
import { confirmMobileSubmission, pendingConfirmationSnapshot, publishConfirmedSubmission } from './mobileConfirmations.ts'
import { claimConfirmationInvite, confirmClaimedInvite, getConfirmationClaim, issueConfirmationInvite } from './mobileConfirmationInvites.ts'
import { mobileOperationsHealth } from './mobileOperations.ts'

const PORT = Number(process.env.PORT) || 3001
const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads'
const LEGACY_STAGING_DIR=resolveLegacyStagingDir(UPLOAD_DIR,process.env.ATTACHMENT_STAGING_DIR)
const db = openDb(process.env.DB_PATH || 'data.db',{legacyStagingDir:LEGACY_STAGING_DIR})
try{gcStagedAttachments(db)}catch(error){console.error('[staging-gc] startup failed; ledger retained',error)}
// 演示台账（仪器/标物/试剂）默认不灌：生产上清过的数据不能因为重启又长回来。
// 本地开发要样例数据：SEED_DEMO=1 npm run dev
if (process.env.SEED_DEMO === '1') { seedInstruments(db); seedResources(db) }
seedUsers(db)   // 账号是系统能登录的前提，始终建
try{recoverSubmissions(db,{publish:publishConfirmedSubmission})}catch(error){console.error('[mobile-submission-recovery] failed; receipts retained',error)}

if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true })
const MIME: Record<string, string> = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }

type Ctx = { method: string; parts: string[]; query: URLSearchParams; body: any; headers: import('node:http').IncomingHttpHeaders; user: User | null; token: string; setHeader: (name: string, value: string) => void }
type Handler = (c: Ctx) => any

type ManagedDeviceRecord = { deviceId: string; compliant: true; revoked?: boolean; expiresAt: string; publicKeySpki: string; fingerprint: string }
function managedStagingDevice(actor: User, roundId: string): ManagedDeviceRecord | null {
  if (process.env.OFFLINE_WRITE_ENABLED !== 'true' || process.env.SENSITIVE_OFFLINE_PACKAGE_ENABLED !== 'true' || process.env.SIGNED_FORM_RULE_APPROVED !== 'true') return null
  let registry: Record<string, any> = {}
  try { registry = JSON.parse(process.env.MANAGED_DEVICE_REGISTRY_JSON || '{}') } catch { return null }
  const record = registry[`${actor.username}|${roundId}`]
  const expiresAt=Date.parse(record?.expiresAt)
  if (!record || record.revoked || record.compliant !== true || typeof record.deviceId !== 'string' || typeof record.publicKeySpki !== 'string' || typeof record.fingerprint !== 'string' || !Number.isFinite(expiresAt) || new Date(expiresAt).toISOString()!==record.expiresAt || expiresAt <= Date.now()) return null
  try {
    const key=createPublicKey(record.publicKeySpki)
    if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1')return null
    const der = key.export({ type: 'spki', format: 'der' })
    if (createHash('sha256').update(der).digest('hex') !== record.fingerprint) return null
  } catch { return null }
  return record as ManagedDeviceRecord
}

function canonicalDeviceRequest(fields: { method: string; path: string; actor: string; roundId: string; sampleSlotId?: string; attachmentId?: string; hash?: string; size?: number; mime?: string; bodyHash?: string; contentRevision?:number;taskVersion:string;ruleVersion:string;nonce: string; issuedAt: string }) {
  return [fields.method.toUpperCase(), fields.path, fields.actor, fields.roundId, fields.sampleSlotId ?? '', fields.attachmentId ?? '', fields.hash ?? '', String(fields.size ?? ''), fields.mime ?? '', fields.bodyHash ?? '',String(fields.contentRevision??''),fields.taskVersion,fields.ruleVersion, fields.nonce, fields.issuedAt].join('\n')
}

function verifyDeviceRequest(record: ManagedDeviceRecord | null, actor: User, request: any, fields: Omit<Parameters<typeof canonicalDeviceRequest>[0], 'actor'|'nonce'|'issuedAt'|'taskVersion'|'ruleVersion'|'contentRevision'>) {
  if (!record) throw new HttpErr(403, 'MANAGED_DEVICE_REQUIRED')
  const nonce = String(request.headers['x-device-nonce'] || ''), issuedAt = String(request.headers['x-device-issued-at'] || ''), signature = String(request.headers['x-device-signature'] || '')
  const taskVersion=String(request.headers['x-task-version']||''),ruleVersion=String(request.headers['x-rule-version']||''),contentRevision=Number(request.headers['x-content-revision'])||undefined,current=currentOfflineTaskScope(db,fields.roundId)
  if(taskVersion!==current.taskVersion||ruleVersion!==current.ruleVersion)throw new HttpErr(409,'OFFLINE_PACKAGE_SCOPE_STALE')
  const issued = Date.parse(issuedAt), now = Date.now()
  if (!/^[A-Za-z0-9-]{16,128}$/.test(nonce) || !Number.isFinite(issued) || Math.abs(now - issued) > 5 * 60_000 || !signature) throw new HttpErr(403, 'DEVICE_PROOF_EXPIRED')
  const canonical = canonicalDeviceRequest({ ...fields, actor: actor.username,contentRevision,taskVersion,ruleVersion, nonce, issuedAt })
  let valid = false
  try { valid = verifySignature('sha256', Buffer.from(canonical), { key: record.publicKeySpki, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64')) } catch { valid = false }
  if (!valid) throw new HttpErr(403, 'DEVICE_PROOF_INVALID')
  return {deviceId:record.deviceId,requestNonce:{nonce,issuedAt,expiresAt:new Date(issued+5*60_000).toISOString()}}
}

const stagingUploads = new Map<string, number>()
let lastStagingGc=Date.now()
function opportunisticStagingGc(){if(Date.now()-lastStagingGc<60_000)return;lastStagingGc=Date.now();try{gcStagedAttachments(db)}catch(error){console.error('[staging-gc] opportunistic failed; ledger retained',error)}}
const stopStagingGc=startStagingGcTimer(db,Number(process.env.STAGING_GC_INTERVAL_MS)||60_000)

// 关键动作按角色卡权限（admin 万能）；错了给人话提示
function need(c: Ctx, ...roles: string[]): User {
  if (!c.user) throw new HttpErr(401, '请先登录')
  if (!hasRole(c.user, ...roles)) {
    const names = roles.map(r => ROLE_LABEL[r] || r).join(' / ')
    throw new HttpErr(403, `此操作需要「${names}」权限，${c.user.name} 是「${c.user.roles.map(r => ROLE_LABEL[r] || r).join('、')}」`)
  }
  return c.user
}
function needLogin(c: Ctx): User {
  if (!c.user) throw new HttpErr(401, '请先登录')
  return c.user
}
// 按权限矩阵卡角色：所有业务路由统一走这里，角色清单只在 permissions.ts 一处维护
function needP(c: Ctx, action: PermAction): User { return need(c, ...PERM[action]) }

// 极简路由表：[方法, 路径模板, 处理函数]，:x 为占位
const routes: [string, string, Handler][] = [
  // 登录 / 人员
  ['POST', '/api/login', c => login(db, c.body.username, c.body.password)],
  ['POST', '/api/logout', c => { logout(db, c.token); return { ok: true } }],
  ['GET', '/api/me', c => c.user],
  ['GET', '/api/users', c => { need(c, 'admin'); return listUsers(db) }],
  // 选人下拉只需要姓名；username（登录名=撞库素材）只发给真正拿它派工的人（体检40）
  ['GET', '/api/users/samplers', c => { const u = needLogin(c); return maskUserList(listSamplers(db), hasRole(u, ...PERM.round_assign)) }],
  // 移动提交：创建只产生持久 pending 回执；正式发布仍由冻结/双签后的协调器显式触发。
  ['POST', '/api/rounds/:id/mobile-submissions', c => {
    const u = needLogin(c), roundId = decodeURIComponent(c.parts[3]), device = managedStagingDevice(u, roundId)
    if (process.env.MOBILE_SUBMISSION_ENABLED !== 'true') throw new HttpErr(403, 'MOBILE_SUBMISSION_GATE_CLOSED')
    const scope = currentOfflineTaskScope(db, roundId), bodyHash = createHash('sha256').update(JSON.stringify(c.body)).digest('hex')
    const proof = verifyDeviceRequest(device, u, { headers: c.headers }, { method: 'POST', path: `/api/rounds/${encodeURIComponent(roundId)}/mobile-submissions`, roundId, attachmentId: String(c.body.clientSubmissionId || ''), hash: String(c.body.payloadHash || ''), mime: 'application/json', bodyHash })
    if (Number(c.headers['x-content-revision']) !== Number(c.body.draftRevision)) throw new HttpErr(403, 'SUBMISSION_REVISION_PROOF_MISMATCH')
    c.setHeader('Cache-Control', 'private, no-store')
    return publicSubmissionReceipt(createSubmission(db, {
      clientSubmissionId: String(c.body.clientSubmissionId || ''), roundId, ownerId: u.username, deviceId: proof.deviceId,
      taskVersion: String(c.body.taskVersion || ''), ruleVersion: String(c.body.ruleVersion || ''), draftRevision: Number(c.body.draftRevision),
      canonicalPayload: String(c.body.canonicalPayload || ''), payloadHash: String(c.body.payloadHash || ''),
      attachmentReceipts: Array.isArray(c.body.attachmentReceipts) ? c.body.attachmentReceipts.map(String) : [],
    }, u, { managedDeviceId: proof.deviceId, requestNonce: proof.requestNonce, expectedTaskVersion: scope.taskVersion, expectedRuleVersion: scope.ruleVersion }))
  }],
  ['GET', '/api/mobile-submissions/:id', c => { const u = needLogin(c); c.setHeader('Cache-Control', 'private, no-store'); return publicSubmissionReceipt(getSubmissionReceipt(db, decodeURIComponent(c.parts[3]), u)) }],
  ['GET', '/api/rounds/:id/mobile-confirmation', c => { const u=needLogin(c);if(process.env.MOBILE_SUBMISSION_ENABLED!=='true')throw new HttpErr(403,'MOBILE_SUBMISSION_GATE_CLOSED');c.setHeader('Cache-Control','private, no-store');return pendingConfirmationSnapshot(db,decodeURIComponent(c.parts[3]),u) }],
  ['POST', '/api/mobile-submissions/:id/confirm', c => {
    const u=needLogin(c),id=decodeURIComponent(c.parts[3]);if(process.env.MOBILE_SUBMISSION_ENABLED!=='true')throw new HttpErr(403,'MOBILE_SUBMISSION_GATE_CLOSED');const submission=db.prepare(`SELECT round_id,draft_revision FROM mobile_submissions WHERE client_submission_id=?`).get(id)as any
    if(!submission)throw new HttpErr(404,'SUBMISSION_NOT_FOUND')
    const roundId=String(submission.round_id),device=managedStagingDevice(u,roundId),path=`/api/mobile-submissions/${encodeURIComponent(id)}/confirm`,bodyHash=createHash('sha256').update(JSON.stringify(c.body)).digest('hex')
    const proof=verifyDeviceRequest(device,u,{headers:c.headers},{method:'POST',path,roundId,attachmentId:id,mime:'application/json',bodyHash})
    if(Number(c.headers['x-content-revision'])!==Number(submission.draft_revision))throw new HttpErr(403,'SUBMISSION_REVISION_PROOF_MISMATCH')
    const result=confirmMobileSubmission(db,id,u,String(c.body.password||''),()=>new Date(),{deviceId:proof.deviceId,...proof.requestNonce})
    return{...publicSubmissionReceipt(result),confirmationCount:(result as any).confirmationCount,summaryHash:(result as any).summaryHash}
  }],
  ['POST','/api/mobile-submissions/:id/confirmation-invites',c=>{
    const u=needLogin(c),id=decodeURIComponent(c.parts[3]);if(process.env.SECOND_DEVICE_CONFIRMATION_ENABLED!=='true')throw new HttpErr(403,'SECOND_DEVICE_CONFIRMATION_DISABLED')
    const submission=db.prepare(`SELECT round_id,draft_revision FROM mobile_submissions WHERE client_submission_id=?`).get(id)as any;if(!submission)throw new HttpErr(404,'SUBMISSION_NOT_FOUND')
    const roundId=String(submission.round_id),path=`/api/mobile-submissions/${encodeURIComponent(id)}/confirmation-invites`,bodyHash=createHash('sha256').update(JSON.stringify(c.body)).digest('hex'),proof=verifyDeviceRequest(managedStagingDevice(u,roundId),u,{headers:c.headers},{method:'POST',path,roundId,attachmentId:id,mime:'application/json',bodyHash})
    if(Number(c.headers['x-content-revision'])!==Number(submission.draft_revision))throw new HttpErr(403,'SUBMISSION_REVISION_PROOF_MISMATCH')
    return issueConfirmationInvite(db,id,u,String(c.body.intendedConfirmerId||''),{enabled:true,requestProof:{deviceId:proof.deviceId,...proof.requestNonce}})
  }],
  ['POST','/api/mobile-confirmation-invites/claim',c=>{const u=needLogin(c);if(process.env.SECOND_DEVICE_CONFIRMATION_ENABLED!=='true')throw new HttpErr(403,'SECOND_DEVICE_CONFIRMATION_DISABLED');const result=claimConfirmationInvite(db,String(c.body.qrPayload||''),u)as any;if(result.status!=='claimed')return result;const device=managedStagingDevice(u,String(result.confirmation.roundId));if(!device)throw new HttpErr(403,'MANAGED_DEVICE_REQUIRED');return{...result,deviceBinding:{publicKeySpki:device.publicKeySpki,fingerprint:device.fingerprint}}}],
  ['GET','/api/mobile-confirmation-claims/:id',c=>{const u=needLogin(c);if(process.env.SECOND_DEVICE_CONFIRMATION_ENABLED!=='true')throw new HttpErr(403,'SECOND_DEVICE_CONFIRMATION_DISABLED');return getConfirmationClaim(db,decodeURIComponent(c.parts[3]),u)}],
  ['POST','/api/mobile-confirmation-claims/:id/confirm',c=>{
    const u=needLogin(c),claimId=decodeURIComponent(c.parts[3]);if(process.env.SECOND_DEVICE_CONFIRMATION_ENABLED!=='true')throw new HttpErr(403,'SECOND_DEVICE_CONFIRMATION_DISABLED')
    const row=db.prepare(`SELECT i.client_submission_id,s.round_id,s.draft_revision FROM mobile_confirmation_invites i JOIN mobile_submissions s ON s.client_submission_id=i.client_submission_id WHERE i.claim_id=? AND i.intended_confirmer_id=?`).get(claimId,u.username)as any;if(!row)throw new HttpErr(404,'CONFIRMATION_CLAIM_NOT_FOUND')
    const roundId=String(row.round_id),path=`/api/mobile-confirmation-claims/${encodeURIComponent(claimId)}/confirm`,bodyHash=createHash('sha256').update(JSON.stringify(c.body)).digest('hex'),proof=verifyDeviceRequest(managedStagingDevice(u,roundId),u,{headers:c.headers},{method:'POST',path,roundId,attachmentId:String(row.client_submission_id),mime:'application/json',bodyHash})
    if(Number(c.headers['x-content-revision'])!==Number(row.draft_revision))throw new HttpErr(403,'SUBMISSION_REVISION_PROOF_MISMATCH')
    return confirmClaimedInvite(db,claimId,u,String(c.body.password||''),{deviceId:proof.deviceId,...proof.requestNonce})
  }],
  ['POST', '/api/users', c => { const u = need(c, 'admin'); const r = createUser(db, c.body); logAction(db, r.username, u, 'user_create', { name: r.name, roles: r.roles }); return r }],
  ['POST', '/api/users/:name/update', c => { const u = need(c, 'admin'); const r = updateUser(db, decodeURIComponent(c.parts[3]), c.body); logAction(db, r.username, u, 'user_update', { name: r.name, roles: r.roles, status: r.status }); return r }],
  ['POST', '/api/users/:name/reset-pw', c => { const u = need(c, 'admin'); const un = decodeURIComponent(c.parts[3]); resetPassword(db, un, c.body.password); logAction(db, un, u, 'user_reset_pw', {}); return { ok: true } }],
  ['POST', '/api/change-password', c => { const u = needLogin(c); changeOwnPassword(db, u.username, c.body.oldPassword, c.body.newPassword); logAction(db, u.username, u, 'user_change_pw', {}); return { ok: true } }],
  ['GET', '/api/audit/:id', c => { needP(c, 'audit_view'); return listAudit(db, decodeURIComponent(c.parts[3])) }],
  ['GET','/api/mobile-operations/health',c=>{need(c,'admin','tech');c.setHeader('Cache-Control','private, no-store');return mobileOperationsHealth(db)}],
  // 记录附件：列表（登录可看）/ 软删（按实体的角色白名单，体检17——报告附件签字人能删自己传的，采样员不能碰）
  ['GET', '/api/attachments/:type/:id', c => { const u = needLogin(c); return listAttachments(db, decodeURIComponent(c.parts[3]), decodeURIComponent(c.parts[4]), u) }],
  ['POST', '/api/attachments/:aid/delete', c => {
    const u = needLogin(c)
    const a = getAttachment(db, decodeURIComponent(c.parts[3]), u)
    if (a && !canManageAttachment(u, a.entity_type)) throw new HttpErr(403, attachRoleErrorText(a.entity_type))
    deleteAttachment(db, decodeURIComponent(c.parts[3]), u, hasRole(u, 'tech'))   // 附件不存在时由这里报人话错误
    return { ok: true }
  }],

  ['POST', '/api/samples', c => { const u = needP(c, 'sample_create'); const r = createSample(db, c.body); logAction(db, r.id, u, 'sample_create', { matrix: r.matrix, client: r.client }); return r }],
  // 真盲（拍板2）：纯检测员的样品列表脱敏（受检单位/点位不可见）
  ['GET', '/api/samples', c => { const u = needLogin(c); return listSamples(db, c.query.get('status') || undefined).map(s => maskSampleForUser(u, s)) }],
  ['GET', '/api/samples/:id', c => { const s0 = req(getSample(db, c.parts[3]), '样品不存在') as any; return { ...s0, storage: sampleStorage(db, s0.id) } }],
  ['GET', '/api/samples/:id/handovers', c => { needLogin(c); return listHandovers(db, decodeURIComponent(c.parts[3])) }],
  ['POST', '/api/samples/:id/handover', c => { const u = needP(c, 'handover_send'); return addHandover(db, decodeURIComponent(c.parts[3]), c.body, u) }],
  ['GET', '/api/handovers/pending', c => { needLogin(c); return listPendingHandovers(db) }],
  // 交接单（批次一）：收样自动草稿→采样员改/发出→质控员整单签收（可拒收个别样品）
  ['GET', '/api/handover-sheets', c => { const u = needLogin(c); return listHandoverSheets(db, { roundId: c.query.get('roundId') || undefined, status: c.query.get('status') || undefined }).map(s => maskSheetForUser(u, s)) }],
  ['GET', '/api/handover-sheets/:id', c => { const u = needLogin(c); return maskSheetForUser(u, getHandoverSheet(db, decodeURIComponent(c.parts[3])) as any) }],
  ['POST', '/api/handover-sheets/:id/update', c => { const u = needP(c, 'handover_send'); return updateHandoverSheet(db, decodeURIComponent(c.parts[3]), c.body, u) }],
  ['POST', '/api/handover-sheets/:id/send', c => { const u = needP(c, 'handover_send'); return sendHandoverSheet(db, decodeURIComponent(c.parts[3]), u) }],
  ['POST', '/api/handover-sheets/:id/confirm', c => { const u = needP(c, 'handover_confirm'); return confirmHandoverSheet(db, decodeURIComponent(c.parts[3]), u, c.body || {}) }],
  // 检测任务通知单 HJ-TC-137：质控员从已签收交接单一键生成→可改→下达（建待认领任务）；检测员认领
  ['GET', '/api/test-notices', c => { const u = needLogin(c); return listTestNotices(db, { status: c.query.get('status') || undefined, roundId: c.query.get('roundId') || undefined }).map(n => maskSheetForUser(u, n)) }],
  ['GET', '/api/test-notices/:id', c => { const u = needLogin(c); return maskSheetForUser(u, getTestNotice(db, decodeURIComponent(c.parts[3])) as any) }],
  ['POST', '/api/handover-sheets/:id/notice', c => { const u = needP(c, 'task_assign'); return createNoticeFromSheet(db, decodeURIComponent(c.parts[3]), u) }],
  ['POST', '/api/test-notices/:id/update', c => { const u = needP(c, 'task_assign'); return updateTestNotice(db, decodeURIComponent(c.parts[3]), c.body, u) }],
  ['POST', '/api/test-notices/:id/revoke', c => { const u = needP(c, 'task_assign'); return revokeTestNotice(db, decodeURIComponent(c.parts[3]), c.body?.reason || '', u) }],
  ['POST', '/api/test-notices/:id/issue', c => { const u = needP(c, 'task_assign'); return issueTestNotice(db, decodeURIComponent(c.parts[3]), u) }],
  ['POST', '/api/tasks/:id/claim', c => { const u = needP(c, 'record_save'); return claimTestTask(db, Number(c.parts[3]), u) }],
  ['POST', '/api/tasks/:id/unclaim', c => { const u = needP(c, 'record_save'); return unclaimTask(db, Number(c.parts[3]), u) }],
  ['POST', '/api/tasks/:id/cancel', c => { const u = needP(c, 'task_assign'); return cancelTestTask(db, Number(c.parts[3]), c.body?.reason || '', u) }],
  ['POST', '/api/samples/:id/resample', c => { const u = needP(c, 'handover_send'); return resampleSample(db, decodeURIComponent(c.parts[3]), u) }],
  ['GET', '/api/test-notices/:id/decode', c => { const u = needP(c, 'task_assign'); return decodeNotice(db, decodeURIComponent(c.parts[3])) }],
  // 批次三：报告发放登记 / 归档清单 / 留样处置
  ['POST', '/api/reports/:id/deliver', c => { const u = needP(c, 'report_update'); return addReportDelivery(db, c.parts[3], c.body || {}, u) }],
  ['GET', '/api/reports/:id/deliveries', c => { needLogin(c); return listReportDeliveries(db, c.parts[3]) }],
  ['GET', '/api/reports/:id/archive-index', c => { const u = needLogin(c); return archiveIndex(db, c.parts[3], u) }],
  ['POST', '/api/samples/:id/retention', c => { const u = needP(c, 'handover_confirm'); return setRetention(db, decodeURIComponent(c.parts[3]), c.body || {}, u) }],
  ['POST', '/api/samples/:id/retention/dispose', c => { const u = needP(c, 'handover_confirm'); return disposeRetention(db, decodeURIComponent(c.parts[3]), c.body || {}, u) }],
  ['GET', '/api/samples/:id/retention', c => { needLogin(c); return getRetention(db, decodeURIComponent(c.parts[3])) }],
  // 合同评审签批（拍板7）+ 样号反查报告（批次二修补）
  ['POST', '/api/contracts/:id/tech-review', c => { const u = needP(c, 'contract_tech_review'); return techReviewContract(db, c.parts[3], c.body?.decision, u, c.body?.note || '') }],
  ['GET', '/api/samples/:id/reports', c => { needLogin(c); return findReportsBySample(db, decodeURIComponent(c.parts[3])) }],
  // 公司主数据（批次二地基1）：报告抬头/地址/证书号，读全员、改走 org_profile 权限
  ['GET', '/api/org-profile', c => { needLogin(c); return getOrgProfile(db) }],
  ['POST', '/api/org-profile', c => { const u = needP(c, 'org_profile'); return updateOrgProfile(db, c.body, u) }],
  // 检测任务派工：qc 按样品×项目派给检测员；检测员看「我的任务」
  ['GET', '/api/tasks', c => { const u = needLogin(c); const a = c.query.get('assignee'); return listTestTasks(db, { assignee: a === 'me' ? u.name : (a || undefined), sampleId: c.query.get('sampleId') || undefined, unclaimed: c.query.get('unclaimed') === '1' }) }],
  ['POST', '/api/samples/:id/tasks', c => { const u = needP(c, 'task_assign'); const r = assignTestTasks(db, decodeURIComponent(c.parts[3]), c.body.items, u); logAction(db, decodeURIComponent(c.parts[3]), u, 'tasks_assign', { items: c.body.items }); return r }],
  ['GET', '/api/users/testers', c => { const u = needLogin(c); return maskUserList(listTesters(db), hasRole(u, ...PERM.task_assign)) }],
  ['POST', '/api/handovers/:hid/confirm', c => { const u = needP(c, 'handover_confirm'); const r = confirmHandover(db, Number(c.parts[3]), u); logAction(db, r.sample_id, u, 'handover_confirm', { handover: r.id }); return r }],
  ['GET', '/api/samples/:id/pretreatments', c => { needLogin(c); return listPretreatments(db, decodeURIComponent(c.parts[3])) }],
  ['POST', '/api/samples/:id/pretreatment', c => { const u = needP(c, 'pretreatment'); return addPretreatment(db, decodeURIComponent(c.parts[3]), c.body, u) }],
  ['GET', '/api/records', c => {
    const sampleId = c.query.get('sampleId'), code = c.query.get('code')
    if (!sampleId || !code) throw new HttpErr(400, '缺少 sampleId 或 code')
    return getRecord(db, sampleId, code)   // 可能为 null（还没录过）→ 200 null
  }],
  ['POST', '/api/records/:id/withdraw', c => { const u = needP(c, 'record_save'); return withdrawRecord(db, decodeURIComponent(c.parts[3]), u) }],
  ['POST', '/api/records', c => { const u = needP(c, 'record_save'); return saveRecord(db, { ...c.body, who: u.name, whoUsername: u.username }, { supervisor: hasRole(u, 'tech') }) }],
  // 跨合同同表批量录入（PRD 步骤6）：一张表多样品，按编号自动归各自合同
  ['POST', '/api/records/batch', c => { const u = needP(c, 'record_save'); return saveRecordsBatch(db, { ...c.body, who: u.name, whoUsername: u.username }, { supervisor: hasRole(u, 'tech') }) }],
  ['GET', '/api/records/:id', c => req(getRecordById(db, c.parts[3]), '记录不存在')],
  // 记录留痕：编制人本人（录入页看自己的记录）或有 audit_view 权限才放行（体检9）
  ['GET', '/api/records/:id/audit', c => {
    const u = needLogin(c)
    const rec = req(getRecordById(db, c.parts[3]), '记录不存在')
    if (!canSeeRecordAudit(u, rec as any)) throw new HttpErr(403, '只有记录编制人本人或复核员/审核员/技术负责人能看这条记录的留痕')
    return getAudit(db, c.parts[3])
  }],

  ['POST', '/api/contracts', c => { const u = needP(c, 'contract_edit'); const r = createContract(db, c.body); logAction(db, r.id, u, 'contract_create', { client: r.client, project: r.project }); return r }],
  // 合同读接口不整门拦（采样/检测登记自送样要选合同），但报价/评审等商务字段按角色脱敏（体检8a）
  ['GET', '/api/contracts', c => { const u = needLogin(c); return listContracts(db).map(x => contractForUser(u, x)) }],
  // 客户档案（联系方式/地址/历史合同=客户资源）：限 登记员/技术负责人/签字人（体检8c）
  ['GET', '/api/customers', c => { need(c, 'registrar', 'tech', 'signer'); return listCustomers(db) }],
  ['POST', '/api/customers', c => { const u = needP(c, 'customer_edit'); const r = upsertCustomer(db, c.body); logAction(db, 'customer:' + r.name, u, 'customer_upsert', { contact: r.contact, phone: r.phone, address: r.address }); return r }],
  ['GET', '/api/customers/:name/contracts', c => { need(c, 'registrar', 'tech', 'signer'); return getCustomerContracts(db, decodeURIComponent(c.parts[3])) }],
  ['GET', '/api/contracts/:id', c => contractForUser(c.user, req(getContract(db, c.parts[3]), '合同不存在'))],
  // 一键生成的样品会被「交接未签收」闸拦住（体检10）：响应带 hint 告诉下一步怎么走
  ['POST', '/api/contracts/:id/generate', c => {
    const u = needP(c, 'contract_edit')
    const r = generateSamples(db, c.parts[3])
    logAction(db, c.parts[3], u, 'samples_generate', { n: r.length })
    return { samples: r, hint: '生成的样品需要先在样品页登记交接、由质控员签收后，才能派检测任务和录数据' }
  }],
  // 合同终止（体检15）：客户跑路/项目黄了走这里，新动作全拦、已有数据只读
  ['POST', '/api/contracts/:id/terminate', c => { const u = needP(c, 'contract_edit'); return terminateContract(db, c.parts[3], c.body.reason, u) }],
  ['POST', '/api/contracts/:id/quote', c => { const u = needP(c, 'contract_edit'); const r = saveContractQuote(db, c.parts[3], c.body); logAction(db, c.parts[3], u, 'contract_quote', { rows: r.quote?.rows.length, discount: r.quote?.discount }); return r }],
  ['POST', '/api/contracts/:id/accept', c => { const u = needP(c, 'contract_accept'); const r = acceptContract(db, c.parts[3], u.name, c.body.review); logAction(db, c.parts[3], u, 'contract_accept', { review: c.body.review }); return r }],
  // 决策8：合同可改、字段级 diff 留痕（updateContract 内部写 contract_update 留痕）
  ['POST', '/api/contracts/:id/update', c => { const u = needP(c, 'contract_edit'); return updateContract(db, c.parts[3], c.body, u) }],
  // 点位档案（决策1）：列表 / 现场补点 / 改实际采样位置（改动留痕）
  ['GET', '/api/contracts/:id/points', c => { needLogin(c); return listPoints(db, c.parts[3]) }],
  ['POST', '/api/contracts/:id/points', c => { const u = needP(c, 'round_field'); return upsertPoint(db, c.parts[3], { ...c.body, source: 'field' }, u) }],
  ['POST', '/api/points/:pid/actual', c => { const u = needP(c, 'round_field'); return setPointActual(db, Number(c.parts[3]), c.body.actualDesc, u) }],
  // 项目视图全角色可看（工作台/⌘K 搜索），但里面摊开的合同字段同样按角色脱敏（体检8a）
  ['GET', '/api/projects', c => { const u = needLogin(c); return listProjects(db).map(x => contractForUser(u, x)) }],
  ['GET', '/api/projects/:id', c => { const u = needLogin(c); const p = getProject(db, c.parts[3]); return { ...p, contract: contractForUser(u, p.contract) } }],

  // 监测方案 FA（受理后编制→审核）
  ['GET', '/api/contracts/:id/scheme', c => getScheme(db, c.parts[3])],
  ['POST', '/api/contracts/:id/scheme', c => { const u = needP(c, 'scheme_edit'); const r = createScheme(db, { contractId: c.parts[3], points: c.body.points, limits: c.body.limits, cycleMonths: c.body.cycleMonths, periodStart: c.body.periodStart, periodEnd: c.body.periodEnd }); logAction(db, r.id, u, 'scheme_create', { points: r.points.length, limits: r.limits.length }); return r }],
  ['POST', '/api/contracts/:id/scheme/review', c => { const u = needP(c, 'scheme_review'); const r = reviewScheme(db, c.parts[3], c.body.op, u.name, c.body.comment || ''); logAction(db, r.id, u, c.body.op === 'approve' ? 'scheme_approve' : 'scheme_reject', { comment: c.body.comment }); return r }],
  ['GET', '/api/contracts/:id/rounds', c => { const u = needLogin(c); return listRounds(db, c.parts[3], u) }],

  // 监测期次：全局列表 / 详情 / 派工 / 收样 / 到期提醒 / 本期报告
  ['GET', '/api/rounds', c => { const u = needLogin(c); return listAllRounds(db, undefined, u) }],
  ['GET', '/api/rounds/due', c => { const u = needLogin(c); return listDueRounds(db, undefined, u) }],
  // 期次详情带出整份合同（采样员在派工页用），商务字段同样脱敏（体检8a 同口径）
  ['GET', '/api/rounds/:id/detail', c => { const u = needLogin(c); const d = getRoundDetail(db, c.parts[3], u); return { ...d, contract: contractForUser(u, d.contract) } }],
  ['GET', '/api/rounds/:id/offline-package', c => {
    const u = needLogin(c)
    c.setHeader('Cache-Control', 'private, no-store')
    return issueOfflineTaskPackage(db, decodeURIComponent(c.parts[3]), u, {
      offlineWriteEnabled: process.env.OFFLINE_WRITE_ENABLED === 'true',
      sensitiveOfflinePackageEnabled: process.env.SENSITIVE_OFFLINE_PACKAGE_ENABLED === 'true',
      signingPrivateKeyPem: process.env.OFFLINE_PACKAGE_SIGNING_PRIVATE_KEY || '',
      // Defaults remain closed. A future approved deployment must provide all signed
      // gates plus a pinned registry entry; no browser flag can enable this path.
      signedFormRuleApproved: process.env.SIGNED_FORM_RULE_APPROVED === 'true',
      verifyManagedDevice: (actor, roundId) => { const record=managedStagingDevice(actor,roundId);return record?{deviceId:record.deviceId,trustedUntil:record.expiresAt,attestationId:`registry:${record.fingerprint}`,bindingPublicKeySpki:record.publicKeySpki,bindingFingerprint:record.fingerprint}:null },
    })
  }],
  ['GET', '/api/rounds/:id/qc', c => { const u = needLogin(c); assertRoundAccess(db, decodeURIComponent(c.parts[3]), u); return listQc(db, { roundId: decodeURIComponent(c.parts[3]) }) }],
  ['POST', '/api/rounds/:id/qc', c => { const u = needP(c, 'qc_add'); const id = decodeURIComponent(c.parts[3]); assertRoundAccess(db, id, u); return addQc(db, { ...c.body, roundId: id }, u) }],
  ['POST', '/api/rounds/:id/assign', c => { const u = needP(c, 'round_assign'); const r = assignRound(db, c.parts[3], c.body.samplerIds ?? c.body.samplers ?? c.body.sampler, c.body.planDate || ''); logAction(db, c.parts[3], u, 'round_assign', { sampler_ids: r.sampler_ids, sampler_display: r.sampler, planDate: c.body.planDate }); return r }],
  ['GET', '/api/rounds/:id/qc-requirements', c => { const u = needLogin(c); assertRoundAccess(db, c.parts[3], u); return roundQcRequirements(db, c.parts[3]) }],
  // 现场记录：冻结/归属校验 + 字段级 diff 留痕都在 saveRoundField 里做（不再整包 body 入留痕）
  ['POST', '/api/rounds/:id/field', c => { const u = needP(c, 'round_field'); return saveRoundField(db, c.parts[3], c.body, u, { supervisor: hasRole(u, 'tech') }) }],
  ['GET', '/api/rounds/:id/sheets', c => { const u = needLogin(c); return listRoundSheets(db, decodeURIComponent(c.parts[3]), u) }],
  ['GET', '/api/rounds/:id/sheets/:code', c => { const u = needLogin(c); return getRoundSheet(db, decodeURIComponent(c.parts[3]), decodeURIComponent(c.parts[5]), u) }],
  ['POST', '/api/rounds/:id/sheets/:code', c => {
    const u = needP(c, 'round_field')
    // 新协议 {data, baseUpdatedAt}（乐观锁）；老客户端直接发 data 本体则不启用锁
    const wrapped = c.body && c.body.data !== undefined
    return saveRoundSheet(db, decodeURIComponent(c.parts[3]), decodeURIComponent(c.parts[5]),
      wrapped ? c.body.data : c.body, u, wrapped ? (c.body.baseUpdatedAt ?? '') : undefined,
      { supervisor: hasRole(u, 'tech') })
  }],
  ['POST', '/api/rounds/:id/fail', c => { const u = needP(c, 'round_flow'); assertRoundAccess(db, c.parts[3], u); const r = failRound(db, c.parts[3], c.body.reason); logAction(db, c.parts[3], u, 'round_fail', { reason: c.body.reason }); return r }],
  ['POST', '/api/rounds/:id/reschedule', c => { const u = needP(c, 'round_flow'); assertRoundAccess(db, c.parts[3], u); const r = rescheduleRound(db, c.parts[3], c.body.dueDate); logAction(db, c.parts[3], u, 'round_reschedule', { dueDate: c.body.dueDate, from: r.orig_due_date }); return r }],
  // 期次终止（体检12）：只对「未采成」的期次，failed → cancelled 终态（cancelRound 内部写 round_cancel 留痕）
  ['POST', '/api/rounds/:id/cancel', c => { const u = needP(c, 'round_assign'); return cancelRound(db, c.parts[3], c.body.reason, u) }],
  // 采样日期人工微调（不用谎报采不成）：登记员/质控/tech
  ['POST', '/api/rounds/:id/adjust-due', c => { const u = needP(c, 'round_assign'); return adjustRoundDue(db, c.parts[3], c.body.dueDate, u) }],
  ['POST', '/api/rounds/:id/confirm-field', c => { const u = needP(c, 'round_field'); return confirmRoundField(db, c.parts[3], u) }],
  ['POST', '/api/rounds/:id/sample', c => { const u = needP(c, 'round_field'); const r = sampleRound(db, c.parts[3], u, undefined, { supervisor: hasRole(u, 'tech') }); logAction(db, c.parts[3], u, 'round_sample', { n: r.length }); return r }],
  ['POST', '/api/reports/generate-round', c => { const u = needP(c, 'report_generate'); const r = generateRoundReport(db, c.body.roundId, undefined, u.name, u.username); logAction(db, r.id, u, 'report_generate', { round: c.body.roundId }); return r }],

  // 记录列表 + 三级审核
  ['GET', '/api/records-list', c => { const u = needLogin(c); return listRecords(db, { status: c.query.get('status') || undefined, sampleId: c.query.get('sampleId') || undefined, instrumentId: c.query.get('instrumentId') || undefined }).map(r => maskSheetForUser(u, r)) }],
  ['POST', '/api/records/:id/review', c => {
    const op = c.body.op
    // 复核环节要复核员，终审环节要审核员——三级审核的「级」由角色保证（tech 兜底见矩阵）
    const who = (op === 'review_pass' || op === 'review_reject') ? needP(c, 'record_review') : needP(c, 'record_approve')
    return reviewRecord(db, c.parts[3], op, who.name, c.body.comment || '', who.username)
  }],
  // 标复检：检测员只能动自己名下的记录（编制人/任务受派人）；复核/审核/tech 不限（体检19）
  ['POST', '/api/records/:id/recheck', c => {
    const u = needP(c, 'record_recheck')
    const flag = c.body.flag !== false
    const r = flagRecheck(db, c.parts[3], c.body.reason || '', flag, u.name,
      { username: u.username, restrictToOwn: !hasRole(u, 'reviewer', 'approver', 'tech') })
    logAction(db, c.parts[3], u, flag ? 'recheck_flag' : 'recheck_clear', { reason: c.body.reason })
    return r
  }],

  // 老「检测计划 RW 单」路由已拆除：派工统一挂在监测期次上（/api/rounds/:id/assign）

  // 资源台账：仪器 / 标准物质 / 试剂 / 到期提醒（建/改台账限管理员·技术负责人——防止伪造检定/效期）
  ['GET', '/api/instruments', () => listInstruments(db)],
  // 台账保存留痕在 handlers 里做（体检44）：更新记逐字段 from→to，新建记快照
  ['POST', '/api/instruments', c => { const u = needP(c, 'resource_manage'); return createInstrument(db, c.body, u) }],
  ['GET', '/api/checkouts', c => { needLogin(c); return listCheckouts(db, { open: c.query.get('open') === '1' }) }],
  ['POST', '/api/instruments/:id/checkout', c => { const u = needP(c, 'instrument_checkout'); const r = checkoutInstrument(db, { instrumentId: decodeURIComponent(c.parts[3]), takenBy: c.body.takenBy || u.name, roundId: c.body.roundId }, u); logAction(db, decodeURIComponent(c.parts[3]), u, 'instrument_checkout', { takenBy: r.taken_by, cert_ok: r.cert_ok_at_checkout }); return r }],
  ['POST', '/api/checkouts/:cid/return', c => { const u = needP(c, 'instrument_checkout'); const r = returnInstrument(db, Number(c.parts[3]), u); logAction(db, r.instrument_id, u, 'instrument_return', { checkout: r.id }); return r }],
  ['GET', '/api/ref-materials', () => listRefMaterials(db)],
  ['POST', '/api/ref-materials', c => { const u = needP(c, 'resource_manage'); return createRefMaterial(db, c.body, u) }],
  // 删除=软删（体检16），留痕带整行快照——删了什么批号/证书号都可查
  ['POST', '/api/ref-materials/:id/delete', c => { const u = needP(c, 'resource_manage'); const id = decodeURIComponent(c.parts[3]); const snap = deleteRefMaterial(db, id); logAction(db, id, u, 'refmaterial_delete', { snapshot: snap }); return { ok: true } }],
  ['GET', '/api/reagents', () => listReagents(db)],
  ['POST', '/api/reagents', c => { const u = needP(c, 'resource_manage'); return createReagent(db, c.body, u) }],
  ['POST', '/api/reagents/:id/delete', c => { const u = needP(c, 'resource_manage'); const id = decodeURIComponent(c.parts[3]); const snap = deleteReagent(db, id); logAction(db, id, u, 'reagent_delete', { snapshot: snap }); return { ok: true } }],
  ['GET', '/api/resource-alerts', () => resourceAlerts(db)],
  ['GET', '/api/contract-alerts', c => { needLogin(c); return contractAlerts(db) }],

  // 检测报告：读也限报告链上的人（与前端 PAGE_ROLES.reports 同口径，体检8d）
  ['GET', '/api/reports', c => { need(c, ...REPORT_READ_ROLES); return listReports(db) }],
  ['POST', '/api/reports/generate', c => { const u = needP(c, 'report_generate'); const r = generateReport(db, c.body.sampleId, undefined, u.name, u.username); logAction(db, r.id, u, 'report_generate', { sample: c.body.sampleId }); return r }],
  ['GET', '/api/reports/:id', c => { const u = needLogin(c); return assertReportReadAccess(db, c.parts[3], u) }],
  ['POST', '/api/reports/:id/check', c => { const u = needP(c, 'report_check'); const r = checkReport(db, c.parts[3], u.name, u.username); logAction(db, c.parts[3], u, 'report_check', {}); return r }],
  ['POST', '/api/reports/:id/issue', c => { const u = needP(c, 'report_issue'); const r = issueReport(db, c.parts[3], u.name, u.username); logAction(db, c.parts[3], u, 'report_issue', {}); return r }],
  ['POST', '/api/reports/:id/update', c => { const u = needP(c, 'report_update'); const r = updateReport(db, c.parts[3], c.body); logAction(db, c.parts[3], u, 'report_update', c.body); return r }],
  // 决策17：签发后要改走作废重出（作废限签发本人，tech/admin 兜底放行——handlers 里比对）；合同总报告
  ['POST', '/api/reports/:id/void', c => { const u = needP(c, 'report_issue'); return voidReport(db, c.parts[3], c.body.reason, u, hasRole(u, 'tech')) }],
  ['POST', '/api/reports/:id/reject', c => { const u = needP(c, 'report_check'); return rejectReport(db, c.parts[3], c.body.reason, u) }],
  // 报告草稿可删（draft/checked；issued/voided 不许）：物理删 + 留痕，删后可重新生成
  ['POST', '/api/reports/:id/delete', c => { const u = needP(c, 'report_generate'); return deleteReport(db, c.parts[3], u) }],
  ['POST', '/api/reports/generate-contract', c => { const u = needP(c, 'report_generate'); const r = generateContractReport(db, c.body.contractId, u.name, undefined, u.username); logAction(db, r.id, u, 'report_generate', { contract: c.body.contractId, kind: 'total' }); return r }],

  // 管理统计看板：全所家底聚合
  ['GET', '/api/stats/yearly', c => { needLogin(c); return statsYearly(db, Number(c.query.get('year')) || new Date().getFullYear()) }],
  ['GET', '/api/stats/overview', c => { needLogin(c); return statsOverview(db) }],

  // 分包管理：分包方资质 + 委托方同意 + 结果核验（读也限 登记员/技术负责人，体检8f）
  ['GET', '/api/subcontracts', c => { need(c, 'registrar', 'tech'); return listSubcontracts(db, { contractId: c.query.get('contractId') || undefined }) }],
  ['POST', '/api/subcontracts', c => { const u = needP(c, 'subcontract'); const r = addSubcontract(db, c.body, u); logAction(db, String(r.id), u, 'subcontract_create', { subcontractor: r.subcontractor, contract: r.contract_id }); return r }],
  // 更新留痕在 handlers 里做（体检45）：记变更字段的 from→to diff
  ['POST', '/api/subcontracts/:id/update', c => { const u = needP(c, 'subcontract'); return updateSubcontract(db, Number(c.parts[3]), c.body, u) }],

  // 质量体系运行记录：内审 / 管评 / 培训 / 文件受控（内审发现的问题是内部敏感件，读也限 tech，体检8e）
  ['GET', '/api/system-records', c => { need(c, 'tech'); return listSystemRecords(db, { category: c.query.get('category') || undefined }) }],
  ['POST', '/api/system-records', c => { const u = needP(c, 'system_records'); const r = addSystemRecord(db, c.body, u); logAction(db, String(r.id), u, 'sysrecord_create', { category: r.category, title: r.title }); return r }],
  // 更新留痕在 handlers 里做（体检45）：记变更字段的 from→to diff
  ['POST', '/api/system-records/:id/update', c => { const u = needP(c, 'system_records'); return updateSystemRecord(db, Number(c.parts[3]), c.body, u) }],
]

class HttpErr extends Error {
  code: number
  constructor(code: number, msg: string) { super(msg); this.code = code }
}
function req<T>(v: T | null, msg: string): T { if (v == null) throw new HttpErr(404, msg); return v }

function match(method: string, path: string) {
  for (const [m, tmpl, fn] of routes) {
    if (m !== method) continue
    const tp = tmpl.split('/'), pp = path.split('/')
    if (tp.length !== pp.length) continue
    let ok = true
    for (let i = 0; i < tp.length; i++) if (!tp[i].startsWith(':') && tp[i] !== pp[i]) { ok = false; break }
    if (ok) return fn
  }
  return null
}

// 跨域来源白名单：默认空=同源部署不发 CORS 头；对外多域时用 ALLOWED_ORIGIN 配（逗号分隔，或 * 放开）
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ''

const server = createServer(async (rreq, res) => {
  const acao = corsHeaderValue(ALLOWED_ORIGIN, rreq.headers.origin || '')
  if (acao) {
    res.setHeader('Access-Control-Allow-Origin', acao)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('X-Content-Type-Options', 'nosniff')   // 附件下载不许浏览器猜类型
  if (rreq.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  const url = new URL(rreq.url || '/', 'http://localhost')
  const path = url.pathname.replace(/\/+$/, '') || '/'
  if(/^\/api\/(?:rounds\/[^/]+\/(?:staged-attachments|mobile-submissions|mobile-confirmation)(?:\/[^/]+)?|mobile-submissions\/[^/]+(?:\/confirm|\/confirmation-invites)?|mobile-confirmation-(?:invites\/claim|claims\/[^/]+(?:\/confirm)?)|mobile-operations\/health)$/.test(path))res.setHeader('Cache-Control','private, no-store')

  // —— 身份：Bearer token。?token= 只在白名单里的 GET 下载路径生效（iframe/img/新标签带不了鉴权头），
  // 其余接口一律只认 Authorization 头——token 进 URL 会漏进访问日志/浏览器历史/Referer（体检22）
  const token = (rreq.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || (urlTokenAllowed(rreq.method || 'GET', path) ? (url.searchParams.get('token') || '') : '')
  // 会话校验现在会写库(续期/清理)，可能抛(如 SQLITE_BUSY)——包起来兜底，别让请求悬挂到超时
  let user: User | null
  try { user = token ? sessionUser(db, token) : null }
  catch (e: any) { res.writeHead(500); return res.end(JSON.stringify({ error: '会话校验失败：' + (e?.message || '服务器错误') })) }
  // 一切接口都要登录（只放行登录接口本身）——GET 也不例外，合同/样品/报告等敏感数据不许裸奔
  if (path !== '/api/login' && !user) {
    res.writeHead(401); return res.end(JSON.stringify({ error: '请先登录' }))
  }
  // 初始/被重置密码未改的用户：挡在门外，只放行查看本人、改密、登出——防止用弱口令干实事
  if (needsPasswordChange(user, path)) {
    res.writeHead(403); return res.end(JSON.stringify({ error: '请先修改初始密码后再使用系统', must_change_pw: true }))
  }

  // —— 合同原件：二进制上传/下载，绕开 JSON 解析 ——
  const docM = path.match(/^\/api\/contracts\/([^/]+)\/doc$/)
  if (docM) {
    const cid = decodeURIComponent(docM[1])
    // 合同号只允许字母数字/下划线/短横，且必须是真实存在的合同——堵住 ../ 路径穿越
    if (!/^[A-Za-z0-9_-]+$/.test(cid) || !getContractRow(db, cid)) {
      res.writeHead(400); return res.end(JSON.stringify({ error: '合同号非法或不存在' }))
    }
    if (rreq.method === 'POST') {
      // 合同原件是合同管理动作：不是谁登录都能换（防采样/检测账号覆盖原件）
      if (!hasRole(user, ...PERM.contract_edit)) { res.writeHead(403); return res.end(JSON.stringify({ error: '此操作需要登记员/技术负责人权限' })) }
      try {
        const name = (url.searchParams.get('name') || 'contract').replace(/[^\w.\-一-龥]/g, '_')
        // 类型白名单：合同原件只收 PDF/图片/Word，别让 .exe 之类躺在证据盘里
        const DOC_EXT = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.doc', '.docx'])
        const ext = extname(name).toLowerCase()
        if (!DOC_EXT.has(ext)) { res.writeHead(400); return res.end(JSON.stringify({ error: '合同原件只支持 PDF / 图片 / Word' })) }
        const buf = await readRaw(rreq)
        if (!buf.length) { res.writeHead(400); return res.end(JSON.stringify({ error: '文件为空' })) }
        // 同名重传不静默覆盖：落盘名带时间戳，旧件留档可查（doc_path 指向最新）
        const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
        const file = `${cid}-${stamp}-${name}`
        writeFileSync(join(UPLOAD_DIR, file), buf)
        const prev = getContractRow(db, cid)?.doc_path
        setContractDoc(db, cid, name, file)
        logAction(db, cid, user, 'doc_upload', { name, file, replaced: prev || null })
        res.writeHead(200); return res.end(JSON.stringify({ ok: true, doc_name: name }))
      } catch (e: any) {
        const code = e instanceof HttpErr ? e.code : 400
        res.writeHead(code); return res.end(JSON.stringify({ error: e.message }))
      }
    }
    if (rreq.method === 'GET') {
      // 合同原件（含金额条款的扫描件）下载限：合同管理角色 + 报告链上的签字/复核/审核（体检8b）
      if (!hasRole(user, ...PERM.contract_edit, 'signer', 'reviewer', 'approver')) {
        res.writeHead(403); return res.end(JSON.stringify({ error: '查看合同原件需要 登记员/技术负责人/授权签字人/复核员/审核员 权限' }))
      }
      const row = getContractRow(db, cid)
      if (!row?.doc_path || !existsSync(join(UPLOAD_DIR, row.doc_path))) { res.writeHead(404); return res.end(JSON.stringify({ error: '暂无合同原件' })) }
      const buf = readFileSync(join(UPLOAD_DIR, row.doc_path))
      res.setHeader('Content-Type', MIME[extname(row.doc_name || '').toLowerCase()] || 'application/octet-stream')
      res.writeHead(200); return res.end(buf)
    }
  }

  // —— 记录附件：二进制上传 / 下载，绕开 JSON 解析 ——
  // —— 离线现场附件暂存：整文件幂等上传 + 丢响应状态查询 + 显式取消 ——
  // 受管设备身份只来自服务端 registry；请求头不能自报 deviceId 或绕过逐请求设备校验。
  const stagedCollection = path.match(/^\/api\/rounds\/([^/]+)\/staged-attachments$/)
  const stagedItem = path.match(/^\/api\/rounds\/([^/]+)\/staged-attachments\/([^/]+)$/)
  if ((stagedCollection || stagedItem) && !user) { res.setHeader('Cache-Control', 'private, no-store'); res.writeHead(401); return res.end(JSON.stringify({ error: '请先登录', error_code: 'AUTH_REQUIRED' })) }
  if (stagedCollection && rreq.method === 'POST') {
    opportunisticStagingGc()
    res.setHeader('Cache-Control', 'private, no-store')
    const roundId = decodeURIComponent(stagedCollection[1]), device = managedStagingDevice(user!, roundId)
    const clientAttachmentId = String(rreq.headers['x-client-attachment-id'] || '')
    let sampleSlotId = ''; try { sampleSlotId = decodeURIComponent(String(rreq.headers['x-sample-slot-id'] || '')) } catch { sampleSlotId = '' }
    const hash = String(rreq.headers['x-content-sha256'] || ''), mime = String(rreq.headers['content-type'] || ''), size = Number(rreq.headers['x-content-size']), revision = Number(rreq.headers['x-content-revision'])
    let concurrencyKey = ''
    try {
      const declaredLength = Number(rreq.headers['content-length'])
      if (!Number.isFinite(declaredLength) || declaredLength <= 0 || declaredLength > 10 * 1024 * 1024 || declaredLength !== size) throw new HttpErr(413, 'ATTACHMENT_SIZE_MISMATCH')
      if (!device) throw new HttpErr(403, 'MANAGED_DEVICE_REQUIRED')
      concurrencyKey = `${user!.username}|${device.deviceId}`; const active = stagingUploads.get(concurrencyKey) ?? 0
      if (active >= 2) throw new HttpErr(429, 'ATTACHMENT_CONCURRENCY_LIMIT')
      stagingUploads.set(concurrencyKey, active + 1)
      const bytes = await readRaw(rreq, 10 * 1024 * 1024)
      if (detectImageMime(bytes) !== mime) throw new HttpErr(400, 'ATTACHMENT_MAGIC_MISMATCH')
      const bodyHash = createHash('sha256').update(bytes).digest('hex')
      const proof = verifyDeviceRequest(device, user!, rreq, { method: 'POST', path, roundId, sampleSlotId, attachmentId: clientAttachmentId, hash, size, mime, bodyHash })
      const staged = stageAttachment(db, { roundId, sampleSlotId, clientAttachmentId, hash, mime, size, revision }, bytes, user!, { managedDeviceId: proof.deviceId,requestNonce:proof.requestNonce })
      res.writeHead(200); return res.end(JSON.stringify(staged))
    } catch (e: any) {
      const code = /device_request_nonces/.test(e?.message||'') ? 409 : Number.isInteger(e?.code) ? e.code : Number.isInteger(e?.httpCode) ? e.httpCode : e?.message === 'MANAGED_DEVICE_REQUIRED' ? 403 : 400
      if(code===429)res.setHeader('Retry-After','5')
      res.writeHead(code); return res.end(JSON.stringify({ error: e.message || '暂存上传失败', ...(e?.errorCode ? { error_code: e.errorCode } : {}) }))
    } finally {
      if (concurrencyKey) { const n=(stagingUploads.get(concurrencyKey)??1)-1;if(n>0)stagingUploads.set(concurrencyKey,n);else stagingUploads.delete(concurrencyKey) }
    }
  }
  if (stagedItem && rreq.method === 'GET') {
    res.setHeader('Cache-Control', 'private, no-store')
    const roundId = decodeURIComponent(stagedItem[1]), clientAttachmentId = decodeURIComponent(stagedItem[2]), device = managedStagingDevice(user!, roundId)
    try { const proof = verifyDeviceRequest(device, user!, rreq, { method: 'GET', path, roundId, attachmentId: clientAttachmentId, bodyHash: createHash('sha256').update('').digest('hex') }); const result = getStagedAttachmentStatus(db, roundId, clientAttachmentId, user!, { managedDeviceId: proof.deviceId,requestNonce:proof.requestNonce }); res.writeHead(200); return res.end(JSON.stringify(result)) }
    catch (e: any) { const code = /device_request_nonces/.test(e?.message||'') ? 409 : Number.isInteger(e?.code) ? e.code : Number.isInteger(e?.httpCode) ? e.httpCode : e?.message === 'MANAGED_DEVICE_REQUIRED' ? 403 : 400; res.writeHead(code); return res.end(JSON.stringify({ error: e.message || '暂存状态查询失败', ...(e?.errorCode ? { error_code: e.errorCode } : {}) })) }
  }
  if (stagedItem && rreq.method === 'POST' && url.searchParams.get('action') === 'cancel') {
    res.setHeader('Cache-Control', 'private, no-store')
    const roundId = decodeURIComponent(stagedItem[1]), clientAttachmentId = decodeURIComponent(stagedItem[2]), device = managedStagingDevice(user!, roundId)
    try {
      const proof = verifyDeviceRequest(device, user!, rreq, { method: 'POST', path, roundId, attachmentId: clientAttachmentId, bodyHash: createHash('sha256').update('').digest('hex') })
      const result = cancelStagedAttachment(db, roundId, clientAttachmentId, user!, { managedDeviceId: proof.deviceId,requestNonce:proof.requestNonce })
      res.writeHead(200); return res.end(JSON.stringify({ receiptId: result.receiptId, status: result.status }))
    } catch (e: any) { const code = /device_request_nonces/.test(e?.message||'') ? 409 : Number.isInteger(e?.code) ? e.code : Number.isInteger(e?.httpCode) ? e.httpCode : e?.message === 'MANAGED_DEVICE_REQUIRED' ? 403 : 400; res.writeHead(code); return res.end(JSON.stringify({ error: e.message || '暂存取消失败', ...(e?.errorCode ? { error_code: e.errorCode } : {}) })) }
  }

  const ATTACH_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.pdf'])
  const ATTACH_MAX = 10 * 1024 * 1024   // 单文件 10MB 上限
  // 上传：POST /api/attachments/:type/:id?name=xxx.jpg
  // 正则限死在已知记录类型上，避免误吞 /api/attachments/:aid/delete 与 /file/:aid（走各自路由）
  const upM = path.match(new RegExp(`^/api/attachments/(${ATTACH_ENTITY_TYPES.join('|')})/([^/]+)$`))
  if (upM && rreq.method === 'POST') {
    const type = decodeURIComponent(upM[1]) as AttachEntityType
    const entityId = decodeURIComponent(upM[2])
    // 按实体的角色白名单（体检17）：report 限报告链上的人（签字人能传盖章扫描件），system_record 只许 tech，
    // 其余实体维持 attach_upload 名单
    if (!canManageAttachment(user, type)) { res.writeHead(403); return res.end(JSON.stringify({ error: attachRoleErrorText(type) })) }
    try {
      const origName = (url.searchParams.get('name') || 'file').replace(/[^\w.\-一-龥]/g, '_')
      const ext = extname(origName).toLowerCase()
      if (!ATTACH_EXT.has(ext)) { res.writeHead(400); return res.end(JSON.stringify({ error: '只支持图片或 PDF' })) }
      const buf = await readRaw(rreq)
      if (buf.length === 0) { res.writeHead(400); return res.end(JSON.stringify({ error: '文件为空' })) }
      if (buf.length > ATTACH_MAX) { res.writeHead(400); return res.end(JSON.stringify({ error: '文件超过 10MB' })) }
      const storedName = `${randomUUID()}${ext}`               // 落盘名随机，杜绝路径穿越/重名覆盖
      writeFileSync(join(UPLOAD_DIR, storedName), buf)
      // 落盘后入库，若入库失败（记录不存在/已定稿冻结）删掉孤儿文件，别让证据盘堆垃圾
      let a
      try {
        a = addAttachment(db, { entityType: type, entityId, origName, storedName, mime: MIME[ext], size: buf.length }, user!)
      } catch (e) {
        try { unlinkSync(join(UPLOAD_DIR, storedName)) } catch { /* 已不在就算了 */ }
        throw e
      }
      res.writeHead(200); return res.end(JSON.stringify({ ok: true, id: a.id, orig_name: a.orig_name }))
    } catch (e: any) {
      // 记录不存在 / 已定稿冻结 → 400；对象越权保留稳定 403 语义。
      const code = Number.isInteger(e?.httpCode) ? e.httpCode : 400
      res.writeHead(code); return res.end(JSON.stringify({ error: e.message || '上传失败', ...(e?.errorCode ? { error_code: e.errorCode } : {}) }))
    }
  }
  // 下载：GET /api/attachments/file/:aid
  const adlM = path.match(/^\/api\/attachments\/file\/([^/]+)$/)
  if (adlM && rreq.method === 'GET') {
    let a
    try { a = getAttachment(db, decodeURIComponent(adlM[1]), user!) }
    catch (e: any) {
      const code = Number.isInteger(e?.httpCode) ? e.httpCode : 400
      res.writeHead(code); return res.end(JSON.stringify({ error: e.message || '下载失败', ...(e?.errorCode ? { error_code: e.errorCode } : {}) }))
    }
    if (!a || !existsSync(join(UPLOAD_DIR, a.stored_name))) { res.writeHead(404); return res.end(JSON.stringify({ error: '附件不存在' })) }
    res.setHeader('Content-Type', a.mime || MIME[extname(a.stored_name).toLowerCase()] || 'application/octet-stream')
    const buf = readFileSync(join(UPLOAD_DIR, a.stored_name))
    res.writeHead(200); return res.end(buf)
  }

  const fn = match(rreq.method || 'GET', path)
  if (!fn) { res.writeHead(404); return res.end(JSON.stringify({ error: '接口不存在: ' + path })) }

  try {
    const body = await readBody(rreq)
    const result = await fn({ method: rreq.method!, parts: path.split('/'), query: url.searchParams, body, headers: rreq.headers, user, token, setHeader: (name, value) => res.setHeader(name, value) })
    res.writeHead(200); res.end(JSON.stringify(result ?? null))
  } catch (e: any) {
    // 业务校验错（handlers 里 throw new Error）算 400 客户端错误，只有真异常才 500——
    // 否则监控里分不清「用户少填一格」和「服务器炸了」
    const code = e instanceof HttpErr ? e.code
      : Number.isInteger(e?.httpCode) ? e.httpCode   // 业务层 httpError()：登录锁定 429 / 越权 403 等
      : (e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError) ? 500 : 400
    if (code >= 500) console.error('[500]', rreq.method, path, e)
    res.writeHead(code); res.end(JSON.stringify({ error: e.message || '服务器错误', ...(e?.errorCode ? { error_code: e.errorCode } : {}) }))
  }
})

// 请求体上限：JSON 2MB、文件 20MB。边收边判，超了立刻断开——
// 全量读进内存再判等于把「传个大文件」变成打挂进程的按钮
const JSON_MAX = 2 * 1024 * 1024
const RAW_MAX = 20 * 1024 * 1024
function readLimited(rreq: import('node:http').IncomingMessage, max: number, what: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(rreq.headers['content-length'] || 0)
    if (declared > max) return reject(new HttpErr(413, `${what}超过 ${Math.round(max / 1024 / 1024)}MB 上限`))
    const chunks: Buffer[] = []
    let size = 0
    rreq.on('data', c => {
      size += c.length
      if (size > max) { rreq.destroy(); return reject(new HttpErr(413, `${what}超过 ${Math.round(max / 1024 / 1024)}MB 上限`)) }
      chunks.push(c)
    })
    rreq.on('end', () => resolve(Buffer.concat(chunks)))
    rreq.on('error', reject)
  })
}
async function readBody(rreq: import('node:http').IncomingMessage): Promise<any> {
  const raw = (await readLimited(rreq, JSON_MAX, '请求体')).toString('utf8')
  if (!raw) return {}
  let v: any
  try { v = JSON.parse(raw) } catch { throw new HttpErr(400, '请求体不是合法 JSON') }
  // body 为 null/数组时下游 c.body.x 会 TypeError → 统一成对象，缺参数报 400 而不是 500
  return v && typeof v === 'object' ? v : {}
}

function readRaw(rreq: import('node:http').IncomingMessage, max = RAW_MAX): Promise<Buffer> {
  return readLimited(rreq, max, '文件')
}

server.on('close',stopStagingGc)
server.listen(PORT, () => console.log(`环境检测 LIMS 后端已启动 → http://localhost:${PORT}`))
