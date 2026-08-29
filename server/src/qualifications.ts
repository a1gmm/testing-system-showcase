import type { DB } from './db.ts'
import { hasRole, type User } from './actor.ts'
import { inTx } from './transaction.ts'
import { captureSingleActorAcceptance, isSingleActorAcceptance, recordAcceptanceOverride } from './acceptanceMode.ts'
import { DomainError } from './domainError.ts'

export const PROFESSIONAL_SCOPES = ['sampling', 'quality', 'laboratory', 'report'] as const
export type ProfessionalScope = typeof PROFESSIONAL_SCOPES[number]
export const QUALIFICATION_CODES = PROFESSIONAL_SCOPES.flatMap(scope => [`${scope}_review`, `${scope}_approve`] as const)
export type QualificationCode = typeof QUALIFICATION_CODES[number]

export type UserQualification = {
  username: string; code: QualificationCode; valid_from: string | null; valid_until: string | null
  status: 'active' | 'inactive'; granted_by: string; granted_at: string
}
export type QualificationInput = QualificationCode | {
  code: QualificationCode; validFrom?: string | null; validUntil?: string | null; status?: 'active' | 'inactive'
}
export type ValidatedQualificationInput = {
  code: QualificationCode; validFrom: string | null; validUntil: string | null; status: 'active' | 'inactive'
}
export type ProjectStageAssignment = {
  id: number; contract_id: string; scope: ProfessionalScope; reviewer_username: string; approver_username: string
  active: boolean; reason: string | null; assigned_by: string; assigned_at: string
}
export type WorkflowCandidate = { username: string; name: string }

const CODE_SET = new Set<string>(QUALIFICATION_CODES)
const SCOPE_SET = new Set<string>(PROFESSIONAL_SCOPES)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function now() { return new Date().toISOString() }
function today(at: string | Date = new Date()) { return typeof at === 'string' ? at.slice(0, 10) : at.toISOString().slice(0, 10) }
function scopeLabel(scope: ProfessionalScope) { return ({ sampling: '采样', quality: '质控', laboratory: '实验室', report: '报告' })[scope] }
function assertScope(scope: string): asserts scope is ProfessionalScope {
  if (!SCOPE_SET.has(scope)) throw new DomainError(400, 'WORKFLOW_SCOPE_INVALID', '不支持的专业环节')
}
function assertCode(code: string): asserts code is QualificationCode {
  if (!CODE_SET.has(code)) throw new DomainError(400, 'QUALIFICATION_CODE_INVALID', '不支持的专业审核资格')
}
function qualificationError(message: string, errorCode: string): Error {
  return new DomainError(400, errorCode, message)
}
function assertQualificationCode(code: unknown): asserts code is QualificationCode {
  if (typeof code !== 'string' || !CODE_SET.has(code)) {
    throw qualificationError('不支持的专业审核资格', 'QUALIFICATION_CODE_INVALID')
  }
}
function assertIsoDate(value: unknown, field: string): asserts value is string | null | undefined {
  if (value == null) return
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw qualificationError(`${field}日期格式应为 YYYY-MM-DD`, 'QUALIFICATION_DATE_INVALID')
  }
  const [year, month, day] = value.split('-').map(Number)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
    throw qualificationError(`${field}必须是有效日期（YYYY-MM-DD）`, 'QUALIFICATION_DATE_INVALID')
  }
}
function assertAdmin(actor: User) {
  if (!hasRole(actor, 'admin')) throw new DomainError(403, 'ADMIN_REQUIRED', '只有系统管理员可以授予专业审核资格')
}
function assertPlanner(actor: User) {
  if (!hasRole(actor, 'planner')) throw new DomainError(403, 'PLANNER_REQUIRED', '只有计划员可以指定项目复核人和审核人')
}
function audit(db: DB, recordId: string, actor: User, action: string, detail: unknown) {
  db.prepare(`INSERT INTO audit_log (record_id, who, username, action, detail, at) VALUES (?,?,?,?,?,?)`)
    .run(recordId, actor.name, actor.username, action, JSON.stringify(detail), now())
}
function rowToQualification(row: any): UserQualification {
  return { ...row, status: row.status as 'active' | 'inactive' }
}
function rowToAssignment(row: any): ProjectStageAssignment {
  return { ...row, active: !!row.active, scope: row.scope as ProfessionalScope }
}

export function validateQualificationInputs(qualifications: unknown): ValidatedQualificationInput[] {
  if (!Array.isArray(qualifications)) {
    throw qualificationError('专业审核资格必须是列表', 'QUALIFICATION_LIST_INVALID')
  }
  const allowedKeys = new Set(['code', 'validFrom', 'validUntil', 'status'])
  const normalised = qualifications.map((item): ValidatedQualificationInput => {
    let value: Record<string, unknown>
    if (typeof item === 'string') value = { code: item }
    else if (item && typeof item === 'object' && !Array.isArray(item)) {
      value = item as Record<string, unknown>
      if (Object.keys(value).some(key => !allowedKeys.has(key))) {
        throw qualificationError('专业审核资格项目格式不正确', 'QUALIFICATION_ITEM_INVALID')
      }
    } else {
      throw qualificationError('专业审核资格项目格式不正确', 'QUALIFICATION_ITEM_INVALID')
    }
    assertQualificationCode(value.code)
    assertIsoDate(value.validFrom, '资格生效')
    assertIsoDate(value.validUntil, '资格失效')
    if (value.validFrom && value.validUntil && value.validFrom > value.validUntil) {
      throw qualificationError('资格失效日期不能早于生效日期', 'QUALIFICATION_DATE_INVALID')
    }
    if (value.status !== undefined && (typeof value.status !== 'string' || (value.status !== 'active' && value.status !== 'inactive'))) {
      throw qualificationError('资格状态不支持', 'QUALIFICATION_STATUS_INVALID')
    }
    return {
      code: value.code,
      validFrom: value.validFrom ?? null,
      validUntil: value.validUntil ?? null,
      status: (value.status ?? 'active') as 'active' | 'inactive',
    }
  })
  if (new Set(normalised.map(item => item.code)).size !== normalised.length) {
    throw qualificationError('专业审核资格不能重复', 'QUALIFICATION_DUPLICATE')
  }
  return normalised
}

export function replaceValidatedUserQualifications(
  db: DB, username: string, qualifications: ValidatedQualificationInput[], actor: User,
): UserQualification[] {
  assertAdmin(actor)
  const user = db.prepare(`SELECT username FROM users WHERE username=?`).get(username)
  if (!user) throw new DomainError(404, 'USER_NOT_FOUND', '用户不存在')
  db.prepare(`DELETE FROM user_qualifications WHERE username=?`).run(username)
  const grantedAt = now()
  for (const item of qualifications) {
    db.prepare(`INSERT INTO user_qualifications (username, code, valid_from, valid_until, status, granted_by, granted_at) VALUES (?,?,?,?,?,?,?)`)
      .run(username, item.code, item.validFrom, item.validUntil, item.status, actor.username, grantedAt)
  }
  audit(db, username, actor, 'user_qualifications_set', { codes: qualifications.map(item => item.code) })
  return getUserQualifications(db, username)
}

export function setUserQualifications(db: DB, username: string, qualifications: QualificationInput[], actor: User): UserQualification[] {
  const validated = validateQualificationInputs(qualifications)
  return inTx(db, () => replaceValidatedUserQualifications(db, username, validated, actor))
}

export function getUserQualifications(db: DB, username: string): UserQualification[] {
  return (db.prepare(`SELECT * FROM user_qualifications WHERE username=? ORDER BY code`).all(username) as any[]).map(rowToQualification)
}

export function listQualifiedUsers(db: DB, code: QualificationCode, at: string | Date = new Date()): { username: string; name: string; code: QualificationCode }[] {
  assertCode(code)
  const day = today(at)
  return db.prepare(`SELECT u.username, u.name, q.code FROM user_qualifications q JOIN users u ON u.username=q.username
    WHERE q.code=? AND q.status='active' AND u.status='active'
      AND (q.valid_from IS NULL OR q.valid_from<=?) AND (q.valid_until IS NULL OR q.valid_until>=?)
    ORDER BY u.name, u.username`).all(code, day, day) as { username: string; name: string; code: QualificationCode }[]
}

export function listWorkflowCandidates(
  db: DB,
  contractId: string,
  scope: string,
  level: string,
  at: string,
): WorkflowCandidate[] {
  assertScope(scope)
  if (level !== 'review' && level !== 'approve') throw qualificationError('审核层级只支持复核或审核', 'WORKFLOW_CANDIDATE_LEVEL_INVALID')
  assertIsoDate(at, '候选资格核验')
  if (!db.prepare(`SELECT 1 FROM contracts WHERE id=?`).get(contractId)) {
    const error: any = new Error('项目不存在')
    error.httpCode = 404
    error.errorCode = 'CONTRACT_NOT_FOUND'
    throw error
  }
  const assignment = getProjectAssignment(db, contractId, scope)
  const oppositeUsername = level === 'review' ? assignment?.approver_username : assignment?.reviewer_username
  return listQualifiedUsers(db, `${scope}_${level}` as QualificationCode, at)
    .filter(candidate => candidate.username !== oppositeUsername
      || isSingleActorAcceptance(db, candidate))
    .map(({ username, name }) => ({ username, name }))
}

function assertQualifiedUser(db: DB, username: string, code: QualificationCode, scope: ProfessionalScope, kind: '复核' | '审核', at?: string | Date) {
  const qualified = listQualifiedUsers(db, code, at).some(user => user.username === username)
  if (!qualified) throw new DomainError(403, 'WORKFLOW_QUALIFICATION_REQUIRED', `${username}没有有效的${scopeLabel(scope)}${kind}资格`)
}

export function getProjectAssignment(db: DB, contractId: string, scope: ProfessionalScope): ProjectStageAssignment | null {
  assertScope(scope)
  const row = db.prepare(`SELECT * FROM project_stage_assignments WHERE contract_id=? AND scope=? AND active=1`).get(contractId, scope)
  return row ? rowToAssignment(row) : null
}

export function listProjectAssignmentHistory(db: DB, contractId: string, scope: ProfessionalScope): ProjectStageAssignment[] {
  assertScope(scope)
  return (db.prepare(`SELECT * FROM project_stage_assignments WHERE contract_id=? AND scope=? ORDER BY id`).all(contractId, scope) as any[]).map(rowToAssignment)
}

export function assignProjectReviewers(
  db: DB, contractId: string, scope: ProfessionalScope, reviewerUsername: string, approverUsername: string, actor: User, reason?: string,
): ProjectStageAssignment {
  assertScope(scope)
  assertPlanner(actor)
  if (!db.prepare(`SELECT 1 FROM contracts WHERE id=?`).get(contractId)) throw new Error('项目不存在')
  if (!reviewerUsername || !approverUsername) throw new Error('复核人和审核人必填')
  const acceptanceGrant = reviewerUsername === approverUsername
    ? captureSingleActorAcceptance(db, { username: reviewerUsername })
    : null
  if (reviewerUsername === approverUsername && !acceptanceGrant) throw new DomainError(409, 'WORKFLOW_PERSON_NOT_DISTINCT', '复核人和审核人不能是同一账号')
  assertQualifiedUser(db, reviewerUsername, `${scope}_review` as QualificationCode, scope, '复核')
  assertQualifiedUser(db, approverUsername, `${scope}_approve` as QualificationCode, scope, '审核')
  const current = getProjectAssignment(db, contractId, scope)
  if (current && current.reviewer_username === reviewerUsername && current.approver_username === approverUsername) return current
  if (current && !String(reason ?? '').trim()) throw new Error('换人原因必填')
  const assignedAt = now()
  let assignment!: ProjectStageAssignment
  inTx(db, () => {
    if (current) db.prepare(`UPDATE project_stage_assignments SET active=0 WHERE id=?`).run(current.id)
    const result = db.prepare(`INSERT INTO project_stage_assignments
      (contract_id, scope, reviewer_username, approver_username, active, reason, assigned_by, assigned_at)
      VALUES (?,?,?,?,1,?,?,?)`).run(contractId, scope, reviewerUsername, approverUsername, reason?.trim() || null, actor.username, assignedAt)
    assignment = rowToAssignment(db.prepare(`SELECT * FROM project_stage_assignments WHERE id=?`).get(Number(result.lastInsertRowid)))
    audit(db, contractId, actor, 'project_stage_assignment_set', { scope, reviewerUsername, approverUsername, reason: reason?.trim() || null, replacedAssignmentId: current?.id ?? null })
    if (acceptanceGrant) recordAcceptanceOverride(db, acceptanceGrant, 'workflow_assignment', contractId,
      '复核人与审核人必须使用不同账号', { scope, reviewerUsername, approverUsername, assignedBy: actor.username })
  })
  return assignment
}

export function assertAssignedDecisionActor(
  db: DB, contractId: string, scope: ProfessionalScope, level: 'review' | 'approve' | 'reviewer' | 'approver', actor: User, at?: string | Date,
): ProjectStageAssignment {
  assertScope(scope)
  const assignment = getProjectAssignment(db, contractId, scope)
  if (!assignment) throw new DomainError(409, 'WORKFLOW_ASSIGNMENT_REQUIRED', '项目尚未指定复核人和审核人')
  const isReview = level === 'review' || level === 'reviewer'
  const expected = isReview ? assignment.reviewer_username : assignment.approver_username
  if (actor.username !== expected) throw new DomainError(403, 'WORKFLOW_WRONG_ASSIGNEE', `当前账号不是项目指定的${isReview ? '复核人' : '审核人'}`)
  assertQualifiedUser(db, actor.username, `${scope}_${isReview ? 'review' : 'approve'}` as QualificationCode, scope, isReview ? '复核' : '审核', at)
  return assignment
}
