import type { DB } from '../../src/db.ts'
import {
  addHandover,
  confirmHandover,
  createUser,
  getSample,
  reviewRecord,
  saveRecord,
  type RecordRow,
  type User,
} from '../../src/handlers.ts'
import { assignProjectReviewers, getProjectAssignment, setUserQualifications } from '../../src/qualifications.ts'

export const laboratoryTestActors = {
  author: { username: 'test-lab-author', name: '测试分析员', roles: ['analyst'], status: 'active', created_at: '', must_change_pw: false } as User,
  reviewer: { username: 'test-lab-reviewer', name: '测试复核员', roles: [], status: 'active', created_at: '', must_change_pw: false } as User,
  approver: { username: 'test-lab-approver', name: '测试审核员', roles: [], status: 'active', created_at: '', must_change_pw: false } as User,
}
const { author, reviewer, approver } = laboratoryTestActors
const admin: User = { username: 'test-admin', name: '测试管理员', roles: ['admin'], status: 'active', created_at: '', must_change_pw: false }
const planner: User = { username: 'test-planner', name: '测试计划员', roles: ['planner'], status: 'active', created_at: '', must_change_pw: false }

function ensureUser(db: DB, user: User) {
  if (!db.prepare(`SELECT 1 FROM users WHERE username=?`).get(user.username)) {
    createUser(db, { username: user.username, name: user.name, roles: user.roles, password: `secret-${user.username}` })
  }
}

/** Test-only setup that reaches laboratory submission through production APIs. */
export function submitLaboratoryRecord(
  db: DB,
  input: {
    sampleId: string
    code: string
    analyte: string
    method?: string
    data: any
    instrumentId?: string
  },
): RecordRow {
  const sample = getSample(db, input.sampleId)
  if (!sample?.contract_id) {
    return saveRecord(db, { ...input, submit: true })
  }

  for (const user of [author, reviewer, approver]) ensureUser(db, user)
  setUserQualifications(db, reviewer.username, ['laboratory_review'], admin)
  setUserQualifications(db, approver.username, ['laboratory_approve'], admin)
  if (!getProjectAssignment(db, sample.contract_id, 'laboratory')) {
    assignProjectReviewers(db, sample.contract_id, 'laboratory', reviewer.username, approver.username, planner)
  }
  const handover = db.prepare(`SELECT id FROM sample_handovers WHERE sample_id=? AND action='采样交接' AND confirmed_at IS NOT NULL LIMIT 1`)
    .get(sample.id) as { id: number } | undefined
  if (!handover) {
    const created = addHandover(db, sample.id, { action: '采样交接' }, { name: '测试采样员', username: 'test-sampler' })
    confirmHandover(db, created.id, { name: '测试样品管理员', username: 'test-sample-manager' })
  }
  const task = db.prepare(`SELECT id FROM test_tasks WHERE sample_id=? AND analyte=?`).get(sample.id, input.analyte) as { id: number } | undefined
  if (task) {
    db.prepare(`UPDATE test_tasks SET assignee=?,assignee_username=? WHERE id=?`).run(author.name, author.username, task.id)
  } else {
    db.prepare(`INSERT INTO test_tasks(sample_id,analyte,assignee,assignee_username,assigned_by,assigned_at) VALUES(?,?,?,?,?,?)`)
      .run(sample.id, input.analyte, author.name, author.username, '测试质控员', '2026-08-22T00:00:00.000Z')
  }
  return saveRecord(db, { ...input, who: author.name, whoUsername: author.username, submit: true }, { actor: author })
}

/** Test-only setup that reaches laboratory approval through production APIs. */
export function approveLaboratoryRecord(
  db: DB,
  input: {
    sampleId: string
    code: string
    analyte: string
    method?: string
    data: any
    instrumentId?: string
  },
): RecordRow {
  const sample = getSample(db, input.sampleId)
  let record = submitLaboratoryRecord(db, input)
  if (!sample?.contract_id) {
    record = reviewRecord(db, record.id, 'review_pass', reviewer.name)
    return reviewRecord(db, record.id, 'approve', approver.name)
  }
  record = reviewRecord(db, record.id, 'review_pass', reviewer.name, '', reviewer.username)
  return reviewRecord(db, record.id, 'approve', approver.name, '', approver.username)
}
