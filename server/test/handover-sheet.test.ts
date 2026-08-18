// 批次一切片1：交接单（handover_sheets）——收样自动生成草稿、可改、整单签收/拒收
// 依据 2026-07-31 方案：由采样记录自动带出、可人工改、发质控员签收；拒收单个样品留痕
import { test } from 'node:test'
import assert from 'node:assert'
import { openDb } from '../src/db.ts'
import {
  createContract, acceptContract, createScheme, reviewScheme, composeFreq, createUser,
  listRounds, assignRound, confirmRoundField, sampleRound, listHandovers,
  listHandoverSheets, getHandoverSheet, updateHandoverSheet, sendHandoverSheet, confirmHandoverSheet,
  assignTestTasks,
} from '../src/handlers.ts'

const qcActor = { name: '吴质控', username: 'qianqc' }
const samplerActor = { name: '赵采样', username: 'demo_sampler' }

function setup(db: any) {
  createUser(db, { username: 'demo_sampler', name: '赵采样', roles: ['sampler'], password: 'x12345' })
  createUser(db, { username: 'qianqc', name: '吴质控', roles: ['qc'], password: 'x12345' })
  createUser(db, { username: 'zhaoce', name: '赵检测', roles: ['tester'], password: 'x12345' })
  const c = createContract(db, { client: '交接厂', project: '例行', periodStart: '2026-07-01', periodEnd: '2026-07-01' })
  acceptContract(db, c.id, '周登记')
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-07-01', periodEnd: '2026-07-01',
    points: [{ element: '废水', point: '1#总排口', items: ['COD'], freq: composeFreq(1, 0), standard: 'GB8978' }],
  })
  reviewScheme(db, c.id, 'approve', '许技术')
  const r = listRounds(db, c.id)[0]
  assignRound(db, r.id, ['赵采样'])
  confirmRoundField(db, r.id, { name: '赵采样' })
  const made = sampleRound(db, r.id, samplerActor)
  return { c, r, made }
}

test('收样入库自动生成交接单草稿：编号JJ、成员齐、明细带项目、交样人=采样员', () => {
  const db = openDb(':memory:')
  const { r, made } = setup(db)
  const sheets = listHandoverSheets(db, { roundId: r.id })
  assert.equal(sheets.length, 1)
  const sh = sheets[0]
  assert.match(sh.id, /^JJ\d{4}-\d{4}$/, `交接单号 ${sh.id}`)
  assert.equal(sh.status, 'draft')
  assert.equal(sh.from_person, '赵采样')
  assert.deepEqual([...sh.sample_ids].sort(), made.map(s => s.id).sort(), '成员=本期全部样品')
  const row = sh.detail.find((d: any) => d.sampleId === made[0].id)
  assert.ok(row, '明细行按样品生成')
  assert.deepEqual(row.items, made[0].items, '明细行带出检测项目')
})

test('草稿可改保存条件并留痕；签收后不可再改', () => {
  const db = openDb(':memory:')
  const { r } = setup(db)
  const sh = listHandoverSheets(db, { roundId: r.id })[0]
  const upd = updateHandoverSheet(db, sh.id, { storage: '4℃冷藏，加硫酸至pH≤2' }, samplerActor)
  assert.equal(upd.storage, '4℃冷藏，加硫酸至pH≤2')
  sendHandoverSheet(db, sh.id, samplerActor)
  confirmHandoverSheet(db, sh.id, qcActor)
  assert.throws(() => updateHandoverSheet(db, sh.id, { storage: '改不动' }, samplerActor), /签收|不能/)
})

test('发出→质控员整单签收：状态confirmed、收样人落名、成员样品交接全部确认、可派任务', () => {
  const db = openDb(':memory:')
  const { r, made } = setup(db)
  const sh = listHandoverSheets(db, { roundId: r.id })[0]
  sendHandoverSheet(db, sh.id, samplerActor)
  assert.equal(getHandoverSheet(db, sh.id)!.status, 'sent')
  const done = confirmHandoverSheet(db, sh.id, qcActor)
  assert.equal(done.status, 'confirmed')
  assert.equal(done.to_person, '吴质控')
  assert.ok(done.to_at, '签收时间落库')
  // 整单签收后成员样品的逐条交接都已确认 → 派任务闸放行
  const normal = made.find(s => !s.qc_type)!
  const tasks = assignTestTasks(db, normal.id, [{ analyte: 'COD', assignee: '赵检测', assigneeUsername: 'zhaoce' }], qcActor)
  assert.equal(tasks.length, 1)
})

test('草稿不能直接签收；交样人不能自签', () => {
  const db = openDb(':memory:')
  const { r } = setup(db)
  const sh = listHandoverSheets(db, { roundId: r.id })[0]
  assert.throws(() => confirmHandoverSheet(db, sh.id, qcActor), /发出|草稿/)
  sendHandoverSheet(db, sh.id, samplerActor)
  assert.throws(() => confirmHandoverSheet(db, sh.id, samplerActor), /自己|交样人/)
})

test('拒收：整单签收时可拒个别样品——被拒样品不确认交接、派任务被拦、拒收留痕', () => {
  const db = openDb(':memory:')
  const { r, made } = setup(db)
  const sh = listHandoverSheets(db, { roundId: r.id })[0]
  sendHandoverSheet(db, sh.id, samplerActor)
  const normals = made.filter(s => !s.qc_type)
  const bad = normals[0]
  const done = confirmHandoverSheet(db, sh.id, qcActor, { rejects: [{ sampleId: bad.id, reason: '采样瓶破损' }] })
  assert.equal(done.status, 'confirmed')
  const badRow = done.detail.find((d: any) => d.sampleId === bad.id)
  assert.ok(badRow.rejected, '明细行标记拒收')
  assert.equal(badRow.rejectReason, '采样瓶破损')
  // 被拒样品是终态（2026-08-01 起）：派任务被拒收拦截（原来靠交接闸悬着，现在流水已关闭防止永挂待签收）
  assert.throws(() => assignTestTasks(db, bad.id, [{ analyte: 'COD', assignee: '赵检测' }], qcActor), /拒收/)
  // 拒收在样品交接流水里留痕
  const hs = listHandovers(db, bad.id)
  assert.ok(hs.some(h => h.action === '拒收' && (h.note || '').includes('采样瓶破损')), '拒收流水+原因')
})
