// 批次二·分包进报告：分包项目结果行打 sub 标记，报告带分包声明（分包方+证书号）
import { test } from 'node:test'
import assert from 'node:assert'
import { openDb } from '../src/db.ts'
import {
  createContract, acceptContract, createScheme, reviewScheme, composeFreq, createUser,
  listRounds, assignRound, confirmRoundField, sampleRound,
  listHandoverSheets, sendHandoverSheet, confirmHandoverSheet,
  saveRecord, reviewRecord, generateRoundReport, addSubcontract, getSample,
} from '../src/handlers.ts'

test('分包项目：结果行 sub=true，data.subNote 带分包方与证书号', () => {
  const db = openDb(':memory:')
  createUser(db, { username: 'demo_sampler', name: '赵采样', roles: ['sampler'], password: 'x12345' })
  createUser(db, { username: 'qianqc', name: '吴质控', roles: ['qc'], password: 'x12345' })
  const c = createContract(db, { client: '分包厂', project: '例行', periodStart: '2026-07-01', periodEnd: '2026-07-01' })
  acceptContract(db, c.id, '周登记')
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-07-01', periodEnd: '2026-07-01',
    points: [{ element: '废水', point: '总排口', items: ['COD', '烷基汞'], freq: composeFreq(1, 0), standard: 'GB 8978' }],
  })
  reviewScheme(db, c.id, 'approve', '许技术')
  addSubcontract(db, { contractId: c.id, items: '烷基汞', subcontractor: '烟台鲁东分析测试有限公司', qualification: '221520340350', consent: true, status: '已分包' }, { name: '周登记' })
  const r = listRounds(db, c.id)[0]
  assignRound(db, r.id, ['赵采样'])
  confirmRoundField(db, r.id, { name: '赵采样' })
  const made = sampleRound(db, r.id, { name: '赵采样', username: 'demo_sampler' })
  const sh = listHandoverSheets(db, { roundId: r.id })[0]
  sendHandoverSheet(db, sh.id, { name: '赵采样', username: 'demo_sampler' })
  confirmHandoverSheet(db, sh.id, { name: '吴质控', username: 'qianqc' })
  for (const s0 of made) {
    const s = getSample(db, s0.id)!
    for (const analyte of s.items) {
      let rec = saveRecord(db, {
        sampleId: s.id, code: analyte === 'COD' ? 'HJ-TC-103' : 'HJ-TC-901', analyte, method: 'x',
        data: { rows: [], meta: {}, resultSummary: { analyte, value: 1, unit: 'mg/L' } }, submit: true,
      })
      rec = reviewRecord(db, rec.id, 'review_pass', '郑复核')
      reviewRecord(db, rec.id, 'approve', '孙审核')
    }
  }
  const rp = generateRoundReport(db, r.id, 2026, '周登记')
  const hg = rp.data.results.find((x: any) => x.analyte === '烷基汞' && !x.qcType)
  const cod = rp.data.results.find((x: any) => x.analyte === 'COD' && !x.qcType)
  assert.equal(hg.sub, true, '分包项目打标')
  assert.ok(!cod.sub, '非分包不打标')
  assert.ok(rp.data.subNote.includes('烟台鲁东分析测试有限公司'), rp.data.subNote)
  assert.ok(rp.data.subNote.includes('221520340350'))
  assert.ok(rp.data.subNote.includes('分包'))
})
