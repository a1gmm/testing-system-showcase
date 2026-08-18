import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { createSample, addHandover, listHandovers } from '../src/handlers.ts'

function freshDb() { return openDb(':memory:') }

test('样品交接/流转：追加事件并按时间正序列出，记双方+状态+操作人', () => {
  const db = freshDb()
  const s = createSample(db, { matrix: '废水', client: '甲厂' }, 2026)
  const licy = { name: '赵采样', username: 'demo_sampler' }
  addHandover(db, s.id, { action: '采样交接', fromPerson: '赵采样', toPerson: '王接样', condition: '完好', note: '4℃冷藏' }, licy)
  addHandover(db, s.id, { action: '流转领用', fromPerson: '王接样', toPerson: '陈检测', condition: '完好' }, licy)
  const list = listHandovers(db, s.id)
  assert.equal(list.length, 2)
  assert.equal(list[0].action, '采样交接')
  assert.equal(list[0].from_person, '赵采样')
  assert.equal(list[0].to_person, '王接样')
  assert.equal(list[0].condition, '完好')
  assert.equal(list[0].who, '赵采样')
  assert.equal(list[0].username, 'demo_sampler')
  assert.equal(list[1].action, '流转领用')
})

test('样品交接：样品不存在报错；交接类型必填', () => {
  const db = freshDb()
  assert.throws(() => addHandover(db, 'NOPE', { action: '采样交接' }, { name: 'x', username: 'x' }), /样品不存在/)
  const s = createSample(db, { matrix: '废水' }, 2026)
  assert.throws(() => addHandover(db, s.id, { action: '' }, { name: 'x', username: 'x' }), /必填/)
})
