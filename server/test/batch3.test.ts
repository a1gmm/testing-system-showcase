// 批次三：报告发放登记 + 留样处置 + 归档清单（装订顺序索引）
import { test } from 'node:test'
import assert from 'node:assert'
import { openDb } from '../src/db.ts'
import {
  createContract, acceptContract, createScheme, reviewScheme, composeFreq, createUser,
  listRounds, assignRound, confirmRoundField, sampleRound,
  listHandoverSheets, sendHandoverSheet, confirmHandoverSheet,
  createNoticeFromSheet, issueTestNotice,
  saveRecord, reviewRecord, generateRoundReport, checkReport, issueReport,
  addReportDelivery, listReportDeliveries,
  setRetention, disposeRetention, getRetention,
  archiveIndex, getSample, claimTestTask, listTestTasks,
} from '../src/handlers.ts'

function fullChain(db: any) {
  createUser(db, { username: 'demo_sampler', name: '赵采样', roles: ['sampler'], password: 'x12345' })
  createUser(db, { username: 'qianqc', name: '吴质控', roles: ['qc'], password: 'x12345' })
  const c = createContract(db, { client: '批三厂', project: '例行', periodStart: '2026-07-01', periodEnd: '2026-07-01' })
  acceptContract(db, c.id, '周登记')
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-07-01', periodEnd: '2026-07-01',
    points: [{ element: '废水', point: '总排口', items: ['COD'], freq: composeFreq(1, 0), standard: 'GB 8978' }],
  })
  reviewScheme(db, c.id, 'approve', '许技术')
  const r = listRounds(db, c.id)[0]
  assignRound(db, r.id, ['赵采样'])
  confirmRoundField(db, r.id, { name: '赵采样' })
  const made = sampleRound(db, r.id, { name: '赵采样', username: 'demo_sampler' })
  const sh = listHandoverSheets(db, { roundId: r.id })[0]
  sendHandoverSheet(db, sh.id, { name: '赵采样', username: 'demo_sampler' })
  confirmHandoverSheet(db, sh.id, { name: '吴质控', username: 'qianqc' })
  const n = createNoticeFromSheet(db, sh.id, { name: '吴质控', username: 'qianqc' })
  issueTestNotice(db, n.id, { name: '吴质控', username: 'qianqc' })
  for (const s0 of made) {
    const s = getSample(db, s0.id)!
    const t = listTestTasks(db, { sampleId: s.id })[0]
    if (t && !t.assignee) claimTestTask(db, t.id, { name: '赵检测', username: 'zhaoce' })
    let rec = saveRecord(db, {
      sampleId: s.id, code: 'HJ-TC-103', analyte: 'COD', method: 'HJ 828-2017',
      data: { rows: [], meta: {}, resultSummary: { analyte: 'COD', value: 30, unit: 'mg/L' } },
      submit: true, who: '赵检测', whoUsername: 'zhaoce',
    })
    rec = reviewRecord(db, rec.id, 'review_pass', '郑复核')
    reviewRecord(db, rec.id, 'approve', '孙审核')
  }
  const rp = generateRoundReport(db, r.id, 2026, '周登记')
  return { c, r, made, sh, n, rp }
}

test('报告发放登记：只有已签发的能登记；登记后可查', () => {
  const db = openDb(':memory:')
  const { rp } = fullChain(db)
  assert.throws(() => addReportDelivery(db, rp.id, { copies: 2, method: '自取', receiver: '客户老王' }, { name: '周登记' }), /签发/)
  checkReport(db, rp.id, '李审核', 'lish')
  issueReport(db, rp.id, '王批准', 'wangpz')
  const dv = addReportDelivery(db, rp.id, { copies: 2, method: '自取', receiver: '客户老王' }, { name: '周登记', username: 'demo_registrar' })
  assert.equal(dv.copies, 2)
  assert.equal(dv.receiver, '客户老王')
  const list = listReportDeliveries(db, rp.id)
  assert.equal(list.length, 1)
  assert.equal(list[0].deliverer, '周登记')
})

test('留样与处置：登记留样→到期处置留痕；重复处置报错', () => {
  const db = openDb(':memory:')
  const { made } = fullChain(db)
  const sid = made[0].id
  const rt = setRetention(db, sid, { location: '留样柜A-3', until: '2026-08-30' }, { name: '吴质控', username: 'qianqc' })
  assert.equal(rt.location, '留样柜A-3')
  assert.ok(!rt.disposed_at)
  const dp = disposeRetention(db, sid, { method: '中和后排放' }, { name: '吴质控', username: 'qianqc' })
  assert.ok(dp.disposed_at)
  assert.equal(dp.dispose_method, '中和后排放')
  assert.throws(() => disposeRetention(db, sid, { method: '再处置' }, { name: '吴质控' }), /已处置/)
  assert.equal(getRetention(db, sid)!.location, '留样柜A-3')
})

test('归档清单：照三个扫描包实证的装订顺序出索引', () => {
  const db = openDb(':memory:')
  const { rp, n, sh } = fullChain(db)
  const idx = archiveIndex(db, rp.id)
  const secs = idx.map((x: any) => x.section)
  // 顺序（2026-08-01 补环）：报告→合同评审→方案→通知单→解密单→现场记录→交接单→附件→原始记录→质控→前处理→发放→留样
  const want = ['报告正文', '委托合同及评审', '监测方案', '检测任务通知单', '样品解密单', '现场采样记录', '样品交接单', '现场照片及附件', '检测原始记录', '质控记录', '前处理记录', '发放与收回登记', '留样处置']
  assert.deepEqual(secs, want)
  const notice = idx.find((x: any) => x.section === '检测任务通知单')
  assert.ok(notice.items.some((it: any) => it.id === n.id))
  const sheet = idx.find((x: any) => x.section === '样品交接单')
  assert.ok(sheet.items.some((it: any) => it.id === sh.id))
  const recs = idx.find((x: any) => x.section === '检测原始记录')
  assert.ok(recs.items.length >= 1, '记录进清单')
})
