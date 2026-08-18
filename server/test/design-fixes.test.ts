// 页面设计评审修复（2026-08-01）：报告要素与列表信息完整性的后端支撑
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import {
  createContract, getContract, upsertCustomer,
  acceptContract, createScheme, reviewScheme, composeFreq, createUser,
  listRounds, assignRound, confirmRoundField, sampleRound,
  listHandoverSheets, sendHandoverSheet, confirmHandoverSheet, createNoticeFromSheet, listTestNotices,
  maskSheetForUser, generateSamples, saveRecord, listRecords,
} from '../src/handlers.ts'

function freshDb() { return openDb(':memory:') }

test('getContract 带出客户档案地址——报告"受检单位地址"不再恒为空', () => {
  const db = freshDb()
  const c = createContract(db, { client: '地址验证厂' }, 2026)
  upsertCustomer(db, { name: '地址验证厂', address: '山东临沂某路1号', phone: '0539-1234567' })
  const got = getContract(db, c.id) as any
  assert.equal(got.address, '山东临沂某路1号')
})

test('getContract 客户没建档/没填地址时 address 为空不报错', () => {
  const db = freshDb()
  const c = createContract(db, { client: '无档案厂' }, 2026)
  const got = getContract(db, c.id) as any
  assert.ok(got)
  assert.ok(got.address == null || got.address === '')
})

// 质控交接页列表要能看出"哪单是哪家"——交接单/通知单列表带出委托单位与项目名
test('listHandoverSheets / listTestNotices 带 client+project——质控页不再只有一排单号', () => {
  const db = freshDb()
  createUser(db, { username: 'licy2', name: '赵采样', roles: ['sampler'], password: 'x12345' })
  const c = createContract(db, { client: '聚合验证厂', project: '例行监测', periodStart: '2026-07-01', periodEnd: '2026-07-01' })
  acceptContract(db, c.id, '周登记')
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-07-01', periodEnd: '2026-07-01',
    points: [{ element: '废水', point: '1#总排口', items: ['COD'], freq: composeFreq(1, 0), standard: 'GB8978' }],
  })
  reviewScheme(db, c.id, 'approve', '许技术')
  const r = listRounds(db, c.id)[0]
  assignRound(db, r.id, ['赵采样'])
  confirmRoundField(db, r.id, { name: '赵采样' })
  sampleRound(db, r.id, { name: '赵采样', username: 'licy2' })
  const sh = listHandoverSheets(db, { roundId: r.id })[0] as any
  assert.equal(sh.client, '聚合验证厂')
  assert.equal(sh.project, '例行监测')
  sendHandoverSheet(db, sh.id, { name: '赵采样', username: 'licy2' })
  confirmHandoverSheet(db, sh.id, { name: '吴质控', username: 'qzk' })
  createNoticeFromSheet(db, sh.id, { name: '吴质控', username: 'qzk' })
  const n = listTestNotices(db)[0] as any
  assert.equal(n.client, '聚合验证厂')
  assert.equal(n.project, '例行监测')
})

// 三级审核队列要按合同分组——记录行带出所属合同与单位（盲用户走同一脱敏口径）
test('listRecords 带 contract_id+client；盲用户经 maskSheetForUser 后脱净', () => {
  const db = freshDb()
  const c = createContract(db, { client: '审核聚合厂', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] }, 2026)
  acceptContract(db, c.id, '周登记')
  const made = generateSamples(db, c.id, 2026)
  const rec = saveRecord(db, { sampleId: made[0].id, code: 'HJ-TC-103', analyte: 'COD', method: '重铬酸盐法', data: { rows: [], meta: {}, reg: {}, resultSummary: { analyte: 'COD', value: 20, unit: 'mg/L' } }, submit: true })
  const row = listRecords(db, { status: 'submitted' }).find(r => r.id === rec.id) as any
  assert.equal(row.contract_id, c.id)
  assert.equal(row.client, '审核聚合厂')
  const masked = maskSheetForUser({ roles: ['tester', 'reviewer'] }, row) as any
  assert.ok(!masked.client && !masked.contract_id, '检测员兼复核仍盲')
})

// 真盲不因此破口：纯检测员拉交接单/通知单列表，单位/项目/委托号/期次一律脱掉
test('盲用户视角的交接单/通知单列表：client/project/contract_id/round_id 全脱', () => {
  const db = freshDb()
  createUser(db, { username: 'licy3', name: '赵采样', roles: ['sampler'], password: 'x12345' })
  const c = createContract(db, { client: '盲测厂', project: '例行', periodStart: '2026-07-01', periodEnd: '2026-07-01' })
  acceptContract(db, c.id, '周登记')
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-07-01', periodEnd: '2026-07-01',
    points: [{ element: '废水', point: '1#总排口', items: ['COD'], freq: composeFreq(1, 0), standard: 'GB8978' }],
  })
  reviewScheme(db, c.id, 'approve', '许技术')
  const r = listRounds(db, c.id)[0]
  assignRound(db, r.id, ['赵采样'])
  confirmRoundField(db, r.id, { name: '赵采样' })
  sampleRound(db, r.id, { name: '赵采样', username: 'licy3' })
  const sh = listHandoverSheets(db, { roundId: r.id })[0]
  sendHandoverSheet(db, sh.id, { name: '赵采样', username: 'licy3' })
  confirmHandoverSheet(db, sh.id, { name: '吴质控', username: 'qzk' })
  createNoticeFromSheet(db, sh.id, { name: '吴质控', username: 'qzk' })
  const blind = { roles: ['tester'] }
  const bs = maskSheetForUser(blind, listHandoverSheets(db)[0]) as any
  assert.ok(!bs.client && !bs.project && !bs.contract_id && !bs.round_id, `盲交接单还漏：${JSON.stringify({ c: bs.client, p: bs.project, id: bs.contract_id })}`)
  const bn = maskSheetForUser(blind, listTestNotices(db)[0]) as any
  assert.ok(!bn.client && !bn.project && !bn.round_id, '盲通知单还漏')
  const qs = maskSheetForUser({ roles: ['qc'] }, listHandoverSheets(db)[0]) as any
  assert.equal(qs.client, '盲测厂', '质控员不受影响')
})
