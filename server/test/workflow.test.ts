import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { createContract, createUser, type User } from '../src/handlers.ts'
import { assignProjectReviewers, setUserQualifications } from '../src/qualifications.ts'
import {
  decideWorkflow,
  getWorkflowView,
  submitWorkflowRevision,
  withdrawWorkflow,
} from '../src/workflow.ts'

function user(username: string, roles: string[] = []): User {
  return { username, name: username, roles, status: 'active', created_at: '', must_change_pw: false }
}

function setup(scope: 'sampling' | 'quality' | 'laboratory' | 'report' = 'sampling') {
  const db = openDb(':memory:')
  const contract = createContract(db, { client: '甲厂' }, 2026)
  const admin = user('admin', ['admin'])
  const planner = user('planner', ['planner'])
  const author = user('author')
  const reviewer = user('reviewer')
  const approver = user('approver')
  for (const actor of [author, reviewer, approver]) {
    createUser(db, { username: actor.username, name: actor.name, roles: [], password: 'secret1' })
  }
  setUserQualifications(db, reviewer.username, [`${scope}_review` as any], admin)
  setUserQualifications(db, approver.username, [`${scope}_approve` as any], admin)
  assignProjectReviewers(db, contract.id, scope, reviewer.username, approver.username, planner)
  return { db, contract, admin, planner, author, reviewer, approver }
}

function submit(db: ReturnType<typeof openDb>, contractId: string, actor: User, snapshot: Record<string, unknown> = { field: { weather: '晴' }, attachments: ['a1'] }) {
  return submitWorkflowRevision(db, {
    contractId, scope: 'sampling', subjectType: 'round_sampling', subjectId: 'round-1', snapshot,
  }, actor)
}

test('workflow progresses from submitted revision through review and approval', () => {
  const { db, contract, author, reviewer, approver } = setup()
  const submitted = submit(db, contract.id, author)
  assert.equal(submitted.status, 'pending_review')
  assert.equal(submitted.current_revision, 1)

  const reviewed = decideWorkflow(db, submitted.id, 1, 'review', 'approve', '', reviewer)
  assert.equal(reviewed.status, 'pending_approval')
  const approved = decideWorkflow(db, submitted.id, 1, 'approve', 'approve', '', approver)
  assert.equal(approved.status, 'approved')
})

test('explicit unexpired single-actor acceptance mode lets the configured admin submit, review and approve', () => {
  const previousUsername = process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME
  const previousUntil = process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL
  process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME = 'demo_admin'
  process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL = '2099-12-31T23:59:59.999Z'
  try {
    const db = openDb(':memory:')
    const contract = createContract(db, { client: '单人验收项目' }, 2026)
    const actor = user('demo_admin', ['admin'])
    createUser(db, { username: actor.username, name: '林工程师', roles: ['admin'], password: 'secret1' })
    setUserQualifications(db, actor.username, ['sampling_review', 'sampling_approve'], actor)
    assignProjectReviewers(db, contract.id, 'sampling', actor.username, actor.username, actor)

    const submitted = submit(db, contract.id, actor)
    assert.equal(decideWorkflow(db, submitted.id, 1, 'review', 'approve', '', actor).status, 'pending_approval')
    assert.equal(decideWorkflow(db, submitted.id, 1, 'approve', 'approve', '', actor).status, 'approved')
    const overrides = db.prepare(`SELECT action,detail FROM audit_log WHERE username='demo_admin' AND action LIKE 'acceptance_override_%' ORDER BY id`).all() as any[]
    assert.deepEqual(overrides.map(row => row.action), [
      'acceptance_override_workflow_assignment',
      'acceptance_override_workflow_submit',
      'acceptance_override_workflow_review',
      'acceptance_override_workflow_approve',
    ])
  } finally {
    if (previousUsername === undefined) delete process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME
    else process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME = previousUsername
    if (previousUntil === undefined) delete process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL
    else process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL = previousUntil
  }
})

test('single-actor acceptance does not let the configured admin decide an unrelated workflow', () => {
  const previousUsername = process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME
  const previousUntil = process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL
  process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME = 'demo_admin'
  process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL = '2099-12-31T23:59:59.999Z'
  try {
    const acceptanceActor = user('demo_admin', ['admin'])
    const decisionCase = setup()
    createUser(decisionCase.db, { username: acceptanceActor.username, name: '林工程师', roles: ['admin'], password: 'secret1' })
    setUserQualifications(decisionCase.db, acceptanceActor.username, ['sampling_review', 'sampling_approve'], decisionCase.admin)
    const submitted = submit(decisionCase.db, decisionCase.contract.id, decisionCase.author)
    assert.throws(
      () => decideWorkflow(decisionCase.db, submitted.id, 1, 'review', 'approve', '', acceptanceActor),
      /项目指定的复核人|未指派给当前验收账号/,
    )
  } finally {
    if (previousUsername === undefined) delete process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME
    else process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME = previousUsername
    if (previousUntil === undefined) delete process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL
    else process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL = previousUntil
  }
})

test('configured acceptance admin does not emit override audit for a normally separated workflow', () => {
  const previousUsername = process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME
  const previousUntil = process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL
  process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME = 'author'
  process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL = '2099-12-31T23:59:59.999Z'
  try {
    const { db, contract, author } = setup()
    db.prepare(`UPDATE users SET roles='["admin"]' WHERE username=?`).run(author.username)

    submit(db, contract.id, { ...author, roles: ['admin'] })

    const overrides = db.prepare(`SELECT action FROM audit_log WHERE username=? AND action LIKE 'acceptance_override_%'`).all(author.username)
    assert.deepEqual(overrides, [])
  } finally {
    if (previousUsername === undefined) delete process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME
    else process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME = previousUsername
    if (previousUntil === undefined) delete process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL
    else process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL = previousUntil
  }
})

test('review and approval rejections require a comment and end the revision', () => {
  const first = setup()
  const submitted = submit(first.db, first.contract.id, first.author)
  assert.throws(() => decideWorkflow(first.db, submitted.id, 1, 'review', 'reject', '', first.reviewer), /意见必填/)
  assert.equal(decideWorkflow(first.db, submitted.id, 1, 'review', 'reject', '现场照片缺失', first.reviewer).status, 'rejected')

  const second = setup()
  const secondSubmitted = submit(second.db, second.contract.id, second.author)
  decideWorkflow(second.db, secondSubmitted.id, 1, 'review', 'approve', '', second.reviewer)
  assert.throws(() => decideWorkflow(second.db, secondSubmitted.id, 1, 'approve', 'reject', '', second.approver), /意见必填/)
  assert.equal(decideWorkflow(second.db, secondSubmitted.id, 1, 'approve', 'reject', '结论与原始记录不一致', second.approver).status, 'rejected')
})

test('a rejected workflow creates an immutable next revision on resubmission', () => {
  const { db, contract, author, reviewer } = setup()
  const original = submit(db, contract.id, author, { field: { weather: '晴' }, attachments: ['a1'] })
  decideWorkflow(db, original.id, 1, 'review', 'reject', '补充附件', reviewer)
  const resubmitted = submit(db, contract.id, author, { field: { weather: '阴' }, attachments: ['a1', 'a2'] })

  assert.equal(resubmitted.id, original.id)
  assert.equal(resubmitted.current_revision, 2)
  const view = getWorkflowView(db, 'round_sampling', 'round-1')!
  assert.deepEqual(view.revisions.map(revision => revision.snapshot), [
    { attachments: ['a1'], field: { weather: '晴' } },
    { attachments: ['a1', 'a2'], field: { weather: '阴' } },
  ])
})

test('workflow rejects stale decisions and preserves an append-only decision history', () => {
  const { db, contract, author, reviewer, approver } = setup()
  const submitted = submit(db, contract.id, author)
  decideWorkflow(db, submitted.id, 1, 'review', 'reject', '需要更正', reviewer)
  submit(db, contract.id, author, { amended: true })
  assert.throws(() => decideWorkflow(db, submitted.id, 1, 'approve', 'approve', '', approver), /版本冲突/)
  decideWorkflow(db, submitted.id, 2, 'review', 'approve', '', reviewer)
  decideWorkflow(db, submitted.id, 2, 'approve', 'approve', '', approver)

  const view = getWorkflowView(db, 'round_sampling', 'round-1')!
  assert.deepEqual(view.decisions.map(decision => [decision.revision, decision.level, decision.decision]), [
    [1, 'review', 'reject'],
    [2, 'review', 'approve'],
    [2, 'approve', 'approve'],
  ])
})

test('workflow enforces three-person separation and the assigned professional scope', () => {
  const { db, contract, author, reviewer, approver } = setup()
  assert.throws(() => submit(db, contract.id, reviewer), /编制人与复核人和审核人必须不同/)
  const submitted = submit(db, contract.id, author)
  assert.throws(() => decideWorkflow(db, submitted.id, 1, 'review', 'approve', '', approver), /项目指定的复核人/)
  assert.throws(() => submitWorkflowRevision(db, {
    contractId: contract.id, scope: 'quality', subjectType: 'round_sampling', subjectId: 'round-2', snapshot: {},
  }, author), /专业环节不匹配/)
  assert.throws(() => decideWorkflow(db, submitted.id, 1, 'approve', 'approve', '', approver), /待审核/)
})

test('a reviewer cannot approve the same revision after assignments are changed', () => {
  const { db, contract, admin, planner, author, reviewer } = setup()
  const replacementReviewer = user('replacement-reviewer')
  createUser(db, { username: replacementReviewer.username, name: replacementReviewer.name, roles: [], password: 'secret1' })
  setUserQualifications(db, reviewer.username, ['sampling_review', 'sampling_approve'], admin)
  setUserQualifications(db, replacementReviewer.username, ['sampling_review'], admin)

  const submitted = submit(db, contract.id, author)
  decideWorkflow(db, submitted.id, 1, 'review', 'approve', '', reviewer)
  assignProjectReviewers(db, contract.id, 'sampling', replacementReviewer.username, reviewer.username, planner, '复核人调岗')

  assert.throws(() => decideWorkflow(db, submitted.id, 1, 'approve', 'approve', '', reviewer), /复核人与审核人必须不同/)
})

test('approved content is frozen and only an active author can withdraw a workflow', () => {
  const { db, contract, author, reviewer, approver } = setup()
  const submitted = submit(db, contract.id, author)
  decideWorkflow(db, submitted.id, 1, 'review', 'approve', '', reviewer)
  decideWorkflow(db, submitted.id, 1, 'approve', 'approve', '', approver)
  assert.throws(() => submit(db, contract.id, author, { amended: true }), /已批准内容已冻结/)
  assert.throws(() => withdrawWorkflow(db, submitted.id, '撤回', reviewer), /编制人/)
})
