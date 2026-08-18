import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import {
  createContract, createScheme, reviewScheme,
  assignRound, failRound, sampleRound, confirmRoundField, getRound, getRoundDetail, listRounds,
  qcRequirements, solidWasteMinPortions, roundQcRequirements,
  saveRoundField, listHandovers, createUser, createSample,
} from '../src/handlers.ts'

function freshDb() {
  const db = openDb(':memory:')
  // 体检39：派工名字必须是在职采样员账号
  createUser(db, { username: 'demo_sampler', name: '赵采样', roles: ['sampler'], password: 'x12345' })
  createUser(db, { username: 'wangcy', name: '王采样', roles: ['sampler'], password: 'x12345' })
  return db
}

// 帮手：建合同+方案+审批 → 排出期次，返回第一期
function makeRound(db: any, plan: { matrix: string; items: string[]; qty: number }[]) {
  const c = createContract(db, { client: '甲厂', plan }, 2026)
  createScheme(db, { contractId: c.id, cycleMonths: 0, periodStart: '2026-05-01', periodEnd: '2026-05-01' }, 2026)
  reviewScheme(db, c.id, 'approve', '许技术')
  return listRounds(db, c.id)[0]
}

// ============ S4-1 多人派工 ============

test('多人派工：传数组存顿号串，单人字符串兼容', () => {
  const db = freshDb()
  const r = makeRound(db, [{ matrix: '废水', items: ['锌'], qty: 1 }])
  const r2 = assignRound(db, r.id, ['赵采样', '王采样'], '2026-05-01')
  assert.equal(r2.sampler, '赵采样、王采样')
  // 旧接口单人字符串照样能用（改派）
  const r3 = assignRound(db, r.id, '赵采样')
  assert.equal(r3.sampler, '赵采样')
  // 空的不行
  assert.throws(() => assignRound(db, r.id, []), /采样员/)
  assert.throws(() => assignRound(db, r.id, ''), /采样员/)
})

// ============ S4-2 状态机：未派工不能标未采成/收样入库 ============

test('状态机：未派工点「采不成」报错；派工后可以', () => {
  const db = freshDb()
  const r = makeRound(db, [{ matrix: '废水', items: ['锌'], qty: 1 }])
  assert.throws(() => failRound(db, r.id, '停产'), /派工/)
  assignRound(db, r.id, ['赵采样', '王采样'])
  const r2 = failRound(db, r.id, '停产')
  assert.equal(r2.status, 'failed')
})

test('状态机：未派工不能收样入库；派工后可以', () => {
  const db = freshDb()
  const r = makeRound(db, [{ matrix: '废水', items: ['锌'], qty: 1 }])
  assert.throws(() => sampleRound(db, r.id), /派工/)
  assignRound(db, r.id, ['赵采样', '王采样'])
  const made = sampleRound(db, r.id)
  assert.ok(made.length >= 1)
  assert.equal(getRound(db, r.id)!.status, 'done')
})

// ============ S4-4 质控规则引擎 ============

test('质控规则：废水常规项→全程序空白1+现场平行≥10%（量少至少1）', () => {
  const reqs = qcRequirements([{ matrix: '废水', items: ['锌', 'COD'], qty: 3 }])
  const blank = reqs.find(q => q.qcType === '全程序空白')
  const para = reqs.find(q => q.qcType === '现场平行')
  assert.ok(blank && blank.qty === 1)
  assert.ok(para && para.qty === 1)
})

test('质控规则：现场平行按10%上取整', () => {
  const reqs = qcRequirements([{ matrix: '地表水', items: ['氨氮'], qty: 25 }])
  const para = reqs.find(q => q.qcType === '现场平行')
  assert.equal(para!.qty, 3)   // ceil(25*0.1)
})

test('质控规则：废水只测pH/电导率等豁免项→不要全程序空白', () => {
  const reqs = qcRequirements([{ matrix: '废水', items: ['pH', '电导率'], qty: 2 }])
  assert.ok(!reqs.find(q => q.qcType === '全程序空白'))
})

test('质控规则：水中VOC项目→加运输空白', () => {
  const reqs = qcRequirements([{ matrix: '废水', items: ['挥发性有机物'], qty: 2 }])
  assert.ok(reqs.find(q => q.qcType === '运输空白'))
})

test('质控规则：环境空气常规→全程序空白；非甲烷总烃→只要运输空白', () => {
  const air = qcRequirements([{ matrix: '环境空气', items: ['二氧化硫'], qty: 4 }])
  assert.ok(air.find(q => q.qcType === '全程序空白'))
  const nmhc = qcRequirements([{ matrix: '环境空气', items: ['非甲烷总烃'], qty: 4 }])
  assert.ok(!nmhc.find(q => q.qcType === '全程序空白'))
  assert.ok(nmhc.find(q => q.qcType === '运输空白'))
})

test('质控规则：臭气浓度不需要空白', () => {
  const reqs = qcRequirements([{ matrix: '废气', items: ['臭气浓度'], qty: 2 }])
  assert.equal(reqs.filter(q => q.qcType.includes('空白')).length, 0)
})

test('有组织与无组织废气沿用废气质控规则和编号前缀', () => {
  for (const matrix of ['有组织废气', '无组织废气']) {
    const reqs = qcRequirements([{ matrix, items: ['颗粒物'], qty: 1 }])
    assert.ok(reqs.some(r => r.qcType === '全程序空白' && r.matrix === matrix))
  }
  const db = freshDb()
  assert.match(createSample(db, { matrix: '有组织废气' }, 2026).id, /^Q/)
  assert.match(createSample(db, { matrix: '无组织废气' }, 2026).id, /^Q/)
})

test('有组织与无组织废气真实收样均生成 Q 编号质控样和采样交接', () => {
  for (const matrix of ['有组织废气', '无组织废气']) {
    const db = freshDb()
    const r = makeRound(db, [{ matrix, items: ['颗粒物'], qty: 1 }])
    assignRound(db, r.id, ['赵采样'])
    confirmRoundField(db, r.id, { name: '赵采样', username: 'demo_sampler' })
    const made = sampleRound(db, r.id, { name: '赵采样', username: 'demo_sampler' })
    assert.ok(made.some(s => !s.qc_type && s.matrix === matrix))
    assert.ok(made.some(s => s.qc_type === '全程序空白' && s.matrix === matrix))
    assert.ok(made.every(s => /^Q/.test(s.id)))
    for (const sample of made) {
      assert.ok(listHandovers(db, sample.id).some(h => h.action === '采样交接'))
    }
  }
})

test('质控规则：土壤→现场平行；土壤VOC→运输空白+全程序空白，平行至少2份', () => {
  const plain = qcRequirements([{ matrix: '土壤', items: ['镉'], qty: 5 }])
  assert.ok(plain.find(q => q.qcType === '现场平行'))
  assert.ok(!plain.find(q => q.qcType === '全程序空白'))
  const voc = qcRequirements([{ matrix: '土壤', items: ['挥发性有机物'], qty: 5 }])
  assert.ok(voc.find(q => q.qcType === '运输空白'))
  assert.ok(voc.find(q => q.qcType === '全程序空白'))
  assert.ok(voc.find(q => q.qcType === '现场平行')!.qty >= 2)
})

test('质控规则：海水→全程序空白+现场平行；噪声→无质控样', () => {
  const sea = qcRequirements([{ matrix: '海水', items: ['石油类'], qty: 4 }])
  assert.ok(sea.find(q => q.qcType === '全程序空白'))
  assert.ok(sea.find(q => q.qcType === '现场平行'))
  assert.equal(qcRequirements([{ matrix: '噪声', items: ['厂界噪声'], qty: 4 }]).length, 0)
})

test('roundQcRequirements：按期次items出清单', () => {
  const db = freshDb()
  const r = makeRound(db, [{ matrix: '废水', items: ['锌'], qty: 10 }])
  const reqs = roundQcRequirements(db, r.id)
  assert.ok(reqs.find(q => q.qcType === '全程序空白'))
  assert.equal(reqs.find(q => q.qcType === '现场平行')!.qty, 1)
})

test('期次详情保留计划点位，供采样表初始行预填', () => {
  const db = freshDb()
  const c = createContract(db, { client: '甲厂', plan: [{ matrix: '废水', point: '总排污口', items: ['COD'], qty: 1 }] }, 2026)
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-05-01', periodEnd: '2026-05-01',
    points: [{ element: '废水', point: '总排污口', items: ['COD'], freq: '1次', standard: 'GB8978' }],
  }, 2026)
  reviewScheme(db, c.id, 'approve', '许技术')
  const round = listRounds(db, c.id)[0]
  assert.equal(getRoundDetail(db, round.id).planItems[0].point, '总排污口')
})

// ============ S4-4 入库自动建质控样 + S4-3 自动交接记录 ============

test('收样入库：自动建质控样（带qc_type挂同期次）+ 每个样品自动生成采样交接', () => {
  const db = freshDb()
  const r = makeRound(db, [{ matrix: '废水', items: ['锌', 'COD'], qty: 3 }])
  assignRound(db, r.id, ['赵采样', '王采样'])
  // §8.3 两人采样：两名采样员都确认采样表后才能入库
  assert.throws(() => sampleRound(db, r.id, { name: '赵采样' }), /确认/)
  confirmRoundField(db, r.id, { name: '赵采样' })
  assert.throws(() => sampleRound(db, r.id, { name: '赵采样' }), /王采样.*确认/)
  confirmRoundField(db, r.id, { name: '王采样' })
  const made = sampleRound(db, r.id, { name: '赵采样' })
  const normal = made.filter((s: any) => !s.qc_type)
  const qcs = made.filter((s: any) => s.qc_type)
  assert.equal(normal.length, 3)
  assert.ok(qcs.find((s: any) => s.qc_type === '全程序空白'))
  assert.ok(qcs.find((s: any) => s.qc_type === '现场平行'))
  for (const s of qcs) assert.equal((s as any).round_id, r.id)
  // 每个样品（含质控样）都有一条「采样交接」，交接人=采样员
  for (const s of made) {
    const hs = listHandovers(db, s.id)
    assert.ok(hs.find(h => h.action === '采样交接' && h.from_person === '赵采样、王采样'))
  }
  // 幂等：再点一次不重复建
  assert.equal(sampleRound(db, r.id, { name: '赵采样' }).length, made.length)
})

// ============ S4-5 噪声专项 ============

test('噪声：不录校准值不能入库；偏差>0.5dB拦截；风速≥5m/s拦截；合规则放行', () => {
  const db = freshDb()
  const mk = () => {
    const r = makeRound(db, [{ matrix: '噪声', items: ['厂界噪声'], qty: 2 }])
    assignRound(db, r.id, ['赵采样', '王采样'])
    return r
  }
  const r1 = mk()
  assert.throws(() => sampleRound(db, r1.id), /校准/)
  saveRoundField(db, r1.id, { calBefore: 93.8, calAfter: 94.5, weather: '晴', wind: 2 })
  assert.throws(() => sampleRound(db, r1.id), /0\.5/)
  saveRoundField(db, r1.id, { calBefore: 93.8, calAfter: 94.0, weather: '', wind: 2 })
  assert.throws(() => sampleRound(db, r1.id), /气象|天气/)
  saveRoundField(db, r1.id, { calBefore: 93.8, calAfter: 94.0, weather: '晴', wind: 6 })
  assert.throws(() => sampleRound(db, r1.id), /风速/)
  saveRoundField(db, r1.id, { calBefore: 93.8, calAfter: 94.0, weather: '晴', wind: 2 })
  const made = sampleRound(db, r1.id)
  assert.equal(made.length, 2)                       // 噪声不建质控样
  assert.ok(!made.some((s: any) => s.qc_type))
})

// ============ S4-6 固废份样数 ============

test('固废份样数查表：≤5t→5 … >1000t→100（HJ 298-2019）', () => {
  assert.equal(solidWasteMinPortions(3), 5)
  assert.equal(solidWasteMinPortions(5), 5)
  assert.equal(solidWasteMinPortions(20), 8)
  assert.equal(solidWasteMinPortions(40), 13)
  assert.equal(solidWasteMinPortions(80), 20)
  assert.equal(solidWasteMinPortions(120), 32)
  assert.equal(solidWasteMinPortions(400), 50)
  assert.equal(solidWasteMinPortions(900), 80)
  assert.equal(solidWasteMinPortions(1500), 100)
})
