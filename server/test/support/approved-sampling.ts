import type { DB } from '../../src/db.ts'
import { createUser, getContract, submitSamplingWorkflow, type User } from '../../src/handlers.ts'
import { assignProjectReviewers, getProjectAssignment, setUserQualifications } from '../../src/qualifications.ts'
import { decideWorkflow } from '../../src/workflow.ts'

const REVIEWER_USERNAME = '__test_sampling_reviewer__'
const APPROVER_USERNAME = '__test_sampling_approver__'
const TEST_PASSWORD = 'test-only-secret'

function parseList(value: unknown): any[] {
  if (Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value || '[]'))
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

function persistedActor(db: DB, username: string): User {
  const row = db.prepare(`SELECT username,name,roles,status,created_at,must_change_pw FROM users WHERE username=?`).get(username) as any
  if (!row) throw new Error(`测试采样审批缺少用户：${username}`)
  return { ...row, roles: parseList(row.roles), must_change_pw: !!row.must_change_pw }
}

function ensureUser(db: DB, username: string, name: string): User {
  if (!db.prepare(`SELECT 1 FROM users WHERE username=?`).get(username)) {
    createUser(db, { username, name, roles: [], password: TEST_PASSWORD })
  }
  return persistedActor(db, username)
}

function exactAssignedSampler(db: DB, roundId: string, requested?: Pick<User, 'username' | 'name'>): User {
  const round = db.prepare(`SELECT sampler_ids,assignment_status FROM rounds WHERE id=?`).get(roundId) as any
  if (!round) throw new Error('测试采样审批找不到期次')
  const assigned = parseList(round.sampler_ids)
  if (round.assignment_status !== 'active' || !assigned.length) throw new Error('测试采样审批要求先完成有效派工')
  let username = requested?.username && assigned.includes(requested.username) ? requested.username : ''
  if (!username && requested?.name) {
    const matches = assigned.filter(id => (db.prepare(`SELECT name FROM users WHERE username=?`).get(id) as any)?.name === requested.name)
    if (matches.length === 1) username = matches[0]
  }
  username ||= assigned[0]
  const actor = persistedActor(db, username)
  if (!actor.roles.includes('sampler') || actor.status !== 'active') throw new Error('测试采样审批要求当前派工人为在职采样员')
  return actor
}

/**
 * Test-only setup for legacy fixtures that intentionally exercise behavior
 * after sampling handover. It uses the production qualification, assignment,
 * submission, review, and approval APIs; no runtime gate is bypassed.
 */
export function approveRoundSampling(db: DB, roundId: string, requestedSampler?: Pick<User, 'username' | 'name'>) {
  const round = db.prepare(`SELECT contract_id,items FROM rounds WHERE id=?`).get(roundId) as any
  if (!round) throw new Error('测试采样审批找不到期次')
  if (!parseList(round.items).length) {
    const legacyPlan = getContract(db, round.contract_id)?.plan ?? []
    if (legacyPlan.length) db.prepare(`UPDATE rounds SET items=? WHERE id=?`).run(JSON.stringify(legacyPlan), roundId)
  }
  const sampler = exactAssignedSampler(db, roundId, requestedSampler)
  const reviewer = ensureUser(db, REVIEWER_USERNAME, '测试采样复核')
  const approver = ensureUser(db, APPROVER_USERNAME, '测试采样审核')
  const admin = { username: '__test_admin__', name: '测试管理员', roles: ['admin'], status: 'active', created_at: '', must_change_pw: false } as User
  const planner = { username: '__test_planner__', name: '测试计划员', roles: ['planner'], status: 'active', created_at: '', must_change_pw: false } as User

  setUserQualifications(db, reviewer.username, ['sampling_review'], admin)
  setUserQualifications(db, approver.username, ['sampling_approve'], admin)
  const current = getProjectAssignment(db, round.contract_id, 'sampling')
  assignProjectReviewers(
    db,
    round.contract_id,
    'sampling',
    reviewer.username,
    approver.username,
    planner,
    current && (current.reviewer_username !== reviewer.username || current.approver_username !== approver.username)
      ? '测试切换到固定采样审核人'
      : undefined,
  )

  const workflow = submitSamplingWorkflow(db, roundId, sampler)
  decideWorkflow(db, workflow.id, workflow.current_revision, 'review', 'approve', '', reviewer)
  decideWorkflow(db, workflow.id, workflow.current_revision, 'approve', 'approve', '', approver)
  return { sampler, reviewer, approver, workflow }
}
