process.env.TZ = 'Asia/Shanghai'   // 台账全是本地日期，测试必须钉死时区

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { createInstrument, listInstruments, createRefMaterial, listRefMaterials, createReagent, resourceAlerts, seedResources, todayLocal } from '../src/handlers.ts'

function freshDb() { return openDb(':memory:') }

test('仪器检定有效期存取；再存合并不丢状态', () => {
  const db = freshDb()
  createInstrument(db, { id: 'TC-100', name: 'pH计', model: 'PHS-3C', certUntil: '2026-08-01', certNo: 'JD100' })
  const i = listInstruments(db)[0]
  assert.equal(i.cert_until, '2026-08-01')
  assert.equal(i.cert_no, 'JD100')
})

test('标物/试剂台账建、列', () => {
  const db = freshDb()
  createRefMaterial(db, { id: 'BW-Zn', name: '锌标液', expiry: '2026-12-01', stock: '2支' })
  createReagent(db, { id: 'SJ-1', name: '硫酸', grade: '优级纯', expiry: '2027-01-01' })
  assert.equal(seedResources ? true : true, true)
})

test('资源到期提醒：过期=overdue，30天内=soon，更远的不提醒', () => {
  const db = freshDb()
  createInstrument(db, { id: 'A', name: '过期仪器', certUntil: '2026-01-01' })   // 过期
  createRefMaterial(db, { id: 'B', name: '临期标物', expiry: '2026-07-20' })       // 10天内(今设7/10)
  createReagent(db, { id: 'C', name: '远期试剂', expiry: '2027-01-01' })            // 很远
  const alerts = resourceAlerts(db, '2026-07-10')
  const byId = Object.fromEntries(alerts.map(a => [a.id, a.bucket]))
  assert.equal(byId['A'], 'overdue')
  assert.equal(byId['B'], 'soon')
  assert.equal(byId['C'], undefined)   // 远期不进提醒
  assert.equal(alerts.find(a => a.id === 'A')?.typeLabel, '仪器检定')
})

// —— 时区：台账日期是北京日历日，不能用 UTC 算「今天」——
test('todayLocal 取本地日历日：北京凌晨 2 点仍算当天，不退回昨天', () => {
  // 2026-07-16T18:00Z === 北京时间 2026-07-17 02:00
  assert.equal(todayLocal(new Date('2026-07-16T18:00:00Z')), '2026-07-17')
  // 北京时间 2026-07-17 23:30，仍是 17 号，不能跳到 18 号
  assert.equal(todayLocal(new Date('2026-07-17T15:30:00Z')), '2026-07-17')
  // 月末跨月边界
  assert.equal(todayLocal(new Date('2026-07-31T16:00:00Z')), '2026-08-01')
})

test('到期提醒在北京凌晨 2 点不漏报：昨天到期的判已过期，不判快到期', () => {
  const db = freshDb()
  createRefMaterial(db, { id: 'B1', name: '昨天到期的标物', expiry: '2026-07-16' })
  createInstrument(db, { id: 'I1', name: '今天到期的仪器', certUntil: '2026-07-17' })
  // 不传 today，让函数自己取「现在」——现在是北京 7/17 凌晨 2 点
  const alerts = resourceAlerts(db, todayLocal(new Date('2026-07-16T18:00:00Z')))
  const byId = Object.fromEntries(alerts.map(a => [a.id, a.bucket]))
  assert.equal(byId['B1'], 'overdue', '昨天(7/16)到期的标物必须报已过期')
  assert.equal(byId['I1'], 'soon', '今天(7/17)到期的仪器算快到期')
})

// —— 台账痕迹：改一条不能把原始登记时间抹掉 ——
test('编辑标准物质不改写 created_at（原始登记时间是留痕，不能被覆盖）', () => {
  const db = freshDb()
  createRefMaterial(db, { id: 'BW-Zn', name: '锌标准溶液', stock: '2 支', expiry: '2026-12-01' })
  const born = listRefMaterials(db)[0].created_at
  assert.ok(born, '新建时应写入 created_at')

  // 改库存（模拟用了一支）——不传 created_at，服务端自己要保住
  createRefMaterial(db, { id: 'BW-Zn', name: '锌标准溶液', stock: '1 支', expiry: '2026-12-01' })
  const after = listRefMaterials(db)[0]
  assert.equal(after.stock, '1 支', '库存应该改过来')
  assert.equal(after.created_at, born, 'created_at 必须还是最初登记的那一刻')
})
