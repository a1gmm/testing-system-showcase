// 检测任务派工 + 交接两道闸：未签收不能派/不能录；任务只有本人能录；确认人不能是交样人
import { test } from 'node:test'
import assert from 'node:assert'
import { openDb } from '../src/db.ts'
import {
  createSample, createContract, createUser, addHandover, confirmHandover,
  assignTestTasks, listTestTasks, saveRecord,
} from '../src/handlers.ts'
import { approveRoundQuality } from './support/approved-quality.ts'

const licy = { name: '赵采样', username: 'demo_sampler' }
const qc = { name: '吴质控', username: 'demo_qc' }

function fieldSample(db: any) {
  // 模拟期次采回的样品（round_id 非空 → 走主流程强校验）
  createUser(db, { username: 'demo_qc', name: '吴质控', roles: ['qc'], password: 'secret1' })
  const contract = createContract(db, { client: '闸门厂', plan: [{ matrix: '废水', items: ['COD', '氨氮'], qty: 1 }] }, 2026)
  db.prepare(`INSERT INTO rounds (id,contract_id,round_no,due_date,items,status,created_at) VALUES ('R-TEST',?,1,'2026-08-17',?,'done','2026-08-17')`)
    .run(contract.id, JSON.stringify([{ matrix: '废水', items: ['COD', '氨氮'], qty: 1 }]))
  const s = createSample(db, { client: '闸门厂', matrix: '废水', items: ['COD', '氨氮'] })
  db.prepare(`UPDATE samples SET round_id='R-TEST', source='field' WHERE id=?`).run(s.id)
  return { ...s, round_id: 'R-TEST', source: 'field' }
}

test('交接确认：交样人不能自己签收', () => {
  const db = openDb(':memory:')
  const s = createSample(db, { client: 'x', matrix: '废水' })
  const h = addHandover(db, s.id, { action: '采样交接', fromPerson: '赵采样' }, licy)
  assert.throws(() => confirmHandover(db, h.id, licy), /不能自己确认|接收方/)
  const ok = confirmHandover(db, h.id, qc)
  assert.ok(ok.confirmed_at)
})

test('派任务：未确认签收不能派；签收后可派；项目必须在样品项目里', () => {
  const db = openDb(':memory:')
  const s = fieldSample(db)
  const h = addHandover(db, s.id, { action: '采样交接' }, licy)
  assert.throws(() => assignTestTasks(db, s.id, [{ analyte: 'COD', assignee: '陈检测' }], qc), /签收/)
  confirmHandover(db, h.id, qc)
  approveRoundQuality(db, 'R-TEST', qc)
  assert.throws(() => assignTestTasks(db, s.id, [{ analyte: '总磷', assignee: '陈检测' }], qc), /不在该样品/)
  const tasks = assignTestTasks(db, s.id, [{ analyte: 'COD', assignee: '陈检测' }, { analyte: '氨氮', assignee: '王检测' }], qc)
  assert.equal(tasks.length, 2)
  // 改派：同项目重派覆盖
  const re = assignTestTasks(db, s.id, [{ analyte: 'COD', assignee: '王检测' }], qc)
  assert.equal(re.find(t => t.analyte === 'COD')!.assignee, '王检测')
  assert.equal(re.length, 2)
})

test('录入闸：未签收不能录；没派任务的期次样品不能录；派了任务只有本人能录（tech 无旁路）', () => {
  const db = openDb(':memory:')
  const s = fieldSample(db)
  const h = addHandover(db, s.id, { action: '采样交接' }, licy)
  const guard = { supervisor: false }
  // 未签收
  assert.throws(() => saveRecord(db, { sampleId: s.id, code: 'HJ-TC-001', data: {}, who: '陈检测' }, guard), /签收/)
  confirmHandover(db, h.id, qc)
  approveRoundQuality(db, 'R-TEST', qc)
  // 签收了但没派任务（期次样品强制派活）
  assert.throws(() => saveRecord(db, { sampleId: s.id, code: 'HJ-TC-001', data: {}, who: '陈检测' }, guard), /派检测任务/)
  assignTestTasks(db, s.id, [{ analyte: 'COD', assignee: '陈检测' }], qc)
  // 派给陈检测的活，王检测不能录
  assert.throws(() => saveRecord(db, { sampleId: s.id, code: 'HJ-TC-002', data: {}, who: '王检测' }, guard), /没有派给你|派给了别人/)
  // 本人能录
  const rec = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-001', analyte: 'COD', data: { rows: [] }, who: '陈检测' }, guard)
  assert.equal(rec.author, '陈检测')
  // tech 也必须是任务受派的分析员，不能靠 supervisor 绕过
  assert.throws(() => saveRecord(db, { sampleId: s.id, code: 'HJ-TC-003', analyte: '氨氮', data: {}, who: '许技术' }, { supervisor: true }), /没有派给你/)
})

test('自送样：无交接线，不强制派任务（散样通道不被卡死）', () => {
  const db = openDb(':memory:')
  const s = createSample(db, { client: '自送客户', matrix: '地表水', items: ['COD'] })
  db.prepare(`UPDATE samples SET source='self' WHERE id=?`).run(s.id)
  const rec = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-001', data: {}, who: '陈检测' }, { supervisor: false })
  assert.ok(rec.id)
})

test('任务列表带出记录进度', () => {
  const db = openDb(':memory:')
  const s = fieldSample(db)
  const h = addHandover(db, s.id, { action: '采样交接' }, licy)
  confirmHandover(db, h.id, qc)
  approveRoundQuality(db, 'R-TEST', qc)
  assignTestTasks(db, s.id, [{ analyte: 'COD', assignee: '陈检测' }], qc)
  saveRecord(db, { sampleId: s.id, code: 'HJ-TC-001', analyte: 'COD', data: {}, who: '陈检测' }, { supervisor: false })
  const mine = listTestTasks(db, { assignee: '陈检测' })
  assert.equal(mine.length, 1)
  assert.equal(mine[0].record_status, 'draft')
})

test('项目存量任务进度显示待迁移，真正无范围的存量任务保留旧状态', () => {
  const db = openDb(':memory:')
  const contract = createContract(db, { client: '任务迁移厂' }, 2026)
  const projectSample = createSample(db, {
    client: contract.client, matrix: '废水', items: ['COD'], contractId: contract.id,
  })
  db.prepare(`UPDATE samples SET source='self' WHERE id=?`).run(projectSample.id)
  const projectRecord = saveRecord(db, {
    sampleId: projectSample.id, code: 'HJ-TC-903', analyte: 'COD', data: {}, submit: true,
  })
  db.prepare(`UPDATE records SET status='approved' WHERE id=?`).run(projectRecord.id)
  db.prepare(`INSERT INTO test_tasks(sample_id,analyte,assignee,assigned_by,assigned_at) VALUES(?,?,?,?,?)`)
    .run(projectSample.id, 'COD', '项目分析员', '质控员', '2026-08-22T00:00:00.000Z')

  const unscopedSample = createSample(db, { client: '散样客户', matrix: '废水', items: ['COD'] })
  const unscopedRecord = saveRecord(db, {
    sampleId: unscopedSample.id, code: 'HJ-TC-904', analyte: 'COD', data: {}, submit: true,
  })
  db.prepare(`UPDATE records SET status='approved' WHERE id=?`).run(unscopedRecord.id)
  db.prepare(`INSERT INTO test_tasks(sample_id,analyte,assignee,assigned_by,assigned_at) VALUES(?,?,?,?,?)`)
    .run(unscopedSample.id, 'COD', '散样分析员', '质控员', '2026-08-22T00:00:00.000Z')

  assert.equal(listTestTasks(db, { sampleId: projectSample.id })[0].record_status, 'migration_required')
  assert.equal(listTestTasks(db, { sampleId: unscopedSample.id })[0].record_status, 'approved')
})

test('我的检测任务优先按用户名隔离同名账号，只对历史无用户名任务回退姓名', () => {
  const db = openDb(':memory:')
  const first = createSample(db, { client: '同名甲', matrix: '废水', items: ['COD'] })
  const second = createSample(db, { client: '同名乙', matrix: '废水', items: ['COD'] })
  const legacy = createSample(db, { client: '历史任务', matrix: '废水', items: ['COD'] })
  const at = new Date().toISOString()
  db.prepare(`INSERT INTO test_tasks(sample_id,analyte,assignee,assignee_username,assigned_by,assigned_at) VALUES(?,?,?,?,?,?)`)
    .run(first.id, 'COD', '同名分析员', 'analyst-a', '质控员', at)
  db.prepare(`INSERT INTO test_tasks(sample_id,analyte,assignee,assignee_username,assigned_by,assigned_at) VALUES(?,?,?,?,?,?)`)
    .run(second.id, 'COD', '同名分析员', 'analyst-b', '质控员', at)
  db.prepare(`INSERT INTO test_tasks(sample_id,analyte,assignee,assignee_username,assigned_by,assigned_at) VALUES(?,?,?,?,?,?)`)
    .run(legacy.id, 'COD', '同名分析员', null, '质控员', at)

  const mine = listTestTasks(db, { assignee: '同名分析员', assigneeUsername: 'analyst-a' })
  assert.deepEqual(mine.map(task => task.sample_id).sort(), [first.id, legacy.id].sort())
  db.close()
})
