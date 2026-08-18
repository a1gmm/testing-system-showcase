// 批次一切片3/4：待认领任务筛选 + 真盲脱敏 + 解密单149
import { test } from 'node:test'
import assert from 'node:assert'
import { openDb } from '../src/db.ts'
import {
  createContract, acceptContract, createScheme, reviewScheme, composeFreq, createUser,
  listRounds, assignRound, confirmRoundField, sampleRound,
  listHandoverSheets, sendHandoverSheet, confirmHandoverSheet,
  createNoticeFromSheet, issueTestNotice, listTestTasks,
  maskSampleForUser, isBlindViewer, decodeNotice,
} from '../src/handlers.ts'

const qcActor = { name: '吴质控', username: 'qianqc' }

function setup(db: any) {
  createUser(db, { username: 'demo_sampler', name: '赵采样', roles: ['sampler'], password: 'x12345' })
  createUser(db, { username: 'qianqc', name: '吴质控', roles: ['qc'], password: 'x12345' })
  const c = createContract(db, { client: '保密厂', project: '例行', periodStart: '2026-07-01', periodEnd: '2026-07-01' })
  acceptContract(db, c.id, '周登记')
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-07-01', periodEnd: '2026-07-01',
    points: [{ element: '废水', point: '1#总排口', items: ['COD'], freq: composeFreq(1, 0), standard: 'GB8978' }],
  })
  reviewScheme(db, c.id, 'approve', '许技术')
  const r = listRounds(db, c.id)[0]
  assignRound(db, r.id, ['赵采样'])
  confirmRoundField(db, r.id, { name: '赵采样' })
  const made = sampleRound(db, r.id, { name: '赵采样', username: 'demo_sampler' })
  const sh = listHandoverSheets(db, { roundId: r.id })[0]
  sendHandoverSheet(db, sh.id, { name: '赵采样', username: 'demo_sampler' })
  confirmHandoverSheet(db, sh.id, qcActor)
  return { c, r, made, sh }
}

test('listTestTasks 支持 unclaimed 筛选：只回 assignee 为空的', () => {
  const db = openDb(':memory:')
  const { sh } = setup(db)
  const n = createNoticeFromSheet(db, sh.id, qcActor)
  issueTestNotice(db, n.id, qcActor)
  const un = listTestTasks(db, { unclaimed: true })
  assert.ok(un.length >= 1)
  assert.ok(un.every(t => !t.assignee))
})

test('真盲脱敏：纯检测员看不到受检单位与点位；质控/采样/登记不脱敏', () => {
  const db = openDb(':memory:')
  const { made } = setup(db)
  const s = made.find(x => !x.qc_type)!
  const tester = { username: 't1', name: '赵检测', roles: ['tester'] } as any
  const qc = { username: 'q1', name: '吴质控', roles: ['qc'] } as any
  const both = { username: 'b1', name: '兼职', roles: ['tester', 'sampler'] } as any
  assert.equal(isBlindViewer(tester), true)
  assert.equal(isBlindViewer(qc), false)
  assert.equal(isBlindViewer(both), false, '兼采样岗的能看（他自己采的）')
  const masked = maskSampleForUser(tester, s)
  assert.equal(masked.client, '', '受检单位脱敏')
  assert.equal(masked.point_name, null, '点位脱敏')
  assert.equal(masked.point_code, null)
  assert.equal(masked.contract_id, null, '委托号也要脱——工作台项目列表能按委托号反查单位名')
  assert.equal(masked.round_id, null, '期次号内含委托号，一并脱')
  assert.equal(masked.matrix, s.matrix, '介质保留')
  assert.deepEqual(masked.items, s.items, '检测项目保留')
  const clear = maskSampleForUser(qc, s)
  assert.equal(clear.client, s.client)
  assert.equal(clear.point_name, s.point_name)
})

test('解密单149：按通知单反查 样号↔点位↔受检单位', () => {
  const db = openDb(':memory:')
  const { sh, made } = setup(db)
  const n = createNoticeFromSheet(db, sh.id, qcActor)
  const rows = decodeNotice(db, n.id)
  assert.equal(rows.length, n.groups.length)
  const s = made.find(x => !x.qc_type)!
  const row = rows.find((x: any) => x.sampleId === s.id)!
  assert.equal(row.pointName, '1#总排口')
  assert.equal(row.client, '保密厂')
  assert.ok('qcType' in row, '质控样在解密单里标明类型')
})
