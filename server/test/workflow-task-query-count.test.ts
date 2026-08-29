import test from 'node:test'
import assert from 'node:assert/strict'
import type { DB } from '../src/db.ts'
import { openDb } from '../src/db.ts'
import { createContract, createUser, type User } from '../src/handlers.ts'
import { assignProjectReviewers, setUserQualifications } from '../src/qualifications.ts'
import { listActorWorkflowTasks } from '../src/workflow.ts'

function actor(username: string, roles: string[] = []): User {
  return { username, name: username, roles, status: 'active', created_at: '', must_change_pw: false }
}

function countingDb(db: DB) {
  let count = 0
  const proxy = new Proxy(db as any, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => { count += 1; return target.prepare(sql) }
      const value = target[property]
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as DB
  return { proxy, count: () => count }
}

test('actor workflow task projection keeps query count constant as pending work scales', () => {
  const db = openDb(':memory:')
  const admin = actor('admin-work-items', ['admin'])
  const planner = actor('planner-work-items', ['planner'])
  const reviewer = actor('reviewer-work-items')
  const approver = actor('approver-work-items')
  for (const user of [admin, planner, reviewer, approver]) {
    createUser(db, { username: user.username, name: user.name, roles: user.roles, password: 'secret1' })
  }
  setUserQualifications(db, reviewer.username, ['laboratory_review'], admin)
  setUserQualifications(db, approver.username, ['laboratory_approve'], admin)

  for (let index = 1; index <= 20; index += 1) {
    const contract = createContract(db, { client: `任务客户${index}` }, 2026)
    assignProjectReviewers(db, contract.id, 'laboratory', reviewer.username, approver.username, planner)
    db.prepare(`INSERT INTO workflow_instances
      (id,contract_id,scope,subject_type,subject_id,status,current_revision,created_by,created_at)
      VALUES (?,?, 'laboratory','lab_record',?,'pending_review',1,?,?)`)
      .run(`workflow-${index}`, contract.id, `record-${index}`, `author-${index}`, `2026-08-25T00:00:${String(index).padStart(2, '0')}.000Z`)
  }

  const counted = countingDb(db)
  const tasks = listActorWorkflowTasks(counted.proxy, 'laboratory', reviewer, '2026-08-25T12:00:00.000Z')
  assert.equal(tasks.length, 20)
  assert.ok(counted.count() <= 4, `task projection issued ${counted.count()} queries for 20 rows`)
})
