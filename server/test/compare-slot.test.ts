// 批次二·比对插槽（HJ 355口径，照6份比对报告拆解实证）：
// 分档取限值（按实验室均值）、逐对算误差、n对取m对（3取2/4取3/≥5取4）、
// pH按均值绝对误差、流量/质控样±10%、液位6组取最大差≤12mm；报告总结论恒"不予判定。"
import { test } from 'node:test'
import assert from 'node:assert'
import { openDb } from '../src/db.ts'
import {
  judgeCompareGroup,
  createContract, acceptContract, createScheme, reviewScheme, composeFreq, createUser,
  listRounds, assignRound, confirmRoundField, sampleRound,
  listHandoverSheets, sendHandoverSheet, confirmHandoverSheet,
  saveRecord, reviewRecord, generateRoundReport, getSample,
} from '../src/handlers.ts'

test('浓度分档：COD高档±15%相对误差、3对取2对', () => {
  // 实验室均值 123 ≥100 → ±15%；第2对超差但3取2仍合格
  const g = judgeCompareGroup({
    type: 'conc', analyte: 'COD',
    pairs: [{ online: 104.6, lab: 123 }, { online: 90, lab: 120 }, { online: 118, lab: 121 }],
  } as any)
  assert.equal(g.errType, '相对误差')
  assert.ok(g.limitText.includes('15%'), g.limitText)
  assert.equal(g.perPass.filter(Boolean).length, 2)
  assert.equal(g.pass, true, '3对满足2对即合格')
  // 逐对误差保留符号
  assert.ok(g.errs[0] < 0 && Math.abs(g.errs[0] + 14.96) < 0.1, String(g.errs[0]))
})

test('浓度低档：氨氮<2mg/L走绝对误差±0.3；4对取3对不满足则不合格', () => {
  const g = judgeCompareGroup({
    type: 'conc', analyte: '氨氮',
    pairs: [{ online: 1.0, lab: 1.2 }, { online: 1.9, lab: 1.2 }, { online: 1.8, lab: 1.2 }, { online: 1.25, lab: 1.2 }],
  } as any)
  assert.equal(g.errType, '绝对误差')
  assert.ok(g.limitText.includes('0.3'))
  // 误差: -0.2✓, 0.7✗, 0.6✗, 0.05✓ → 4对只中2对 < 3 → 不合格
  assert.equal(g.pass, false)
})

test('pH：4次按均值对均值算绝对误差±0.5', () => {
  const g = judgeCompareGroup({
    type: 'pH', analyte: 'pH',
    pairs: [{ online: 7.2, lab: 7.0 }, { online: 7.3, lab: 7.0 }, { online: 7.1, lab: 7.0 }, { online: 7.2, lab: 7.0 }],
  } as any)
  assert.equal(g.errType, '绝对误差')
  assert.ok(Math.abs(g.err - 0.2) < 0.01, String(g.err))
  assert.equal(g.pass, true)
})

test('流量：10分钟累计相对误差±10%（取绝对值报）；液位：6组取最大绝对差≤12mm', () => {
  const f = judgeCompareGroup({ type: 'flow', analyte: '流量', pairs: [{ online: 99.76, lab: 100 }] } as any)
  assert.equal(f.pass, true)
  assert.ok(Math.abs(f.err - 0.24) < 0.01, String(f.err))
  const l = judgeCompareGroup({
    type: 'level', analyte: '液位',
    pairs: [{ online: 101.4, lab: 100 }, { online: 100.2, lab: 100 }, { online: 100.9, lab: 100 }, { online: 99.8, lab: 100 }, { online: 100.1, lab: 100 }, { online: 100.6, lab: 100 }],
  } as any)
  assert.equal(l.errType, '绝对误差')
  assert.ok(Math.abs(l.err - 1.4) < 0.01, '取6组最大差')
  assert.equal(l.pass, true)
  const l2 = judgeCompareGroup({ type: 'level', analyte: '液位', pairs: [{ online: 113, lab: 100 }] } as any)
  assert.equal(l2.pass, false)
})

test('质控样：0.5倍量程标样±10%相对误差', () => {
  const g = judgeCompareGroup({ type: 'qc', analyte: 'COD质控样', pairs: [{ online: 22, lab: 25 }], stdValue: 25 } as any)
  assert.equal(g.errType, '相对误差')
  assert.ok(g.limitText.includes('10%'))
  assert.equal(g.pass, false, '-12%超±10%')
})

test('比对报告：记录带 data.compare → compareBlocks 判定入报告，总结论恒"不予判定。"', () => {
  const db = openDb(':memory:')
  createUser(db, { username: 'demo_sampler', name: '赵采样', roles: ['sampler'], password: 'x12345' })
  createUser(db, { username: 'qianqc', name: '吴质控', roles: ['qc'], password: 'x12345' })
  const c = createContract(db, { client: '比对厂', project: '废水在线比对', periodStart: '2026-07-01', periodEnd: '2026-07-01' })
  acceptContract(db, c.id, '周登记')
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-07-01', periodEnd: '2026-07-01',
    points: [{ element: '废水', point: '废水排污口', items: ['COD比对'], freq: composeFreq(1, 0), standard: 'HJ 355-2019' }],
  })
  reviewScheme(db, c.id, 'approve', '许技术')
  const r = listRounds(db, c.id)[0]
  assignRound(db, r.id, ['赵采样'])
  confirmRoundField(db, r.id, { name: '赵采样' })
  const made = sampleRound(db, r.id, { name: '赵采样', username: 'demo_sampler' })
  const sh = listHandoverSheets(db, { roundId: r.id })[0]
  sendHandoverSheet(db, sh.id, { name: '赵采样', username: 'demo_sampler' })
  confirmHandoverSheet(db, sh.id, { name: '吴质控', username: 'qianqc' })
  for (const s0 of made) {
    const s = getSample(db, s0.id)!
    let rec = saveRecord(db, {
      sampleId: s.id, code: 'HJ-TC-501', analyte: 'COD比对', method: 'HJ 355-2019',
      data: {
        rows: [], meta: {},
        compare: [
          { type: 'conc', analyte: 'COD', pairs: [{ time: '10:00', online: 104.6, lab: 123 }, { time: '11:00', online: 118, lab: 120 }, { time: '12:00', online: 119, lab: 121 }] },
          { type: 'flow', analyte: '流量', pairs: [{ online: 99.8, lab: 100 }] },
        ],
      },
      submit: true,
    })
    rec = reviewRecord(db, rec.id, 'review_pass', '郑复核')
    reviewRecord(db, rec.id, 'approve', '孙审核')
  }
  const rp = generateRoundReport(db, r.id, 2026, '周登记')
  assert.ok(Array.isArray(rp.data.compareBlocks) && rp.data.compareBlocks.length >= 2, '比对块进报告')
  const cod = rp.data.compareBlocks.find((b: any) => b.analyte === 'COD')
  assert.equal(cod.pass, true)
  assert.ok(cod.limitText)
  assert.equal(rp.conclusion, '不予判定。', '比对报告总结论恒不予判定')
})
