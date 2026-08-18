// 批次一切片2：检测任务通知单 HJ-TC-137（test_notices）
// 拍板：质控员从已签收交接单一键生成、承办人单签、下达即建"待认领"任务（认领为主+可指派）
import { test } from 'node:test'
import assert from 'node:assert'
import { openDb } from '../src/db.ts'
import {
  createContract, acceptContract, createScheme, reviewScheme, composeFreq, createUser,
  listRounds, assignRound, confirmRoundField, sampleRound,
  listHandoverSheets, sendHandoverSheet, confirmHandoverSheet,
  createNoticeFromSheet, getTestNotice, listTestNotices, issueTestNotice, updateTestNotice,
  listTestTasks, claimTestTask, assignTestTasks,
} from '../src/handlers.ts'

const qcActor = { name: '吴质控', username: 'qianqc' }
const samplerActor = { name: '赵采样', username: 'demo_sampler' }

function setup(db: any, opts: { reject?: boolean } = {}) {
  createUser(db, { username: 'demo_sampler', name: '赵采样', roles: ['sampler'], password: 'x12345' })
  createUser(db, { username: 'qianqc', name: '吴质控', roles: ['qc'], password: 'x12345' })
  createUser(db, { username: 'zhaoce', name: '赵检测', roles: ['tester'], password: 'x12345' })
  createUser(db, { username: 'sunce', name: '孙检测', roles: ['tester'], password: 'x12345' })
  const c = createContract(db, { client: '通知厂', project: '例行', periodStart: '2026-07-01', periodEnd: '2026-07-01' })
  acceptContract(db, c.id, '周登记')
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-07-01', periodEnd: '2026-07-01',
    points: [{ element: '废水', point: '1#总排口', items: ['COD', '氨氮'], freq: composeFreq(1, 0), standard: 'GB8978' }],
  })
  reviewScheme(db, c.id, 'approve', '许技术')
  const r = listRounds(db, c.id)[0]
  assignRound(db, r.id, ['赵采样'])
  confirmRoundField(db, r.id, { name: '赵采样' })
  const made = sampleRound(db, r.id, samplerActor)
  const sh = listHandoverSheets(db, { roundId: r.id })[0]
  sendHandoverSheet(db, sh.id, samplerActor)
  const rejects = opts.reject ? [{ sampleId: made.filter(s => !s.qc_type)[0].id, reason: '破损' }] : []
  confirmHandoverSheet(db, sh.id, qcActor, { rejects })
  return { c, r, made, sh }
}

test('从已签收交接单一键生成通知单：编号TZ、样品分组项目自动带出、承办人=质控员、状态draft', () => {
  const db = openDb(':memory:')
  const { sh, made } = setup(db)
  const n = createNoticeFromSheet(db, sh.id, qcActor)
  assert.match(n.id, /^TZ\d{4}-\d{4}$/, `通知单号 ${n.id}`)
  assert.equal(n.status, 'draft')
  assert.equal(n.sheet_id, sh.id)
  assert.equal(n.issuer, '吴质控')
  // 样品分组：每个样品一组，项目从样品带出
  const s0 = made[0]
  const grp = n.groups.find((g: any) => g.sampleId === s0.id)
  assert.ok(grp, '按样品分组')
  assert.deepEqual(grp.analytes, s0.items)
  // 任务类别按介质自动勾：废水→污水
  assert.equal(n.category, '污水')
})

test('被拒收的样品不进通知单', () => {
  const db = openDb(':memory:')
  const { sh, made } = setup(db, { reject: true })
  const rejected = made.filter(s => !s.qc_type)[0]
  const n = createNoticeFromSheet(db, sh.id, qcActor)
  assert.ok(!n.groups.some((g: any) => g.sampleId === rejected.id), '拒收样品不应出现在通知单里')
})

test('未签收的交接单不能生成通知单；同一交接单不能重复生成', () => {
  const db = openDb(':memory:')
  const { sh } = setup(db)
  createNoticeFromSheet(db, sh.id, qcActor)
  assert.throws(() => createNoticeFromSheet(db, sh.id, qcActor), /已生成/)
  const db2 = openDb(':memory:')
  createUser(db2, { username: 'licy2', name: '李二', roles: ['sampler'], password: 'x12345' })
  const c2 = createContract(db2, { client: '未签收厂', project: 'x', periodStart: '2026-07-01', periodEnd: '2026-07-01' })
  // 直接造一张未签收的单：走正常流程到 sent 即可
  acceptContract(db2, c2.id, '周登记')
  createScheme(db2, { contractId: c2.id, cycleMonths: 0, periodStart: '2026-07-01', periodEnd: '2026-07-01', points: [{ element: '废水', point: 'A', items: ['COD'], freq: composeFreq(1, 0), standard: '' }] })
  reviewScheme(db2, c2.id, 'approve', '许技术')
  const r2 = listRounds(db2, c2.id)[0]
  assignRound(db2, r2.id, ['李二'])
  confirmRoundField(db2, r2.id, { name: '李二' })
  sampleRound(db2, r2.id, { name: '李二' })
  const sh2 = listHandoverSheets(db2, { roundId: r2.id })[0]
  assert.throws(() => createNoticeFromSheet(db2, sh2.id, qcActor), /签收/)
})

test('下达：状态issued、下达时间落库、按样品×项目生成待认领任务（assignee为空）', () => {
  const db = openDb(':memory:')
  const { sh } = setup(db)
  const n = createNoticeFromSheet(db, sh.id, qcActor)
  const issued = issueTestNotice(db, n.id, qcActor)
  assert.equal(issued.status, 'issued')
  assert.ok(issued.issued_at)
  // 每个样品×项目一条任务，待认领
  const tasks = listTestTasks(db, {})
  const fromNotice = tasks.filter(t => n.groups.some((g: any) => g.sampleId === t.sample_id))
  assert.ok(fromNotice.length >= 2, '应生成任务')
  assert.ok(fromNotice.every(t => !t.assignee), '任务应为待认领（assignee空）')
  // 重复下达报错
  assert.throws(() => issueTestNotice(db, n.id, qcActor), /已下达/)
})

test('检测员认领待认领任务；已认领的不能抢；质控员仍可改派', () => {
  const db = openDb(':memory:')
  const { sh, made } = setup(db)
  const n = createNoticeFromSheet(db, sh.id, qcActor)
  issueTestNotice(db, n.id, qcActor)
  const s0 = made.find(s => !s.qc_type)!
  const t = listTestTasks(db, { sampleId: s0.id })[0]
  const claimed = claimTestTask(db, t.id, { name: '赵检测', username: 'zhaoce' })
  assert.equal(claimed.assignee, '赵检测')
  // 孙检测再抢同一条 → 报错
  assert.throws(() => claimTestTask(db, t.id, { name: '孙检测', username: 'sunce' }), /认领/)
  // 质控员改派给孙检测（沿用 assignTestTasks 覆盖语义）
  const re = assignTestTasks(db, s0.id, [{ analyte: t.analyte, assignee: '孙检测', assigneeUsername: 'sunce' }], qcActor)
  assert.equal(re.find(x => x.analyte === t.analyte)!.assignee, '孙检测')
})

test('草稿可改完成时限与备注；下达后不能改', () => {
  const db = openDb(':memory:')
  const { sh } = setup(db)
  const n = createNoticeFromSheet(db, sh.id, qcActor)
  const upd = updateTestNotice(db, n.id, { dueAt: '2026-07-05', note: 'BOD5 07.05' }, qcActor)
  assert.equal(upd.due_at, '2026-07-05')
  issueTestNotice(db, n.id, qcActor)
  assert.throws(() => updateTestNotice(db, n.id, { note: '改不动' }, qcActor), /下达/)
  // 列表能按状态查
  assert.equal(listTestNotices(db, { status: 'issued' }).length, 1)
  assert.ok(getTestNotice(db, n.id))
})
