// 检测任务派工 + 交接两道闸：未签收不能派/不能录；任务只有本人能录；确认人不能是交样人
import { test } from 'node:test'
import assert from 'node:assert'
import { openDb } from '../src/db.ts'
import {
  createSample, addHandover, confirmHandover,
  assignTestTasks, listTestTasks, saveRecord,
} from '../src/handlers.ts'

const licy = { name: '赵采样', username: 'demo_sampler' }
const qc = { name: '吴质控', username: 'demo_qc' }

function fieldSample(db: any) {
  // 模拟期次采回的样品（round_id 非空 → 走主流程强校验）
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
  assert.throws(() => assignTestTasks(db, s.id, [{ analyte: '总磷', assignee: '陈检测' }], qc), /不在该样品/)
  const tasks = assignTestTasks(db, s.id, [{ analyte: 'COD', assignee: '陈检测' }, { analyte: '氨氮', assignee: '王检测' }], qc)
  assert.equal(tasks.length, 2)
  // 改派：同项目重派覆盖
  const re = assignTestTasks(db, s.id, [{ analyte: 'COD', assignee: '王检测' }], qc)
  assert.equal(re.find(t => t.analyte === 'COD')!.assignee, '王检测')
  assert.equal(re.length, 2)
})

test('录入闸：未签收不能录；没派任务的期次样品不能录；派了任务只有本人能录（tech 兜底）', () => {
  const db = openDb(':memory:')
  const s = fieldSample(db)
  const h = addHandover(db, s.id, { action: '采样交接' }, licy)
  const guard = { supervisor: false }
  // 未签收
  assert.throws(() => saveRecord(db, { sampleId: s.id, code: 'HJ-TC-001', data: {}, who: '陈检测' }, guard), /签收/)
  confirmHandover(db, h.id, qc)
  // 签收了但没派任务（期次样品强制派活）
  assert.throws(() => saveRecord(db, { sampleId: s.id, code: 'HJ-TC-001', data: {}, who: '陈检测' }, guard), /派检测任务/)
  assignTestTasks(db, s.id, [{ analyte: 'COD', assignee: '陈检测' }], qc)
  // 派给陈检测的活，王检测不能录
  assert.throws(() => saveRecord(db, { sampleId: s.id, code: 'HJ-TC-002', data: {}, who: '王检测' }, guard), /没有派给你|派给了别人/)
  // 本人能录
  const rec = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-001', analyte: 'COD', data: { rows: [] }, who: '陈检测' }, guard)
  assert.equal(rec.author, '陈检测')
  // tech 兜底能录
  const rec2 = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-003', analyte: '氨氮', data: {}, who: '许技术' }, { supervisor: true })
  assert.ok(rec2.id)
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
  assignTestTasks(db, s.id, [{ analyte: 'COD', assignee: '陈检测' }], qc)
  saveRecord(db, { sampleId: s.id, code: 'HJ-TC-001', analyte: 'COD', data: {}, who: '陈检测' }, { supervisor: false })
  const mine = listTestTasks(db, { assignee: '陈检测' })
  assert.equal(mine.length, 1)
  assert.equal(mine[0].record_status, 'draft')
})
