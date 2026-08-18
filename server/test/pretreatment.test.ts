import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { createSample, addPretreatment, listPretreatments } from '../src/handlers.ts'

function freshDb() { return openDb(':memory:') }

test('前处理记录：追加并按时间列出，记方法/试剂/条件/操作人', () => {
  const db = freshDb()
  const s = createSample(db, { matrix: '土壤', client: '甲厂' }, 2026)
  const actor = { name: '陈检测', username: 'demo_tester' }
  addPretreatment(db, s.id, { method: '微波消解', reagent: 'HNO₃+HCl', condition: '180℃ 30min', volFinal: '50 mL', note: '' }, actor)
  addPretreatment(db, s.id, { method: '定容', reagent: '超纯水', condition: '', volFinal: '100 mL' }, actor)
  const list = listPretreatments(db, s.id)
  assert.equal(list.length, 2)
  assert.equal(list[0].method, '微波消解')
  assert.equal(list[0].reagent, 'HNO₃+HCl')
  assert.equal(list[0].condition, '180℃ 30min')
  assert.equal(list[0].vol_final, '50 mL')
  assert.equal(list[0].who, '陈检测')
  assert.equal(list[0].username, 'demo_tester')
  assert.equal(list[1].method, '定容')
})

test('前处理：样品不存在报错；方法必填', () => {
  const db = freshDb()
  assert.throws(() => addPretreatment(db, 'NOPE', { method: '消解' }, { name: 'x' }), /样品不存在/)
  const s = createSample(db, { matrix: '废水' }, 2026)
  assert.throws(() => addPretreatment(db, s.id, { method: '' }, { name: 'x' }), /必填/)
})
