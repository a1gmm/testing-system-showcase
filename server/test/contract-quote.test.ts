import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { rmbUpper } from '../src/rmb.ts'
import { createContract, getContract, quoteRowsToPlan, saveContractQuote } from '../src/handlers.ts'

function freshDb() { return openDb(':memory:') }

// ============ 金额大写 ============
test('rmbUpper：整元', () => {
  assert.equal(rmbUpper(9000), '玖仟元整')
  assert.equal(rmbUpper(28386), '贰万捌仟叁佰捌拾陆元整')
  assert.equal(rmbUpper(100), '壹佰元整')
  assert.equal(rmbUpper(0), '零元整')
})

test('rmbUpper：带角分与中间零', () => {
  assert.equal(rmbUpper(1234.56), '壹仟贰佰叁拾肆元伍角陆分')
  assert.equal(rmbUpper(1005), '壹仟零伍元整')
  assert.equal(rmbUpper(100000), '壹拾万元整')
  assert.equal(rmbUpper(0.5), '伍角')
})

// ============ 报价行 → 检测计划 ============
test('quoteRowsToPlan：周期换算 次/年→cycle_months', () => {
  const plan = quoteRowsToPlan([
    { category: '有组织废气', point: '熔炉排气筒', items: ['颗粒物'], price: 1500, points: 1, perDay: 1, perYear: 2 },
    { category: '废水', point: '污水排放口', items: ['COD'], price: 283, points: 1, perDay: 1, perYear: 4 },
    { category: '噪声', point: '厂界', items: ['厂界噪声'], price: 600, points: 4, perDay: 1, perYear: 1 },
    { category: '废水', point: '总排口', items: ['pH'], price: 100, points: 1, perDay: 1, perYear: 0 },
  ])
  assert.equal(plan[0].cycleMonths, 6)    // 2次/年 → 每半年
  assert.equal(plan[1].cycleMonths, 3)    // 4次/年 → 每季度
  assert.equal(plan[2].cycleMonths, 12)   // 1次/年 → 每年
  assert.equal(plan[3].cycleMonths, 0)    // 0 → 单次
  assert.equal(plan[0].matrix, '废气')     // 有组织废气 → 基质 废气
  assert.equal(plan[2].matrix, '噪声')
  assert.equal(plan[2].qty, 4)            // 点位数 → 样品数
})

test('quoteRowsToPlan：手写项目合并并标注待确认', () => {
  const plan = quoteRowsToPlan([
    { category: '无组织废气', point: '上1下3', items: ['颗粒物', '甲苯'], extraItems: '臭气浓度、vocs-非甲', price: 175, points: 4, perDay: 5, perYear: 12 },
  ])
  assert.deepEqual(plan[0].items, ['颗粒物', '甲苯', '臭气浓度', 'vocs-非甲'])
  assert.ok(plan[0].note.includes('手写'))
  const clean = quoteRowsToPlan([{ category: '废水', point: '排口', items: ['pH'], price: 1, points: 1, perDay: 1, perYear: 1 }])
  assert.equal(clean[0].note, '')
})

// ============ 存报价单：服务端算钱 + 同步计划 ============
test('saveContractQuote：小计合计大写服务端算，getContract 带出 quote', () => {
  const db = freshDb()
  const c = createContract(db, { client: '蓬莱海存数控模具有限公司' }, 2026)
  const saved = saveContractQuote(db, c.id, {
    extNo: 'TCHT2026002', signDate: '2026-01-01', discount: 9000,
    rows: [
      { category: '有组织废气', point: '熔炉排气筒', items: ['颗粒物', '二氧化硫', '氮氧化物'], price: 1500, points: 1, perDay: 1, perYear: 2 },
      { category: '废水', point: '污水排放口', items: ['pH', 'COD', '氨氮', 'SS'], price: 283, points: 1, perDay: 1, perYear: 2 },
    ],
  })
  const q = saved.quote!
  assert.equal(q.rows[0].subtotal, 3000)          // 1500×1×1×2
  assert.equal(q.rows[1].subtotal, 566)           // 283×1×1×2
  assert.equal(q.total, 3566)
  assert.equal(q.discount, 9000)
  assert.equal(q.discountUpper, '玖仟元整')
  const back = getContract(db, c.id)!
  assert.equal(back.quote!.extNo, 'TCHT2026002')
  assert.equal(back.quote!.rows.length, 2)
})

test('saveContractQuote：contract_samples 被替换同步', () => {
  const db = freshDb()
  const c = createContract(db, { client: '客户A', plan: [{ matrix: '废水', items: ['旧项目'], qty: 9 }] }, 2026)
  saveContractQuote(db, c.id, {
    rows: [{ category: '噪声', point: '厂界', items: ['厂界噪声'], price: 600, points: 4, perDay: 1, perYear: 1 }],
  })
  const back = getContract(db, c.id)!
  assert.equal(back.plan.length, 1)
  assert.equal(back.plan[0].matrix, '噪声')
  assert.equal(back.plan[0].qty, 4)
  assert.equal(back.plan[0].cycle_months, 12)
})

test('saveContractQuote：折后价缺省用合计价', () => {
  const db = freshDb()
  const c = createContract(db, { client: '客户B' }, 2026)
  const saved = saveContractQuote(db, c.id, {
    rows: [{ category: '废水', point: '排口', items: ['pH'], price: 100, points: 1, perDay: 1, perYear: 1 }],
  })
  assert.equal(saved.quote!.discount, 100)
  assert.equal(saved.quote!.discountUpper, '壹佰元整')
})

test('createContract 可携带 quote 一步建（计划自动来自报价单）', () => {
  const db = freshDb()
  const c = createContract(db, {
    client: '一步建客户',
    quote: { rows: [{ category: '有组织废气', point: '排气筒', items: ['颗粒物'], price: 900, points: 1, perDay: 1, perYear: 2 }] },
  } as any, 2026)
  assert.ok(c.quote)
  assert.equal(c.quote!.total, 1800)
  assert.equal(c.plan.length, 1)
  assert.equal(c.plan[0].cycle_months, 6)
})

test('saveContractQuote：甲方开票信息一并存，getContract 带回（打印用）', () => {
  const db = freshDb()
  const c = createContract(db, { client: '客户C' }, 2026)
  const saved = saveContractQuote(db, c.id, {
    rows: [{ category: '废水', point: '排口', items: ['pH'], price: 100, points: 1, perDay: 1, perYear: 1 }],
    buyer: { addr: '烟台市某路1号', bank: '工商银行烟台支行', account: '6222020000', taxNo: '91370600XXX', bankNo: '102453', legal: '张三' },
  })
  assert.equal(saved.quote!.buyer!.bank, '工商银行烟台支行')
  const back = getContract(db, c.id)!
  assert.equal(back.quote!.buyer!.addr, '烟台市某路1号')
  assert.equal(back.quote!.buyer!.legal, '张三')
})

test('createContract 一步建时甲方开票信息随 quote 一起存；不填也不报错', () => {
  const db = freshDb()
  const c = createContract(db, {
    client: '开票客户',
    quote: {
      rows: [{ category: '废水', point: '排口', items: ['COD'], price: 100, points: 1, perDay: 1, perYear: 1 }],
      buyer: { taxNo: '91370600ABC' },
    },
  } as any, 2026)
  assert.equal(c.quote!.buyer!.taxNo, '91370600ABC')
  // 不填 buyer 的老调用照样能用
  const c2 = createContract(db, {
    client: '无开票客户',
    quote: { rows: [{ category: '废水', point: '排口', items: ['COD'], price: 100, points: 1, perDay: 1, perYear: 1 }] },
  } as any, 2026)
  assert.ok(c2.quote)
})

test('createContract 建单时可一并填合同评审记录表，存 review_info 且不算已受理', () => {
  const db = freshDb()
  const c = createContract(db, {
    client: '带评审客户',
    quote: { rows: [{ category: '废水', point: '排口', items: ['COD'], price: 100, points: 1, perDay: 1, perYear: 1 }] },
    review: { purpose: '验收监测', manpower: true, instruments: true, environment: false, method: true, subcontract: true, subFee: '500', conclusion: '同意受理' },
  } as any, 2026)
  assert.equal(c.review_info.purpose, '验收监测')
  assert.equal(c.review_info.environment, false)   // 四项能单独勾
  assert.equal(c.review_info.subFee, '500')
  assert.equal(c.review_info.conclusion, '同意受理')
  // 报价单+评审一次填完，两块都在
  assert.equal(c.quote!.total, 100)
  // 建单填了评审 ≠ 已受理：accepted_at 仍空，还得登记员单独点确认受理
  const back = getContract(db, c.id)!
  assert.equal(back.accepted_at, null)
  assert.equal(back.review_info.purpose, '验收监测')
})
