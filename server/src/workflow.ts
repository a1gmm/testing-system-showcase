import { createHash, randomUUID } from 'node:crypto'
import type { DB } from './db.ts'
import type { User } from './actor.ts'
import {
  captureSingleActorWorkflowAcceptance,
  recordAcceptanceOverride,
  type AcceptanceGrant,
} from './acceptanceMode.ts'
import { DomainError } from './domainError.ts'
import {
  assertAssignedDecisionActor,
  getProjectAssignment,
  listQualifiedUsers,
  PROFESSIONAL_SCOPES,
  type ProfessionalScope,
} from './qualifications.ts'

export const WORKFLOW_SUBJECT_TYPES = ['round_sampling', 'quality_plan', 'lab_record', 'report'] as const
export type WorkflowSubjectType = typeof WORKFLOW_SUBJECT_TYPES[number]
export const WORKFLOW_STATUSES = ['draft', 'pending_review', 'pending_approval', 'approved', 'rejected', 'withdrawn'] as const
export type WorkflowStatus = typeof WORKFLOW_STATUSES[number]
export type WorkflowDecisionLevel = 'review' | 'approve'
export type WorkflowDecision = 'approve' | 'reject'

export type SubmitWorkflowInput = {
  contractId: string
  roundId?: string
  scope: ProfessionalScope
  subjectType: WorkflowSubjectType
  subjectId: string
  snapshot: Record<string, unknown>
}

export type WorkflowRevision = {
  revision: number
  snapshot: Record<string, unknown>
  snapshot_json: string
  snapshot_sha256: string
  submitted_by: string
  submitted_at: string
}
export type WorkflowDecisionEntry = {
  id: number
  revision: number
  level: WorkflowDecisionLevel
  decision: WorkflowDecision
  comment: string
  decided_by: string
  decided_at: string
}
export type WorkflowInstance = {
  id: string
  contract_id: string
  round_id: string | null
  scope: ProfessionalScope
  subject_type: WorkflowSubjectType
  subject_id: string
  status: WorkflowStatus
  current_revision: number
  created_by: string
  created_at: string
  withdrawn_reason: string | null
  withdrawn_by: string | null
  withdrawn_at: string | null
}
export type WorkflowView = WorkflowInstance & { revisions: WorkflowRevision[]; decisions: WorkflowDecisionEntry[] }
export type WorkflowTaskDto = {
  workflow_instance_id: string
  subject_type: WorkflowSubjectType
  subject_id: string
  contract_id: string
  status: 'pending_review' | 'pending_approval'
  current_revision: number
  decision_level: WorkflowDecisionLevel
  acting_capacity: string
}

const SUBJECT_SCOPE: Record<WorkflowSubjectType, ProfessionalScope> = {
  round_sampling: 'sampling', quality_plan: 'quality', lab_record: 'laboratory', report: 'report',
}
const SUBJECT_TYPES = new Set<string>(WORKFLOW_SUBJECT_TYPES)

function now() { return new Date().toISOString() }
let transactionSequence = 0
function transaction<T>(db: DB, operation: () => T): T {
  const savepoint = `workflow_${++transactionSequence}`
  db.exec(`SAVEPOINT ${savepoint}`)
  try {
    const result = operation()
    db.exec(`RELEASE ${savepoint}`)
    return result
  } catch (error) {
    db.exec(`ROLLBACK TO ${savepoint}`)
    db.exec(`RELEASE ${savepoint}`)
    throw error
  }
}
function required(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${field}必填`)
  return text
}
function assertSubjectScope(subjectType: string, scope: ProfessionalScope): asserts subjectType is WorkflowSubjectType {
  if (!SUBJECT_TYPES.has(subjectType)) throw new Error('不支持的工作流对象')
  if (SUBJECT_SCOPE[subjectType as WorkflowSubjectType] !== scope) throw new Error('工作流对象与专业环节不匹配')
}
function canonicalJson(snapshot: Record<string, unknown>): string {
  const seen = new WeakSet<object>()
  const normalise = (value: unknown): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('快照必须是有效 JSON')
      return value
    }
    if (Array.isArray(value)) return value.map(normalise)
    if (typeof value === 'object') {
      if (seen.has(value)) throw new Error('快照不能包含循环引用')
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) throw new Error('快照必须是普通 JSON 对象')
      seen.add(value)
      const result: Record<string, unknown> = {}
      for (const key of Object.keys(value as Record<string, unknown>).sort()) result[key] = normalise((value as Record<string, unknown>)[key])
      seen.delete(value)
      return result
    }
    throw new Error('快照必须是有效 JSON')
  }
  return JSON.stringify(normalise(snapshot))
}
function hashSnapshot(snapshotJson: string) { return createHash('sha256').update(snapshotJson).digest('hex') }
function rowToInstance(row: any): WorkflowInstance {
  return {
    ...row,
    current_revision: Number(row.current_revision),
    scope: row.scope as ProfessionalScope,
    subject_type: row.subject_type as WorkflowSubjectType,
    status: row.status as WorkflowStatus,
  }
}
function getInstance(db: DB, instanceId: string): WorkflowInstance {
  const row = db.prepare(`SELECT * FROM workflow_instances WHERE id=?`).get(instanceId)
  if (!row) throw new DomainError(404, 'WORKFLOW_NOT_FOUND', '工作流不存在')
  return rowToInstance(row)
}
function assertAuthorIsIndependent(db: DB, contractId: string, scope: ProfessionalScope, actor: User): AcceptanceGrant | null {
  const assignment = getProjectAssignment(db, contractId, scope)
  if (!assignment) throw new DomainError(409, 'WORKFLOW_ASSIGNMENT_REQUIRED', '项目尚未指定复核人和审核人')
  const grant = captureSingleActorWorkflowAcceptance(db, actor, assignment)
  if (grant) return grant
  if (actor.username === assignment.reviewer_username || actor.username === assignment.approver_username) {
    throw new DomainError(409, 'WORKFLOW_PERSON_NOT_DISTINCT', '编制人与复核人和审核人必须不同')
  }
  return null
}
function selectView(db: DB, instance: WorkflowInstance): WorkflowView {
  const revisions = (db.prepare(`SELECT revision, snapshot_json, snapshot_sha256, submitted_by, submitted_at
    FROM workflow_revisions WHERE instance_id=? ORDER BY revision`).all(instance.id) as any[]).map(row => ({
    ...row, revision: Number(row.revision), snapshot: JSON.parse(row.snapshot_json) as Record<string, unknown>,
  })) as WorkflowRevision[]
  const decisions = (db.prepare(`SELECT id, revision, level, decision, comment, decided_by, decided_at
    FROM workflow_decisions WHERE instance_id=? ORDER BY revision, id`).all(instance.id) as any[]).map(row => ({
    ...row, id: Number(row.id), revision: Number(row.revision), level: row.level as WorkflowDecisionLevel, decision: row.decision as WorkflowDecision,
  })) as WorkflowDecisionEntry[]
  return { ...instance, revisions, decisions }
}

export function submitWorkflowRevision(db: DB, input: SubmitWorkflowInput, actor: User): WorkflowInstance {
  assertSubjectScope(input.subjectType, input.scope)
  const contractId = required(input.contractId, '合同')
  const subjectId = required(input.subjectId, '工作流对象')
  const snapshotJson = canonicalJson(input.snapshot)
  const snapshotHash = hashSnapshot(snapshotJson)
  return transaction(db, () => {
    const acceptanceGrant = assertAuthorIsIndependent(db, contractId, input.scope, actor)
    const existingRow = db.prepare(`SELECT * FROM workflow_instances WHERE subject_type=? AND subject_id=?`).get(input.subjectType, subjectId)
    const submittedAt = now()
    if (!existingRow) {
      const instance: WorkflowInstance = {
        id: randomUUID(), contract_id: contractId, round_id: input.roundId ?? null, scope: input.scope,
        subject_type: input.subjectType, subject_id: subjectId, status: 'pending_review', current_revision: 1,
        created_by: actor.username, created_at: submittedAt, withdrawn_reason: null, withdrawn_by: null, withdrawn_at: null,
      }
      db.prepare(`INSERT INTO workflow_instances
        (id,contract_id,round_id,scope,subject_type,subject_id,status,current_revision,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        instance.id, instance.contract_id, instance.round_id, instance.scope, instance.subject_type, instance.subject_id,
        instance.status, instance.current_revision, instance.created_by, instance.created_at,
      )
      db.prepare(`INSERT INTO workflow_revisions
        (instance_id,revision,snapshot_json,snapshot_sha256,submitted_by,submitted_at) VALUES (?,?,?,?,?,?)`)
        .run(instance.id, 1, snapshotJson, snapshotHash, actor.username, submittedAt)
      if (acceptanceGrant) recordAcceptanceOverride(db, acceptanceGrant, 'workflow_submit', instance.id,
        '编制人、复核人和审核人必须使用不同账号', { scope: input.scope, subjectType: input.subjectType, subjectId })
      return instance
    }
    const existing = rowToInstance(existingRow)
    if (existing.contract_id !== contractId || existing.scope !== input.scope) throw new Error('工作流对象已绑定到其他合同或专业环节')
    if (existing.status === 'approved') throw new Error('已批准内容已冻结')
    if (existing.created_by !== actor.username) throw new DomainError(403, 'WORKFLOW_WRONG_ASSIGNEE', '只有编制人可以提交新版本')
    if (!['rejected', 'withdrawn'].includes(existing.status)) throw new Error('当前状态不能提交新版本')
    const revision = existing.current_revision + 1
    const updated = db.prepare(`UPDATE workflow_instances
      SET status='pending_review', current_revision=?, withdrawn_reason=NULL, withdrawn_by=NULL, withdrawn_at=NULL
      WHERE id=? AND current_revision=? AND status=?`).run(revision, existing.id, existing.current_revision, existing.status)
    if (updated.changes !== 1) throw new DomainError(409, 'WORKFLOW_STALE_REVISION', '工作流版本冲突，内容已有新版本，请刷新')
    db.prepare(`INSERT INTO workflow_revisions
      (instance_id,revision,snapshot_json,snapshot_sha256,submitted_by,submitted_at) VALUES (?,?,?,?,?,?)`)
      .run(existing.id, revision, snapshotJson, snapshotHash, actor.username, submittedAt)
    if (acceptanceGrant) recordAcceptanceOverride(db, acceptanceGrant, 'workflow_submit', existing.id,
      '编制人、复核人和审核人必须使用不同账号', { scope: input.scope, subjectType: input.subjectType, subjectId, revision })
    return { ...existing, status: 'pending_review', current_revision: revision, withdrawn_reason: null, withdrawn_by: null, withdrawn_at: null }
  })
}

export function decideWorkflow(
  db: DB, instanceId: string, revision: number, level: WorkflowDecisionLevel, decision: WorkflowDecision, comment: string, actor: User,
): WorkflowInstance {
  if (!Number.isInteger(revision) || revision < 1) throw new Error('工作流版本不合法')
  if (level !== 'review' && level !== 'approve') throw new Error('审核级别不合法')
  if (decision !== 'approve' && decision !== 'reject') throw new Error('审核决定不合法')
  const normalisedComment = String(comment ?? '').trim()
  if (decision === 'reject' && !normalisedComment) throw new Error('驳回意见必填')
  return transaction(db, () => {
    const instance = getInstance(db, instanceId)
    if (instance.current_revision !== revision) throw new DomainError(409, 'WORKFLOW_STALE_REVISION', '工作流版本冲突，内容已有新版本，请刷新')
    const assignment = getProjectAssignment(db, instance.contract_id, instance.scope)
    const acceptanceGrant = captureSingleActorWorkflowAcceptance(db, actor, assignment)
    if (!acceptanceGrant && actor.username === instance.created_by) throw new DomainError(409, 'WORKFLOW_PERSON_NOT_DISTINCT', '编制人与复核人和审核人必须不同')
    const expectedStatus: WorkflowStatus = level === 'review' ? 'pending_review' : 'pending_approval'
    if (instance.status !== expectedStatus) throw new Error(level === 'review' ? '当前工作流不在待复核状态' : '当前工作流不在待审核状态')
    assertAssignedDecisionActor(db, instance.contract_id, instance.scope, level, actor)
    if (level === 'approve') {
      const review = db.prepare(`SELECT decided_by FROM workflow_decisions
        WHERE instance_id=? AND revision=? AND level='review'`).get(instance.id, revision) as { decided_by: string } | undefined
      if (!acceptanceGrant && review?.decided_by === actor.username) throw new DomainError(409, 'WORKFLOW_PERSON_NOT_DISTINCT', '复核人与审核人必须不同')
    }
    const nextStatus: WorkflowStatus = decision === 'reject' ? 'rejected' : (level === 'review' ? 'pending_approval' : 'approved')
    const updated = db.prepare(`UPDATE workflow_instances SET status=? WHERE id=? AND current_revision=? AND status=?`)
      .run(nextStatus, instance.id, revision, expectedStatus)
    if (updated.changes !== 1) throw new DomainError(409, 'WORKFLOW_STALE_REVISION', '工作流版本冲突，内容已有新版本，请刷新')
    db.prepare(`INSERT INTO workflow_decisions (instance_id,revision,level,decision,comment,decided_by,decided_at)
      VALUES (?,?,?,?,?,?,?)`).run(instance.id, revision, level, decision, normalisedComment, actor.username, now())
    if (acceptanceGrant) recordAcceptanceOverride(db, acceptanceGrant, `workflow_${level}`, instance.id,
      '编制人、复核人和审核人必须使用不同账号', {
        scope: instance.scope, subjectType: instance.subject_type, subjectId: instance.subject_id, revision, decision,
      })
    return { ...instance, status: nextStatus }
  })
}

export function withdrawWorkflow(db: DB, instanceId: string, reason: string, actor: User): WorkflowInstance {
  const normalisedReason = required(reason, '撤回原因')
  return transaction(db, () => {
    const instance = getInstance(db, instanceId)
    if (instance.created_by !== actor.username) throw new DomainError(403, 'WORKFLOW_WRONG_ASSIGNEE', '只有编制人可以撤回工作流')
    const storedActor = db.prepare(`SELECT status FROM users WHERE username=?`).get(actor.username) as { status: string } | undefined
    if (!storedActor || storedActor.status !== 'active') throw new DomainError(403, 'WORKFLOW_QUALIFICATION_REQUIRED', '只有在职的原编制人可以撤回工作流')
    if (!['pending_review', 'pending_approval', 'approved'].includes(instance.status)) throw new Error('当前状态不能撤回')
    const withdrawnAt = now()
    const updated = db.prepare(`UPDATE workflow_instances
      SET status='withdrawn', withdrawn_reason=?, withdrawn_by=?, withdrawn_at=?
      WHERE id=? AND current_revision=? AND status=?`).run(
      normalisedReason, actor.username, withdrawnAt, instance.id, instance.current_revision, instance.status,
    )
    if (updated.changes !== 1) throw new DomainError(409, 'WORKFLOW_STALE_REVISION', '工作流版本冲突，内容已有新版本，请刷新')
    return { ...instance, status: 'withdrawn', withdrawn_reason: normalisedReason, withdrawn_by: actor.username, withdrawn_at: withdrawnAt }
  })
}

export function getWorkflowView(db: DB, subjectType: WorkflowSubjectType, subjectId: string): WorkflowView | null {
  if (!SUBJECT_TYPES.has(subjectType)) throw new Error('不支持的工作流对象')
  const row = db.prepare(`SELECT * FROM workflow_instances WHERE subject_type=? AND subject_id=?`).get(subjectType, subjectId)
  return row ? selectView(db, rowToInstance(row)) : null
}

const ACTING_CAPACITY: Record<ProfessionalScope, Record<WorkflowDecisionLevel, string>> = {
  sampling: { review: '采样复核', approve: '采样审核' },
  quality: { review: '质控复核', approve: '质控审核' },
  laboratory: { review: '实验室复核', approve: '实验室审核' },
  report: { review: '报告复核', approve: '报告审核' },
}

export function listActorWorkflowTasks(db: DB, scope: string, actor: User, at: string | Date = new Date()): WorkflowTaskDto[] {
  if (!PROFESSIONAL_SCOPES.includes(scope as ProfessionalScope)) throw new Error('不支持的专业环节')
  const professionalScope = scope as ProfessionalScope
  const qualifiedForReview = listQualifiedUsers(db, `${professionalScope}_review`, at).some(user => user.username === actor.username)
  const qualifiedForApproval = listQualifiedUsers(db, `${professionalScope}_approve`, at).some(user => user.username === actor.username)
  if (!qualifiedForReview && !qualifiedForApproval) return []

  return (db.prepare(`SELECT workflow.* FROM workflow_instances workflow
    JOIN project_stage_assignments assignment
      ON assignment.contract_id=workflow.contract_id AND assignment.scope=workflow.scope AND assignment.active=1
    WHERE workflow.scope=? AND (
      (workflow.status='pending_review' AND ?=1 AND assignment.reviewer_username=?) OR
      (workflow.status='pending_approval' AND ?=1 AND assignment.approver_username=?)
    ) ORDER BY workflow.created_at, workflow.id`)
    .all(professionalScope, qualifiedForReview ? 1 : 0, actor.username, qualifiedForApproval ? 1 : 0, actor.username) as any[])
    .map(rowToInstance)
    .map(instance => {
      const decisionLevel: WorkflowDecisionLevel = instance.status === 'pending_review' ? 'review' : 'approve'
      return {
        workflow_instance_id: instance.id,
        subject_type: instance.subject_type,
        subject_id: instance.subject_id,
        contract_id: instance.contract_id,
        status: instance.status as WorkflowTaskDto['status'],
        current_revision: instance.current_revision,
        decision_level: decisionLevel,
        acting_capacity: ACTING_CAPACITY[professionalScope][decisionLevel],
      }
    })
}

// Submitted evidence becomes immutable until rejection/withdrawal reopens the
// authoring surface. Approved evidence is permanently frozen.
export function assertWorkflowEditable(db: DB, subjectType: WorkflowSubjectType, subjectId: string) {
  const workflow = getWorkflowView(db, subjectType, subjectId)
  if (!workflow || ['rejected', 'withdrawn'].includes(workflow.status)) return
  if (workflow.status === 'approved') throw new Error('已批准内容已冻结')
  throw new Error('内容已提交审核并冻结')
}
