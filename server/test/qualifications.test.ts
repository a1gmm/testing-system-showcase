import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { createContract, createUser, getUser, type User } from '../src/handlers.ts'
import {
  assignProjectReviewers,
  getUserQualifications,
  listWorkflowCandidates,
  listProjectAssignmentHistory,
  setUserQualifications,
} from '../src/qualifications.ts'

function freshDb() { return openDb(':memory:') }
function user(username: string, roles: string[]): User {
  return { username, name: username, roles, status: 'active', created_at: '', must_change_pw: false }
}

test('one user may hold multiple jobs and scoped qualifications', () => {
  const db = freshDb()
  createUser(db, { username: 'u1', name: '多岗人员', roles: ['sampler', 'analyst'], password: 'secret1' })
  const admin = user('admin', ['admin'])

  setUserQualifications(db, 'u1', ['sampling_review', 'laboratory_approve'], admin)

  assert.deepEqual(getUserQualifications(db, 'u1').map(x => x.code),
    ['laboratory_approve', 'sampling_review'])
  assert.deepEqual(getUser(db, 'u1')!.roles, ['sampler', 'analyst'])
})

test('project assignment requires active matching qualifications and distinct people', () => {
  const db = freshDb()
  const contract = createContract(db, { client: '甲厂' }, 2026)
  const planner = user('planner', ['planner'])
  const admin = user('admin', ['admin'])
  for (const username of ['sampler', 'lab-reviewer', 'sampling-approver']) {
    createUser(db, { username, name: username, roles: ['analyst'], password: 'secret1' })
  }
  setUserQualifications(db, 'sampling-approver', ['sampling_approve'], admin)

  assert.throws(
    () => assignProjectReviewers(db, contract.id, 'sampling', 'sampler', 'sampler', planner),
    /复核人和审核人不能是同一账号/,
  )
  assert.throws(
    () => assignProjectReviewers(db, contract.id, 'sampling', 'lab-reviewer', 'sampling-approver', planner),
    /没有有效的采样复核资格/,
  )
})

test('changing assignment requires reason and preserves history', () => {
  const db = freshDb()
  const contract = createContract(db, { client: '甲厂' }, 2026)
  const planner = user('planner', ['planner'])
  const admin = user('admin', ['admin'])
  for (const username of ['r1', 'r2', 'a1']) {
    createUser(db, { username, name: username, roles: ['analyst'], password: 'secret1' })
  }
  setUserQualifications(db, 'r1', ['sampling_review'], admin)
  setUserQualifications(db, 'r2', ['sampling_review'], admin)
  setUserQualifications(db, 'a1', ['sampling_approve'], admin)

  assignProjectReviewers(db, contract.id, 'sampling', 'r1', 'a1', planner)
  assert.throws(() => assignProjectReviewers(db, contract.id, 'sampling', 'r2', 'a1', planner), /换人原因/)
  assignProjectReviewers(db, contract.id, 'sampling', 'r2', 'a1', planner, '原复核人调岗')

  assert.equal(listProjectAssignmentHistory(db, contract.id, 'sampling').length, 2)
})

test('active acceptance admin remains selectable when migrating one side to a self assignment', () => {
  const previousUsername = process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME
  const previousUntil = process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL
  process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME = 'demo_admin'
  process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL = '2099-12-31T23:59:59.999Z'
  try {
    const db = freshDb()
    const contract = createContract(db, { client: '单人验收迁移' }, 2026)
    const admin = user('admin', ['admin'])
    const planner = user('planner', ['planner'])
    createUser(db, { username: 'demo_admin', name: '林工程师', roles: ['admin'], password: 'secret1' })
    createUser(db, { username: 'approver', name: '原审核人', roles: [], password: 'secret1' })
    setUserQualifications(db, 'demo_admin', ['sampling_review', 'sampling_approve'], admin)
    setUserQualifications(db, 'approver', ['sampling_approve'], admin)
    assignProjectReviewers(db, contract.id, 'sampling', 'demo_admin', 'approver', planner)

    assert.deepEqual(
      listWorkflowCandidates(db, contract.id, 'sampling', 'approve', '2026-08-23').map(candidate => candidate.username),
      ['approver', 'demo_admin'],
    )
  } finally {
    if (previousUsername === undefined) delete process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME
    else process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME = previousUsername
    if (previousUntil === undefined) delete process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL
    else process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL = previousUntil
  }
})

test('qualification dates must be real calendar dates', () => {
  const db = freshDb()
  createUser(db, { username: 'dated-user', name: '日期人员', roles: ['sampler'], password: 'secret1' })
  const admin = user('admin', ['admin'])

  assert.throws(
    () => setUserQualifications(db, 'dated-user', [{ code: 'sampling_review', validFrom: '2026-02-31' }], admin),
    /日期格式|有效日期/,
  )
  assert.deepEqual(getUserQualifications(db, 'dated-user'), [])
})
