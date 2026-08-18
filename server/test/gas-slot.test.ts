// 批次二·有组织废气插槽（后端）：报告带排气筒参数附表数据 + 折算/速率字段透传
import { test } from 'node:test'
import assert from 'node:assert'
import { openDb } from '../src/db.ts'
import {
  createContract, acceptContract, createScheme, reviewScheme, composeFreq, createUser,
  upsertPoint, listRounds, assignRound, confirmRoundField, sampleRound,
  listHandoverSheets, sendHandoverSheet, confirmHandoverSheet,
  saveRecord, reviewRecord, generateRoundReport,
} from '../src/handlers.ts'

test('有组织废气期次报告：data.stacks 带排气筒静态参数、结果行透传折算/速率', () => {
  const db = openDb(':memory:')
  createUser(db, { username: 'demo_sampler', name: '赵采样', roles: ['sampler'], password: 'x12345' })
  createUser(db, { username: 'qianqc', name: '吴质控', roles: ['qc'], password: 'x12345' })
  const c = createContract(db, { client: '气厂', project: '例行', periodStart: '2026-07-01', periodEnd: '2026-07-01' })
  acceptContract(db, c.id, '周登记')
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-07-01', periodEnd: '2026-07-01',
    points: [{ element: '有组织废气', point: '1#排气筒', items: ['二氧化硫'], freq: composeFreq(3, 0), standard: 'DB37/2374-2018' }],
    limits: [{ analyte: '二氧化硫', op: '≤', value: 100, unit: 'mg/m³', stdName: '锅炉大气污染物排放标准', stdNo: 'DB 37/2374-2018', tableNo: '表2' } as any],
  })
  reviewScheme(db, c.id, 'approve', '许技术')
  // 排气筒静态档案（地基3）：方案同步建点后补参数
  upsertPoint(db, c.id, { name: '1#排气筒', matrix: '有组织废气', stackInfo: { daCode: 'DA001', height: 15, diameter: 0.75, process: '低氮燃烧', fuel: '天然气' } } as any, { name: '许技术' })
  const r = listRounds(db, c.id)[0]
  assignRound(db, r.id, ['赵采样'])
  confirmRoundField(db, r.id, { name: '赵采样' })
  const made = sampleRound(db, r.id, { name: '赵采样', username: 'demo_sampler' })
  assert.ok(made.some(s => !s.qc_type && s.matrix === '有组织废气'))
  const sh = listHandoverSheets(db, { roundId: r.id })[0]
  sendHandoverSheet(db, sh.id, { name: '赵采样', username: 'demo_sampler' })
  confirmHandoverSheet(db, sh.id, { name: '吴质控', username: 'qianqc' })
  for (const s of made) {
    let rec = saveRecord(db, {
      sampleId: s.id, code: 'HJ-TC-642', analyte: '二氧化硫', method: '定电位电解法',
      data: { rows: [], meta: {}, resultSummary: { analyte: '二氧化硫', value: 47, unit: 'mg/m³', corrected: 49, rate: 0.035 } },
      submit: true,
    })
    rec = reviewRecord(db, rec.id, 'review_pass', '郑复核')
    reviewRecord(db, rec.id, 'approve', '孙审核')
  }
  const rp = generateRoundReport(db, r.id, 2026, '周登记')
  // 排气筒附表数据
  assert.ok(Array.isArray(rp.data.stacks), '气类报告要带 stacks')
  const st = rp.data.stacks.find((x: any) => x.name === '1#排气筒')
  assert.ok(st, '有排气筒条目')
  assert.equal(st.stack_info.daCode, 'DA001')
  assert.equal(st.stack_info.fuel, '天然气')
  // 折算/速率透传 + 判定照常
  const row = rp.data.results.find((x: any) => !x.qcType && x.analyte === '二氧化硫')
  assert.equal(row.corrected, 49)
  assert.equal(row.rate, 0.035)
  assert.equal(row.verdict, '达标')
})
