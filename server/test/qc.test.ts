import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { judgeQc, addQc, listQc, ROLE_LABEL, hasRole, createContract } from '../src/handlers.ts'

function freshDb() { return openDb(':memory:') }

// —— 质控员角色（独立于检测）：质控由专人把关，检测员不再兼填 ——
test('质控员角色已登记，中文名为「质控员」', () => {
  assert.equal(ROLE_LABEL.qc, '质控员')
})

test('质控填报权限 = 质控员 + 技术负责人（检测员不再有）', () => {
  const gate = (roles: string[]) => hasRole({ username: 'x', name: 'x', roles, status: 'active', created_at: '' }, 'qc', 'tech')
  assert.equal(gate(['qc']), true)        // 质控员：可填
  assert.equal(gate(['tech']), true)      // 技术负责人：可填
  assert.equal(gate(['admin']), true)     // 管理员：万能
  assert.equal(gate(['tester']), false)   // 检测员：不再兼质控（独立把关）
  assert.equal(gate(['sampler']), false)  // 采样员：无关
})

test('质控自动判定：平行样相对偏差', () => {
  // RD = |v1-v2|/(v1+v2)*100
  let r = judgeQc({ type: '平行样', v1: 1.00, v2: 1.02, limit: 10 })
  assert.equal(r.verdict, '合格')            // RD≈0.99% ≤10%
  assert.ok(Math.abs(r.result! - 0.99) < 0.05)
  r = judgeQc({ type: '平行样', v1: 1.0, v2: 1.5, limit: 10 })
  assert.equal(r.verdict, '不合格')          // RD=20% >10%
})

test('质控自动判定：加标回收率', () => {
  // 回收率 = (加标后 - 本底)/加标量 *100
  let r = judgeQc({ type: '加标回收', background: 1.0, spikedMeasured: 1.95, spikeAdded: 1.0, low: 90, high: 110 })
  assert.equal(r.verdict, '合格')            // 95%
  assert.ok(Math.abs(r.result! - 95) < 0.1)
  r = judgeQc({ type: '加标回收', background: 1.0, spikedMeasured: 2.5, spikeAdded: 1.0, low: 90, high: 110 })
  assert.equal(r.verdict, '不合格')          // 150%
})

test('质控自动判定：密码样相对误差', () => {
  // 相对误差 = (测定 - 标准值)/标准值 *100
  let r = judgeQc({ type: '密码样', measured: 5.1, assigned: 5.0, limit: 10 })
  assert.equal(r.verdict, '合格')            // +2%
  r = judgeQc({ type: '密码样', measured: 6.0, assigned: 5.0, limit: 10 })
  assert.equal(r.verdict, '不合格')          // +20%
})

test('质控记录：存自动判定结果并列出', () => {
  const db = freshDb()
  const actor = { name: '陈检测', username: 'demo_tester' }
  const contract = createContract(db, { client: '质控客户' }, 2026)
  const roundId = 'WT2026-0001-R01'
  db.prepare(`INSERT INTO rounds (id, contract_id, round_no, due_date, items, status, created_at)
    VALUES (?, ?, 1, '2026-08-01', '[]', 'pending', '2026-08-01T00:00:00.000Z')`).run(roundId, contract.id)
  addQc(db, { roundId, qcType: '平行样', analyte: '锌', v1: 1.0, v2: 1.02, unit: 'mg/L' }, actor)
  addQc(db, { roundId, qcType: '加标回收', analyte: '锌', background: 1.0, spikedMeasured: 1.95, spikeAdded: 1.0, unit: 'mg/L' }, actor)
  const list = listQc(db, { roundId })
  assert.equal(list.length, 2)
  assert.equal(list[0].qc_type, '平行样')
  assert.equal(list[0].verdict, '合格')
  assert.equal(list[0].who, '陈检测')
  assert.equal(list[0].username, 'demo_tester')
  assert.ok(list[0].criterion.includes('相对偏差'))
  assert.equal(list[1].qc_type, '加标回收')
  assert.equal(list[1].verdict, '合格')
})
