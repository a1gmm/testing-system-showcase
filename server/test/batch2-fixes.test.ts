// 批次二收尾件：①样号反查报告断链修补 ②合同评审状态机（拍板7：技术负责人签批，权限暂挂管理员）
import { test } from 'node:test'
import assert from 'node:assert'
import { openDb } from '../src/db.ts'
import {
  createContract, acceptContract, createScheme, reviewScheme, composeFreq, createUser,
  listRounds, assignRound, confirmRoundField, sampleRound,
  listHandoverSheets, sendHandoverSheet, confirmHandoverSheet,
  saveRecord, reviewRecord, generateRoundReport,
  findReportsBySample, techReviewContract, getContract,
} from '../src/handlers.ts'

const qc = { name: '吴质控', username: 'qianqc' }

test('样号反查：期次报告 sample_id 为空也能按样品编号查到报告', () => {
  const db = openDb(':memory:')
  createUser(db, { username: 'demo_sampler', name: '赵采样', roles: ['sampler'], password: 'x12345' })
  createUser(db, { username: 'qianqc', name: '吴质控', roles: ['qc'], password: 'x12345' })
  const c = createContract(db, { client: '反查厂', project: '例行', periodStart: '2026-07-01', periodEnd: '2026-07-01' })
  acceptContract(db, c.id, '周登记')
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-07-01', periodEnd: '2026-07-01',
    points: [{ element: '废水', point: 'A口', items: ['COD'], freq: composeFreq(1, 0), standard: '' }],
  })
  reviewScheme(db, c.id, 'approve', '许技术')
  const r = listRounds(db, c.id)[0]
  assignRound(db, r.id, ['赵采样'])
  confirmRoundField(db, r.id, { name: '赵采样' })
  const made = sampleRound(db, r.id, { name: '赵采样', username: 'demo_sampler' })
  const sh = listHandoverSheets(db, { roundId: r.id })[0]
  sendHandoverSheet(db, sh.id, { name: '赵采样', username: 'demo_sampler' })
  confirmHandoverSheet(db, sh.id, qc)
  for (const s of made) {
    let rec = saveRecord(db, {
      sampleId: s.id, code: 'HJ-TC-103', analyte: 'COD',
      data: { rows: [], meta: {}, resultSummary: { analyte: 'COD', value: 10, unit: 'mg/L' } }, submit: true,
    })
    rec = reviewRecord(db, rec.id, 'review_pass', '郑复核')
    reviewRecord(db, rec.id, 'approve', '孙审核')
  }
  const rp = generateRoundReport(db, r.id, 2026, '周登记')
  assert.equal(rp.sample_id, null, '期次报告本身不挂单个样品')
  const normal = made.find(s => !s.qc_type)!
  const found = findReportsBySample(db, normal.id)
  assert.equal(found.length, 1, '按样品编号能查到期次报告')
  assert.equal(found[0].id, rp.id)
  assert.deepEqual(findReportsBySample(db, 'W000000-9'), [], '不存在的样号返回空')
})

test('合同评审状态机：技术负责人签批（暂挂管理员）→ 同意/不同意留痕，重复签批拦', () => {
  const db = openDb(':memory:')
  const c = createContract(db, { client: '评审厂', project: 'x', periodStart: '2026-07-01', periodEnd: '2026-07-01' })
  assert.ok(!getContract(db, c.id)!.tech_approved_at, '初始未签批')
  const ok = techReviewContract(db, c.id, 'approve', { name: '管理员代', username: 'admin' }, '资源满足')
  assert.equal(ok.tech_approved_by, '管理员代')
  assert.ok(ok.tech_approved_at)
  assert.equal(ok.tech_approve_note, '资源满足')
  assert.throws(() => techReviewContract(db, c.id, 'approve', { name: '别人', username: 'x' }), /已签批/)
  // 不同意：单独一单，意见落库、不置生效
  const c2 = createContract(db, { client: '拒签厂', project: 'x', periodStart: '2026-07-01', periodEnd: '2026-07-01' })
  const no = techReviewContract(db, c2.id, 'reject', { name: '管理员代', username: 'admin' }, '人手不够')
  assert.equal(no.tech_approved_at, null, '不同意不算生效')
  assert.equal(no.tech_approve_note, '人手不够')
  assert.equal((no as any).tech_review_result, 'reject')
})
