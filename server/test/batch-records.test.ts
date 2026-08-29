// PRD 步骤6 跨合同同表：一张表多样品批量录入，按样品编号自动归各自合同
import { test } from 'node:test'
import assert from 'node:assert'
import { openDb } from '../src/db.ts'
import {
  addHandover, confirmHandover, createContract, createSample, createUser,
  saveRecordsBatch, getRecord, listRecords, type User,
} from '../src/handlers.ts'
import { assignProjectReviewers, setUserQualifications } from '../src/qualifications.ts'
import { getWorkflowView } from '../src/workflow.ts'

test('批量录入：多个样品各落一条记录，data 归各自样品；同表同人一次提交', () => {
  const db = openDb(':memory:')
  const s1 = createSample(db, { client: '甲厂', matrix: '废水', items: ['COD'] })
  const s2 = createSample(db, { client: '乙厂', matrix: '废水', items: ['COD'] })
  const recs = saveRecordsBatch(db, {
    code: 'HJ-TC-030', analyte: 'COD', matrix: '废水', method: '重铬酸盐法',
    sharedMeta: { date: '2026-07-29', signer: '陈检测' },
    entries: [
      { sampleId: s1.id, row: { id: s1.id, v: 10 }, resultSummary: { analyte: 'COD', value: 15.2, unit: 'mg/L' } },
      { sampleId: s2.id, row: { id: s2.id, v: 20 }, resultSummary: { analyte: 'COD', value: 30.4, unit: 'mg/L' } },
    ],
    who: '陈检测',
  }, { supervisor: false })
  assert.equal(recs.length, 2)
  const r1 = getRecord(db, s1.id, 'HJ-TC-030')!
  const r2 = getRecord(db, s2.id, 'HJ-TC-030')!
  assert.equal(r1.data.resultSummary.value, 15.2)
  assert.equal(r2.data.resultSummary.value, 30.4)
  assert.equal((r1 as any).author, '陈检测')
  assert.equal(r1.data.meta.signer, '陈检测')
})

test('批量录入：一行失败整批回滚（一个样品占两行直接拒）', () => {
  const db = openDb(':memory:')
  const s1 = createSample(db, { client: '甲厂', matrix: '废水', items: ['COD'] })
  assert.throws(() => saveRecordsBatch(db, {
    code: 'HJ-TC-030',
    entries: [
      { sampleId: s1.id, row: { v: 1 } },
      { sampleId: s1.id, row: { v: 2 } },
    ],
    who: '陈检测',
  }), /一行/)
  // 中途炸整批回滚：第二个样品不存在
  assert.throws(() => saveRecordsBatch(db, {
    code: 'HJ-TC-030', analyte: 'COD',
    entries: [
      { sampleId: s1.id, row: { v: 1 } },
      { sampleId: 'NOPE', row: { v: 2 } },
    ],
    who: '陈检测',
  }, { supervisor: false }), /样品不存在/)
  assert.equal(listRecords(db, { sampleId: s1.id }).length, 0, '整批应回滚，第一条也不落库')
})

test('批量录入：每条记录使用样品真实基质，不信任模板或客户端共用值', () => {
  const db = openDb(':memory:')
  const wastewater = createSample(db, { client: '甲厂', matrix: '废水', items: ['COD'] })
  const groundwater = createSample(db, { client: '乙厂', matrix: '地下水', items: ['COD'] })

  saveRecordsBatch(db, {
    code: 'HJ-TC-103', analyte: 'COD', matrix: '被篡改的共用基质',
    entries: [
      { sampleId: wastewater.id, row: { value: 10 } },
      { sampleId: groundwater.id, row: { value: 20 } },
    ],
    who: '陈检测',
  })

  assert.equal(getRecord(db, wastewater.id, 'HJ-TC-103')!.matrix, '废水')
  assert.equal(getRecord(db, groundwater.id, 'HJ-TC-103')!.matrix, '地下水')
})

test('批量提交：每条项目记录按样品归属创建独立实验室工作流', () => {
  const db = openDb(':memory:')
  const actor = (username: string, name: string, roles: string[] = []): User =>
    ({ username, name, roles, status: 'active', created_at: '', must_change_pw: false })
  const analyst = actor('batch-analyst', '张批量', ['analyst'])
  const reviewer = actor('batch-reviewer', '李批量复核')
  const approver = actor('batch-approver', '王批量审核')
  for (const user of [analyst, reviewer, approver]) createUser(db, { username: user.username, name: user.name, roles: user.roles, password: 'secret1' })
  const contract = createContract(db, { client: '批量流程厂' }, 2026)
  setUserQualifications(db, reviewer.username, ['laboratory_review'], actor('admin', '管理员', ['admin']))
  setUserQualifications(db, approver.username, ['laboratory_approve'], actor('admin', '管理员', ['admin']))
  assignProjectReviewers(db, contract.id, 'laboratory', reviewer.username, approver.username, actor('planner', '计划员', ['planner']))
  const samples = ['甲', '乙'].map(client => createSample(db, { client, matrix: '废水', items: ['COD'], contractId: contract.id }))
  for (const sample of samples) {
    const handover = addHandover(db, sample.id, { action: '采样交接' }, { name: '赵采样', username: 'sampler' })
    confirmHandover(db, handover.id, { name: '吴质控', username: 'quality' })
    db.prepare(`INSERT INTO test_tasks(sample_id,analyte,assignee,assignee_username,assigned_by,assigned_at) VALUES(?,?,?,?,?,?)`)
      .run(sample.id, 'COD', analyst.name, analyst.username, '吴质控', '2026-08-21')
  }
  const records = saveRecordsBatch(db, {
    code: 'HJ-TC-031', analyte: 'COD', submit: true, who: analyst.name, whoUsername: analyst.username,
    entries: samples.map((sample, index) => ({ sampleId: sample.id, row: { value: index + 1 } })),
  }, { actor: analyst })
  assert.equal(records.length, 2)
  assert.deepEqual(records.map(record => record.status), ['submitted', 'submitted'])
  assert.deepEqual(records.map(record => getWorkflowView(db, 'lab_record', record.id)?.contract_id), [contract.id, contract.id])
})
