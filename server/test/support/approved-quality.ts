import type { DB } from '../../src/db.ts'
import { createUser, getQualityPlan, getUser, saveQualityPlan, submitQualityPlan, type User } from '../../src/handlers.ts'
import { assignProjectReviewers, getProjectAssignment, setUserQualifications } from '../../src/qualifications.ts'
import { decideWorkflow, getWorkflowView } from '../../src/workflow.ts'

const REVIEWER_USERNAME = '__test_quality_reviewer__'
const APPROVER_USERNAME = '__test_quality_approver__'
const TEST_PASSWORD = 'test-only-secret'

function ensureUser(db: DB, username: string, name: string, roles: string[] = []): User {
  if (!getUser(db, username)) createUser(db, { username, name, roles, password: TEST_PASSWORD })
  return getUser(db, username)!
}

/** Test-only setup that reaches an approved quality plan through production APIs. */
export function approveRoundQuality(db: DB, roundId: string, requestedOfficer: Pick<User, 'username' | 'name'>) {
  const round = db.prepare(`SELECT contract_id FROM rounds WHERE id=?`).get(roundId) as any
  if (!round) throw new Error('测试质量审批找不到期次')
  const currentWorkflow = getWorkflowView(db, 'quality_plan', roundId)
  if (currentWorkflow?.status === 'approved') return currentWorkflow
  const officer = ensureUser(db, requestedOfficer.username, requestedOfficer.name, ['qc'])
  if (!officer.roles.includes('qc') || officer.status !== 'active') throw new Error('测试质量审批要求当前编制人为在职质控员')
  const reviewer = ensureUser(db, REVIEWER_USERNAME, '测试质控复核')
  const approver = ensureUser(db, APPROVER_USERNAME, '测试质控审核')
  const admin = { username: '__test_admin__', name: '测试管理员', roles: ['admin'], status: 'active', created_at: '', must_change_pw: false } as User
  const planner = { username: '__test_planner__', name: '测试计划员', roles: ['planner'], status: 'active', created_at: '', must_change_pw: false } as User
  setUserQualifications(db, reviewer.username, ['quality_review'], admin)
  setUserQualifications(db, approver.username, ['quality_approve'], admin)
  const current = getProjectAssignment(db, round.contract_id, 'quality')
  assignProjectReviewers(
    db, round.contract_id, 'quality', reviewer.username, approver.username, planner,
    current && (current.reviewer_username !== reviewer.username || current.approver_username !== approver.username)
      ? '测试切换到固定质控审核人' : undefined,
  )
  if (!getQualityPlan(db, roundId)) saveQualityPlan(db, roundId, { adjustments: [] }, officer)
  const workflow = submitQualityPlan(db, roundId, officer)
  decideWorkflow(db, workflow.id, workflow.current_revision, 'review', 'approve', '', reviewer)
  decideWorkflow(db, workflow.id, workflow.current_revision, 'approve', 'approve', '', approver)
  return getWorkflowView(db, 'quality_plan', roundId)!
}
