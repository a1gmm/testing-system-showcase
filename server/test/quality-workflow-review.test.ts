import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import * as handlers from '../src/handlers.ts'
import {
  acceptContract,
  addQc,
  assignRound,
  assignTestTasks,
  confirmHandoverSheet,
  confirmRoundField,
  createContract,
  createNoticeFromSheet,
  createScheme,
  createUser,
  issueTestNotice,
  listHandoverSheets,
  listRounds,
  reviewScheme,
  sampleRound,
  sendHandoverSheet,
  type User,
} from '../src/handlers.ts'
import { assignProjectReviewers, setUserQualifications } from '../src/qualifications.ts'
import { decideWorkflow, getWorkflowView } from '../src/workflow.ts'
import { approveRoundSampling } from './support/approved-sampling.ts'

const saveQualityPlan = (handlers as any).saveQualityPlan as Function
const getQualityPlan = (handlers as any).getQualityPlan as Function
const submitQualityPlan = (handlers as any).submitQualityPlan as Function

function actor(username: string, name: string, roles: string[] = []): User {
  return { username, name, roles, status: 'active', created_at: '', must_change_pw: false }
}

function fixture(withQualityAssignment = true) {
  const db = openDb(':memory:')
  const sampler = actor('sampler', '赵采样', ['sampler'])
  const manager = actor('manager', '王收样', ['sample_manager'])
  const qualityOfficer = actor('quality', '吴质控', ['qc'])
  const reviewer = actor('quality-reviewer', '赵质控复核')
  const approver = actor('quality-approver', '孙质控审核')
  for (const user of [sampler, manager, qualityOfficer, reviewer, approver]) {
    createUser(db, { username: user.username, name: user.name, roles: user.roles, password: 'secret1' })
  }
  const contract = createContract(db, { client: '质量流程厂', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] }, 2026)
  acceptContract(db, contract.id, '周登记')
  createScheme(db, {
    contractId: contract.id, cycleMonths: 0, periodStart: '2026-08-17', periodEnd: '2026-08-17',
    points: [{ element: '废水', point: '1#排口', items: ['COD'], freq: '1次', standard: 'GB 8978' }],
  }, 2026)
  reviewScheme(db, contract.id, 'approve', '许技术')
  const round = listRounds(db, contract.id)[0]
  assignRound(db, round.id, [sampler.username])
  confirmRoundField(db, round.id, sampler)
  approveRoundSampling(db, round.id, sampler)
  const samples = sampleRound(db, round.id, sampler, 2026, { supervisor: false })
  const sheet = listHandoverSheets(db, { roundId: round.id })[0]
  sendHandoverSheet(db, sheet.id, sampler)
  confirmHandoverSheet(db, sheet.id, manager)

  const admin = actor('admin', '管理员', ['admin'])
  const planner = actor('planner', '计划员', ['planner'])
  if (withQualityAssignment) {
    setUserQualifications(db, reviewer.username, ['quality_review'], admin)
    setUserQualifications(db, approver.username, ['quality_approve'], admin)
    assignProjectReviewers(db, contract.id, 'quality', reviewer.username, approver.username, planner)
  }
  return { db, contract, round, samples, sheet, qualityOfficer, reviewer, approver }
}

test('quality officer saves required blank, parallel, and spike arrangements', () => {
  const { db, round, qualityOfficer } = fixture()
  assert.equal(typeof saveQualityPlan, 'function')
  const plan = saveQualityPlan(db, round.id, {
    adjustments: [{ qcType: '加标回收', matrix: '废水', analyte: 'COD', qty: 1, basis: '每批1个' }],
  }, qualityOfficer)
  assert.equal(plan.author_username, qualityOfficer.username)
  assert.ok(plan.requirements.some((item: any) => item.qcType === '全程序空白'))
  assert.ok(plan.requirements.some((item: any) => item.qcType === '现场平行'))
  assert.ok(plan.requirements.some((item: any) => item.qcType === '加标回收' && item.analyte === 'COD'))
  assert.deepEqual(getQualityPlan(db, round.id), plan)
})

test('quality plan uses assigned generic review and excludes later QC result values from its snapshot', () => {
  const { db, round, qualityOfficer, reviewer, approver } = fixture()
  saveQualityPlan(db, round.id, {
    adjustments: [{ qcType: '加标回收', matrix: '废水', analyte: 'COD', qty: 1, basis: '每批1个' }],
  }, qualityOfficer)
  addQc(db, { qcType: '加标回收', roundId: round.id, analyte: 'COD', background: 0, spikedMeasured: 9.8, spikeAdded: 10, unit: 'mg/L' }, qualityOfficer)
  const submitted = submitQualityPlan(db, round.id, qualityOfficer)
  assert.equal(submitted.status, 'pending_review')
  decideWorkflow(db, submitted.id, 1, 'review', 'approve', '', reviewer)
  decideWorkflow(db, submitted.id, 1, 'approve', 'approve', '', approver)
  const snapshot = getWorkflowView(db, 'quality_plan', round.id)!.revisions[0].snapshot as any
  assert.ok(snapshot.requirements.some((item: any) => item.qcType === '加标回收'))
  assert.equal('qcRecords' in snapshot, false)
  for (const item of [...snapshot.requirements, ...snapshot.adjustments]) {
    assert.equal('background' in item, false)
    assert.equal('spikedMeasured' in item, false)
    assert.equal('spikeAdded' in item, false)
  }
})

test('test notice issue and task assignment fail closed until the quality plan is approved', () => {
  const { db, round, samples, sheet, qualityOfficer, reviewer, approver } = fixture()
  const normal = samples.find(sample => !sample.qc_type)!
  const notice = createNoticeFromSheet(db, sheet.id, qualityOfficer)
  assert.throws(() => issueTestNotice(db, notice.id, qualityOfficer), /质量计划.*批准/)
  assert.throws(() => assignTestTasks(db, normal.id, [{ analyte: 'COD', assignee: '周检测' }], qualityOfficer), /质量计划.*批准/)

  saveQualityPlan(db, round.id, { adjustments: [] }, qualityOfficer)
  assert.throws(() => issueTestNotice(db, notice.id, qualityOfficer), /质量计划.*批准/)
  const submitted = submitQualityPlan(db, round.id, qualityOfficer)
  assert.throws(() => issueTestNotice(db, notice.id, qualityOfficer), /质量计划.*批准/)
  decideWorkflow(db, submitted.id, 1, 'review', 'approve', '', reviewer)
  assert.throws(() => assignTestTasks(db, normal.id, [{ analyte: 'COD', assignee: '周检测' }], qualityOfficer), /质量计划.*批准/)
  decideWorkflow(db, submitted.id, 1, 'approve', 'approve', '', approver)
  assert.equal(assignTestTasks(db, normal.id, [{ analyte: 'COD', assignee: '周检测' }], qualityOfficer).length, 1)
  assert.equal(issueTestNotice(db, notice.id, qualityOfficer).status, 'issued')
})

test('missing quality assignment fails closed before laboratory work starts', () => {
  const { db, sheet, qualityOfficer } = fixture(false)
  const notice = createNoticeFromSheet(db, sheet.id, qualityOfficer)
  assert.throws(() => issueTestNotice(db, notice.id, qualityOfficer), /尚未指定质控复核人和审核人/)
})
