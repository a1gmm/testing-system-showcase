import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import {
  createContract, createScheme, reviewScheme,
  listRounds, getRound,
  failRound, rescheduleRound, assignRound,
  createSample, saveRecord, flagRecheck,
  listCustomers, upsertCustomer, getCustomerContracts,
  addHandover, confirmHandover, listHandovers,
  createInstrument, listInstruments, checkoutInstrument, returnInstrument, listCheckouts,
  createUser,
} from '../src/handlers.ts'

function freshDb() {
  const db = openDb(':memory:')
  // 体检39：派工名字必须是在职采样员账号
  createUser(db, { username: 'demo_sampler', name: '赵采样', roles: ['sampler'], password: 'x12345' })
  createUser(db, { username: 'wangcy', name: '王采样', roles: ['sampler'], password: 'x12345' })
  return db
}

// 建一个单次监测、排出 1 期并已派工的合同，返回该期次（S4 状态机：未派工不能标采不成/入库）
function oneRound(db: any) {
  const c = createContract(db, { client: '鲁南化工', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] }, 2026)
  createScheme(db, { contractId: c.id, cycleMonths: 0, periodStart: '2026-07-05', periodEnd: '2026-07-05' }, 2026)
  reviewScheme(db, c.id, 'approve', '许技术')
  const r = listRounds(db, c.id)[0]
  assignRound(db, r.id, ['赵采样', '王采样'])
  return getRound(db, r.id)!
}

test('采不成：期次标未采成、记原因', () => {
  const db = freshDb()
  const r = oneRound(db)
  assert.equal(r.status, 'pending')
  const f = failRound(db, r.id, '企业停产')
  assert.equal(f.status, 'failed')
  assert.equal(f.fail_reason, '企业停产')
})

test('采不成后改期：转「已改期」状态（统计可区分）、换成新日期、留下原定日期', () => {
  const db = freshDb()
  const r = oneRound(db)
  failRound(db, r.id, '天气原因')
  const rr = rescheduleRound(db, r.id, '2026-08-20')
  assert.equal(rr.status, 'rescheduled')
  assert.equal(rr.due_date, '2026-08-20')
  assert.equal(rr.orig_due_date, '2026-07-05') // 原定日期留痕
  assert.equal(rr.fail_reason, null)            // 改期后清掉未采成原因
})

test('采不成守卫：已采样的期次不能标未采成', () => {
  const db = freshDb()
  const r = oneRound(db)
  // 直接把状态改成已采（模拟已采样）
  const done = getRound(db, r.id)!
  ;(db as any).prepare(`UPDATE rounds SET status='done' WHERE id=?`).run(done.id)
  assert.throws(() => failRound(db, r.id, '停产'), /已采|不能/)
})

test('改期守卫：只有未采成的期次能改期', () => {
  const db = freshDb()
  const r = oneRound(db)
  // pending 直接改期应报错（必须先标未采成）
  assert.throws(() => rescheduleRound(db, r.id, '2026-08-20'), /未采成|先标/)
})

test('超标复检：标记记录需复检、记原因，可取消', () => {
  const db = freshDb()
  const s = createSample(db, { matrix: '废水' }, 2026)
  let rec = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-003', analyte: 'COD', data: { rows: [], meta: {}, reg: {}, resultSummary: { analyte: 'COD', value: 120, unit: 'mg/L' } } })
  assert.equal(rec.recheck, 0)
  rec = flagRecheck(db, rec.id, '超标，需复检确认')
  assert.equal(rec.recheck, 1)
  assert.equal(rec.recheck_reason, '超标，需复检确认')
  // 取消复检标记
  rec = flagRecheck(db, rec.id, '', false)
  assert.equal(rec.recheck, 0)
  assert.equal(rec.recheck_reason, null)
})

test('超标复检守卫：原因必填、记录须存在', () => {
  const db = freshDb()
  const s = createSample(db, { matrix: '废水' }, 2026)
  const rec = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-003', analyte: 'COD', data: { rows: [], meta: {}, reg: {} } })
  assert.throws(() => flagRecheck(db, rec.id, ''), /原因/)
  assert.throws(() => flagRecheck(db, 'no-such-id', '超标'), /不存在/)
})

test('客户档案：建合同自动建客户，可补充信息，按客户查合同', () => {
  const db = freshDb()
  createContract(db, { client: '鲁南化工', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] }, 2026)
  createContract(db, { client: '鲁南化工' }, 2026)   // 同客户第二单
  createContract(db, { client: '海化集团' }, 2026)
  const list = listCustomers(db)
  assert.equal(list.length, 2)                        // 两个客户，不重复
  const lunan = list.find(c => c.name === '鲁南化工')!
  assert.equal(lunan.contract_count, 2)               // 鲁南化工有 2 单
  // 补充客户联系信息（不新建、按名更新）
  upsertCustomer(db, { name: '鲁南化工', contact: '张经理 13800000000', address: '山东临沂' })
  const again = listCustomers(db)
  assert.equal(again.length, 2)                        // 仍是 2 个，没重复建
  const lunan2 = again.find(c => c.name === '鲁南化工')!
  assert.equal(lunan2.contact, '张经理 13800000000')
  assert.equal(lunan2.contract_count, 2)
  // 按客户查合同
  const contracts = getCustomerContracts(db, '鲁南化工')
  assert.equal(contracts.length, 2)
})

test('样品交接双签：发起后待接收，接收方确认签收，不能重复确认', () => {
  const db = freshDb()
  const s = createSample(db, { matrix: '废水' }, 2026)
  const h = addHandover(db, s.id, { action: '采样交接', fromPerson: '赵采样', toPerson: '张质控' }, { name: '赵采样', username: 'demo_sampler' })
  assert.equal(h.confirmed_at, null)          // 发起后处于「待接收」
  const c = confirmHandover(db, h.id, { name: '张质控', username: 'zhangqk' })
  assert.equal(c.confirmed_by, '张质控')
  assert.ok(c.confirmed_at)
  // 已确认不能再确认
  assert.throws(() => confirmHandover(db, h.id, { name: '张质控' }), /已确认|重复/)
  // 列表里带出确认状态
  assert.equal(listHandovers(db, s.id)[0].confirmed_by, '张质控')
})

test('设备领用归还：领用→仪器转使用中，归还→转正常；检定在有效期 cert_ok=1', () => {
  const db = freshDb()
  createInstrument(db, { id: 'TC-004', name: 'pH计', certUntil: '2027-01-01' })
  const co = checkoutInstrument(db, { instrumentId: 'TC-004', takenBy: '赵采样' }, { name: '赵采样', username: 'demo_sampler' })
  assert.equal(co.status, 'out')
  assert.equal(co.cert_ok_at_checkout, 1)
  assert.equal(listInstruments(db).find(i => i.id === 'TC-004')!.status, 'busy')
  assert.equal(listCheckouts(db, { open: true }).length, 1)
  const back = returnInstrument(db, co.id, { name: '赵采样' })
  assert.equal(back.status, 'returned')
  assert.equal(listInstruments(db).find(i => i.id === 'TC-004')!.status, 'normal')
  assert.equal(listCheckouts(db, { open: true }).length, 0)
})

test('设备领用：检定过期一律拦下（体检49）；在效期的不能重复归还', () => {
  const db = freshDb()
  createInstrument(db, { id: 'TC-007', name: '旧仪器', certUntil: '2020-01-01' })  // 已过期
  // 过期 → 400 拦截，不再警告放行
  assert.throws(() => checkoutInstrument(db, { instrumentId: 'TC-007', takenBy: '李' }, { name: '李' }), /检定已过期.*先送检/)
  assert.equal(listCheckouts(db, { open: true }).length, 0)   // 没有领出记录
  // 在效期的正常领用，不能重复归还
  createInstrument(db, { id: 'TC-008', name: '新仪器', certUntil: '2099-01-01' })
  const co = checkoutInstrument(db, { instrumentId: 'TC-008', takenBy: '李' }, { name: '李' })
  returnInstrument(db, co.id, { name: '李' })
  assert.throws(() => returnInstrument(db, co.id, { name: '李' }), /已归还|重复/)
})
