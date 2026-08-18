import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import {
  createContract, createScheme, reviewScheme,
  getContract, getScheme, listRounds,
  composeFreq, parseFreq, assignRound, createUser,
} from '../src/handlers.ts'

function freshDb() {
  const db = openDb(':memory:')
  // 体检39：派工名字必须是在职采样员账号
  createUser(db, { username: 'zhangsan', name: '张三', roles: ['sampler'], password: 'x12345' })
  return db
}

// ——— 频次结构化：每天N次 + 监测周期 ———
test('频次：composeFreq / parseFreq 新规范格式往返一致', () => {
  for (const [pd, cm] of [[1, 0], [2, 1], [1, 3], [3, 6], [1, 12]] as const) {
    const f = composeFreq(pd, cm)
    const r = parseFreq(f)
    assert.equal(r.perDay, pd, `perDay for ${f}`)
    assert.equal(r.cycleMonths, cm, `cycle for ${f}`)
  }
})

test('频次：兼容旧自由文本（1次/月、1次/天4次/年、空）', () => {
  assert.deepEqual(parseFreq('1次/月'), { perDay: 1, cycleMonths: 1 })
  assert.deepEqual(parseFreq('1次/天，4次/年'), { perDay: 1, cycleMonths: 3 })  // 4次/年 = 每季度
  assert.deepEqual(parseFreq(''), { perDay: 1, cycleMonths: 0 })
})

// ——— 问题8：方案保存即同步样品计划（基质/项目/数量/周期以方案为准）———
test('方案保存覆盖旧样品计划（消灭方案写地表水、清单显示废气）', () => {
  const db = freshDb()
  const c = createContract(db, {
    client: '某钢厂', periodStart: '2026-01-01', periodEnd: '2026-12-31',
    plan: [{ matrix: '废气', items: ['SO2'], qty: 1, cycleMonths: 3 }],
  }, 2026)
  createScheme(db, {
    contractId: c.id, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    points: [{ element: '地表水', point: '河心', items: ['COD'], freq: composeFreq(2, 1), standard: 'GB3838-2002' }],
  }, 2026)
  const c2 = getContract(db, c.id)!
  assert.equal(c2.plan.length, 1)
  assert.equal(c2.plan[0].matrix, '地表水')          // 以方案为准，不再是废气
  assert.deepEqual(c2.plan[0].items, ['COD'])
  assert.equal(c2.plan[0].qty, 2)                    // 每天2次 → 数量2
  assert.equal(c2.plan[0].cycle_months, 1)           // 每月
})

test('方案无点位时不动样品计划（旧流程 createScheme 不带 points 不清空计划）', () => {
  const db = freshDb()
  const c = createContract(db, { client: 'A', plan: [{ matrix: '废水', items: ['COD'], qty: 3, cycleMonths: 0 }] }, 2026)
  createScheme(db, { contractId: c.id, cycleMonths: 0, periodStart: '2026-07-05', periodEnd: '2026-07-05' }, 2026)
  const c2 = getContract(db, c.id)!
  assert.equal(c2.plan.length, 1)
  assert.equal(c2.plan[0].qty, 3)                    // 计划保留
})

// ——— 问题2：限值按各自点位挂执行标准，不再全挂第一行 ———
test('达标限值各挂本项目所在点位的执行标准（修全挂第一行的bug）', () => {
  const db = freshDb()
  const c = createContract(db, { client: 'B', periodStart: '2026-01-01', periodEnd: '2026-12-31', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] }, 2026)
  createScheme(db, {
    contractId: c.id, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    points: [
      { element: '废水', point: '总排口', items: ['COD', '氨氮'], freq: composeFreq(1, 1), standard: 'GB8978-1996' },
      { element: '有组织废气', point: '烟囱', items: ['SO2'], freq: composeFreq(1, 3), standard: 'GB16297-1996' },
    ],
    limits: [
      { analyte: 'COD', op: '≤', value: 50, unit: 'mg/L' },
      { analyte: 'SO2', op: '≤', value: 100, unit: 'mg/m³' },
    ],
  }, 2026)
  const s = getScheme(db, c.id)!
  const cod = s.limits.find(l => l.analyte === 'COD')!
  const so2 = s.limits.find(l => l.analyte === 'SO2')!
  assert.equal(cod.standard, 'GB8978-1996')
  assert.equal(so2.standard, 'GB16297-1996')          // 不是 GB8978（旧bug会全挂第一行）
})

test('限值自带标准优先于按点位推断', () => {
  const db = freshDb()
  const c = createContract(db, { client: 'C', periodStart: '2026-01-01', periodEnd: '2026-12-31', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] }, 2026)
  createScheme(db, {
    contractId: c.id, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    points: [{ element: '废水', point: '总排口', items: ['COD'], freq: composeFreq(1, 1), standard: 'GB8978-1996' }],
    limits: [{ analyte: 'COD', op: '≤', value: 50, unit: 'mg/L', standard: '山东地标DB37/599' }],
  }, 2026)
  const s = getScheme(db, c.id)!
  assert.equal(s.limits[0].standard, '山东地标DB37/599')
})

test('单次点位不被方案级周期误当季度：混排下单次点位只出1期', () => {
  const db = freshDb()
  const c = createContract(db, { client: 'E', periodStart: '2026-01-01', periodEnd: '2026-12-31' }, 2026)
  // 前端存盘：方案级 cycleMonths 传 0，周期全下放到点位（一个每季度、一个单次）
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    points: [
      { element: '废水', point: '总排口', items: ['COD'], freq: composeFreq(1, 3), standard: 'GB8978' },   // 每季度 → 4 期
      { element: '土壤', point: '厂区', items: ['pH'], freq: composeFreq(1, 0), standard: 'GB15618' },      // 单次 → 只在起始 1 期
    ],
  }, 2026)
  reviewScheme(db, c.id, 'approve', '许技术')
  const rounds = listRounds(db, c.id)
  const itemsOf = (r: any) => (typeof r.items === 'string' ? JSON.parse(r.items) : r.items) as { matrix: string }[]
  // 土壤单次只应出现在起始日那一期，不应按季度铺满全年
  const soil = rounds.filter(r => itemsOf(r).some(it => it.matrix === '土壤'))
  assert.equal(soil.length, 1, '单次点位只排 1 期')
  assert.equal(soil[0].due_date, '2026-01-01')
  // 每季度点位仍是 4 期
  const cod = rounds.filter(r => itemsOf(r).some(it => it.matrix === '废水'))
  assert.equal(cod.length, 4, '每季度点位 4 期')
})

// ——— 问题9：方案重新批准，未派工的期次按新周期重排，已派工的提示人工 ———
test('方案重排：未派工期次按新周期重排，已派工期次保留并计入需人工', () => {
  const db = freshDb()
  const c = createContract(db, { client: 'D', periodStart: '2026-01-01', periodEnd: '2026-12-31' }, 2026)
  // 首版：每季度一次 → 一年 4 期
  createScheme(db, {
    contractId: c.id, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    points: [{ element: '废水', point: '总排口', items: ['COD'], freq: composeFreq(1, 3), standard: 'GB8978' }],
  }, 2026)
  reviewScheme(db, c.id, 'approve', '许技术')
  let rounds = listRounds(db, c.id)
  assert.equal(rounds.length, 4)
  // 第1期派工给张三
  assignRound(db, rounds[0].id, '张三', '2026-01-10')
  // 改版：每半年一次，重新提交并批准
  createScheme(db, {
    contractId: c.id, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    points: [{ element: '废水', point: '总排口', items: ['COD'], freq: composeFreq(1, 6), standard: 'GB8978' }],
  }, 2026)
  const res: any = reviewScheme(db, c.id, 'approve', '许技术')
  assert.ok(res._reschedule, '返回重排摘要')
  assert.equal(res._reschedule.manual, 1, '已派工的1期需人工处理')
  rounds = listRounds(db, c.id)
  // 已派工的那一期仍在、仍挂张三
  const kept = rounds.find(r => r.sampler === '张三')
  assert.ok(kept, '已派工期次保留')
  // 未派工期次按新周期（半年）重排：应存在 7 月那一期
  assert.ok(rounds.some(r => r.due_date.startsWith('2026-07')), '按新周期排出7月期次')
})
