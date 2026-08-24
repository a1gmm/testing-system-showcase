import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { createContract, createUser, type User } from '../src/handlers.ts'
import { assignProjectReviewers, setUserQualifications } from '../src/qualifications.ts'
import { decideWorkflow, listActorWorkflowTasks, submitWorkflowRevision } from '../src/workflow.ts'

const actor = (username: string, roles: string[] = []): User => ({
  username, name: username, roles, status: 'active', created_at: '', must_change_pw: false,
})

test('专业待办接口只返回当前账号已指派且资格有效的决策层级，不依赖基础岗位', () => {
  const db = openDb(':memory:')
  const admin = actor('admin', ['admin'])
  const planner = actor('planner', ['planner'])
  const taskActor = actor('qualified-only', ['sales'])
  const samplingAuthor = actor('sampling-author', ['sampler'])
  const qualityAuthor = actor('quality-author', ['qc'])
  const samplingApprover = actor('sampling-approver', ['analyst'])
  const qualityReviewer = actor('quality-reviewer', ['report_editor'])
  const outsider = actor('outsider', ['sales'])
  for (const user of [admin, planner, taskActor, samplingAuthor, qualityAuthor, samplingApprover, qualityReviewer, outsider]) {
    createUser(db, { username: user.username, name: user.name, roles: user.roles, password: 'secret1' })
  }
  setUserQualifications(db, taskActor.username, ['sampling_review', 'quality_approve'], admin)
  setUserQualifications(db, samplingApprover.username, ['sampling_approve'], admin)
  setUserQualifications(db, qualityReviewer.username, ['quality_review'], admin)

  const samplingContract = createContract(db, { client: '采样客户' }, 2026)
  const qualityContract = createContract(db, { client: '质控客户' }, 2026)
  assignProjectReviewers(db, samplingContract.id, 'sampling', taskActor.username, samplingApprover.username, planner)
  assignProjectReviewers(db, qualityContract.id, 'quality', qualityReviewer.username, taskActor.username, planner)
  submitWorkflowRevision(db, {
    contractId: samplingContract.id, roundId: 'ROUND-S', scope: 'sampling', subjectType: 'round_sampling', subjectId: 'ROUND-S', snapshot: { sampled: true },
  }, samplingAuthor)
  const quality = submitWorkflowRevision(db, {
    contractId: qualityContract.id, roundId: 'ROUND-Q', scope: 'quality', subjectType: 'quality_plan', subjectId: 'ROUND-Q', snapshot: { requirements: [] },
  }, qualityAuthor)
  decideWorkflow(db, quality.id, 1, 'review', 'approve', '', qualityReviewer)

  assert.deepEqual(listActorWorkflowTasks(db, 'sampling', taskActor).map(item => [item.subject_id, item.status]), [['ROUND-S', 'pending_review']])
  assert.deepEqual(listActorWorkflowTasks(db, 'quality', taskActor).map(item => [item.subject_id, item.status]), [['ROUND-Q', 'pending_approval']])
  assert.deepEqual(listActorWorkflowTasks(db, 'sampling', outsider), [])
  assert.deepEqual(listActorWorkflowTasks(db, 'quality', outsider), [])

  setUserQualifications(db, taskActor.username, [
    { code: 'sampling_review', status: 'inactive' },
    { code: 'quality_approve', status: 'active' },
  ], admin)
  assert.deepEqual(listActorWorkflowTasks(db, 'sampling', taskActor), [])
  assert.equal(listActorWorkflowTasks(db, 'quality', taskActor).length, 1)
})
