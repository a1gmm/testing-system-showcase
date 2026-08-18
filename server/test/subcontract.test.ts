import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { addSubcontract, listSubcontracts, updateSubcontract, SUBCONTRACT_STATUS } from '../src/handlers.ts'

function freshDb() { return openDb(':memory:') }

test('分包：登记分包方/资质/委托方同意，按委托过滤，倒序列出', () => {
  const db = freshDb()
  const actor = { name: '许技术', username: 'demo_tech' }
  addSubcontract(db, { contractId: 'WT2026-0001', items: '二噁英', subcontractor: '省环科院', qualification: 'CMA-1234', reason: '本所无该项资质', consent: true }, actor)
  addSubcontract(db, { contractId: 'WT2026-0002', items: '总铬', subcontractor: '市监测站', qualification: 'CMA-5678', consent: false }, actor)

  const all = listSubcontracts(db)
  assert.equal(all.length, 2)
  assert.equal(all[0].subcontractor, '市监测站')   // 倒序

  const one = listSubcontracts(db, { contractId: 'WT2026-0001' })
  assert.equal(one.length, 1)
  assert.equal(one[0].items, '二噁英')
  assert.equal(one[0].qualification, 'CMA-1234')
  assert.equal(one[0].consent, 1)                  // 委托方已同意
  assert.equal(one[0].status, '计划中')
  assert.equal(one[0].who, '许技术')
})

test('分包：分包方必填', () => {
  const db = freshDb()
  assert.throws(() => addSubcontract(db, { subcontractor: '' }, { name: 'x' }), /分包方/)
  assert.ok(SUBCONTRACT_STATUS.includes('结果已核'))
})

test('分包：更新状态与结果核验（已分包→结果已核）', () => {
  const db = freshDb()
  const actor = { name: '许技术', username: 'demo_tech' }
  const r = addSubcontract(db, { contractId: 'WT2026-0003', subcontractor: '省环科院', items: '二噁英' }, actor)
  const upd = updateSubcontract(db, r.id, { status: '结果已核', consent: true, resultNote: '分包结果已复核，数据可用' }, actor)
  assert.equal(upd.status, '结果已核')
  assert.equal(upd.consent, 1)
  assert.equal(upd.result_note, '分包结果已复核，数据可用')
  assert.equal(upd.subcontractor, '省环科院')       // 未传字段不变
})
