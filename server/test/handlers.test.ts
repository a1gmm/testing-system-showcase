import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import {
  createSample, listSamples, getSample,
  saveRecord, getRecord, getAudit, diffData,
  createContract, acceptContract, getContract, listContracts, generateSamples, nextContractId,
  reviewRecord, listRecords,
  createPlan, planFromContract, listPlans, assignPlan, markSampled,
  seedInstruments, listInstruments,
  generateReport, getReport, checkReport, issueReport, listReports,
  getProject, listProjects, sampleRollup,
  getPlanDetail, sampleIn,
} from '../src/handlers.ts'

function approvedRecord(db) {
  const s = createSample(db, { matrix: '废水' }, 2026)
  let rec = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-003', analyte: '锌', method: '原子吸收', data: { rows: [{ id: 'F-1', a: 0.06 }], meta: {}, reg: {}, resultSummary: { analyte: '锌', value: 1.2, unit: 'mg/L' } }, submit: true })
  rec = reviewRecord(db, rec.id, 'review_pass', '郑复核')
  rec = reviewRecord(db, rec.id, 'approve', '孙审核')
  return { s, rec }
}

function freshDb() { return openDb(':memory:') }

test('样品编号走盲样新规：介质码+YYMMDD-序号，按介质独立递增', () => {
  const db = freshDb()
  const a = createSample(db, { matrix: '废水', client: '甲厂' }, 2026)
  const b = createSample(db, { matrix: '废水' }, 2026)
  const t = createSample(db, { matrix: '土壤' }, 2026)
  assert.match(a.id, /^W\d{6}-1$/)
  assert.match(b.id, /^W\d{6}-2$/)
  assert.match(t.id, /^T\d{6}-1$/, '不同介质独立编号')
})

test('登记样品默认待检测，能查回', () => {
  const db = freshDb()
  const s = createSample(db, { matrix: '废水', client: '甲厂', items: ['COD', '氨氮'], note: '总排口' }, 2026)
  assert.match(s.id, /^W\d{6}-1$/)
  assert.equal(s.status, 'pending')
  assert.deepEqual(s.items, ['COD', '氨氮'])
  const got = getSample(db, s.id)!
  assert.equal(got.client, '甲厂')
  assert.deepEqual(listSamples(db, 'pending').map(x => x.id), [s.id])
})

test('保存新记录写 create 留痕，样品转检测中', () => {
  const db = freshDb()
  const s = createSample(db, { matrix: '废水' }, 2026)
  const rec = saveRecord(db, {
    sampleId: s.id, code: 'HJ-TC-003', method: '原子吸收', analyte: '锌',
    data: { rows: [{ id: 'F-1', a0: 0.004, a: 0.061 }], meta: {}, reg: { a: 0.002, b: 0.045 } },
  })
  assert.equal(rec.sample_id, s.id)
  assert.equal(rec.status, 'draft')
  // 能读回
  const got = getRecord(db, s.id, 'HJ-TC-003')!
  assert.equal(got.data.rows[0].a, 0.061)
  // 留痕有一条 create
  const audit = getAudit(db, rec.id)
  assert.equal(audit.length, 1)
  assert.equal(audit[0].action, 'create')
  // 样品自动转为检测中
  assert.equal(getSample(db, s.id)!.status, 'testing')
})

test('再次保存写 update 留痕，含字段级 diff', () => {
  const db = freshDb()
  const s = createSample(db, { matrix: '废水' }, 2026)
  saveRecord(db, {
    sampleId: s.id, code: 'HJ-TC-003',
    data: { rows: [{ id: 'F-1', a: 0.061 }], meta: {}, reg: {} },
  })
  const rec = saveRecord(db, {
    sampleId: s.id, code: 'HJ-TC-003',
    data: { rows: [{ id: 'F-1', a: 0.070 }], meta: {}, reg: {} },
  })
  const audit = getAudit(db, rec.id)
  assert.equal(audit.length, 2)             // create + update
  assert.equal(audit[0].action, 'update')   // 最新在前
  const changes = audit[0].detail.changes
  assert.equal(changes.length, 1)
  assert.deepEqual(changes[0], { row: 1, col: 'a', from: 0.061, to: 0.070 })
})

test('提交记录写 submit 留痕并锁定状态', () => {
  const db = freshDb()
  const s = createSample(db, { matrix: '废水' }, 2026)
  saveRecord(db, { sampleId: s.id, code: 'HJ-TC-003', data: { rows: [{ id: 'F-1', a: 0.06 }] } })
  const rec = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-003', data: { rows: [{ id: 'F-1', a: 0.06 }] }, submit: true })
  assert.equal(rec.status, 'submitted')
  assert.equal(getAudit(db, rec.id)[0].action, 'submit')
})

test('委托单号按年递增', () => {
  const db = freshDb()
  assert.equal(nextContractId(db, 2026), 'WT2026-0001')
  createContract(db, { client: '甲厂' }, 2026)
  assert.equal(nextContractId(db, 2026), 'WT2026-0002')
})

test('建合同带样品计划，能查回', () => {
  const db = freshDb()
  const c = createContract(db, {
    client: '山东甲厂', contact: '张工 138xxxx', project: '总排口监测',
    plan: [
      { matrix: '废水', items: ['锌', 'COD'], qty: 2 },
      { matrix: '废气', items: ['颗粒物'], qty: 1 },
    ],
  }, 2026)
  assert.equal(c.id, 'WT2026-0001')
  assert.equal(c.status, 'draft')
  assert.equal(c.plan.length, 2)
  assert.deepEqual(c.plan[0].items, ['锌', 'COD'])
  assert.equal(c.samples.length, 0)   // 还没生成
  assert.equal(listContracts(db).length, 1)
})

test('从合同一键生成样品：按数量建样品、带出检测项目、挂合同号、合同转已确认', () => {
  const db = freshDb()
  const c = createContract(db, {
    client: '山东甲厂',
    plan: [
      { matrix: '废水', items: ['锌', 'COD'], qty: 2 },
      { matrix: '废气', items: ['颗粒物'], qty: 1 },
    ],
  }, 2026)
  acceptContract(db, c.id, '周登记')                  // 受理后才能建样
  const made = generateSamples(db, c.id, 2026)
  assert.equal(made.length, 3)                       // 2 + 1
  // 废水两个样，编号连续，检测项目从合同带出，单位带出，挂了合同号
  const waters = made.filter(s => s.matrix === '废水')
  assert.match(waters[0].id, /^W\d{6}-\d+$/)
  assert.deepEqual(waters.map(s => Number(s.id.split('-')[1])), [1, 2], '同介质编号连续')
  assert.deepEqual(waters[0].items, ['锌', 'COD'])
  assert.equal(waters[0].client, '山东甲厂')
  assert.equal(waters[0].contract_id, c.id)
  assert.equal(waters[0].status, 'pending')
  // 合同转已确认，且能查到已生成样品
  const c2 = getContract(db, c.id)!
  assert.equal(c2.status, 'confirmed')
  assert.equal(c2.samples.length, 3)
  // 这些样品也进了全局待检测列表
  assert.equal(listSamples(db, 'pending').length, 3)
})

test('重复生成幂等，不会重复建样品', () => {
  const db = freshDb()
  const c = createContract(db, { client: '甲厂', plan: [{ matrix: '废水', items: ['锌'], qty: 1 }] }, 2026)
  acceptContract(db, c.id, '周登记')
  generateSamples(db, c.id, 2026)
  const again = generateSamples(db, c.id, 2026)
  assert.equal(again.length, 1)
  assert.equal(listSamples(db).length, 1)   // 仍只有一个
})

test('三级审核：提交→复核通过→审核通过，状态与人都记下', () => {
  const db = freshDb()
  const s = createSample(db, { matrix: '废水' }, 2026)
  let rec = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-003', data: { rows: [{ id: 'F-1', a: 0.06 }] }, submit: true })
  assert.equal(rec.status, 'submitted')
  rec = reviewRecord(db, rec.id, 'review_pass', '郑复核')
  assert.equal(rec.status, 'reviewed')
  assert.equal(rec.reviewer, '郑复核')
  rec = reviewRecord(db, rec.id, 'approve', '孙审核')
  assert.equal(rec.status, 'approved')
  assert.equal(rec.approver, '孙审核')
  // 留痕含 review_pass + approve
  const acts = getAudit(db, rec.id).map(a => a.action)
  assert.ok(acts.includes('review_pass') && acts.includes('approve'))
})

test('审核打回：记原因，状态 rejected；未提交不能复核', () => {
  const db = freshDb()
  const s = createSample(db, { matrix: '废水' }, 2026)
  const rec = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-003', data: { rows: [{ id: 'F-1', a: 0.06 }] } })
  // 草稿不能直接复核
  assert.throws(() => reviewRecord(db, rec.id, 'review_pass', '郑复核'), /不能执行/)
  const sub = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-003', data: { rows: [{ id: 'F-1', a: 0.06 }] }, submit: true })
  const rej = reviewRecord(db, sub.id, 'review_reject', '郑复核', '空白值异常')
  assert.equal(rej.status, 'rejected')
  assert.equal(rej.reject_reason, '空白值异常')
})

test('待复核列表按状态筛', () => {
  const db = freshDb()
  const s = createSample(db, { matrix: '废水' }, 2026)
  saveRecord(db, { sampleId: s.id, code: 'HJ-TC-003', data: { rows: [] }, submit: true })
  assert.equal(listRecords(db, { status: 'submitted' }).length, 1)
  assert.equal(listRecords(db, { status: 'approved' }).length, 0)
})

test('检测计划：从合同生成、派工、标记已采样', () => {
  const db = freshDb()
  const c = createContract(db, { client: '甲厂', plan: [{ matrix: '废水', items: ['锌'], qty: 1 }] }, 2026)
  const p = planFromContract(db, c.id, 2026)
  assert.equal(p.id, 'RW2026-0001')
  assert.equal(p.client, '甲厂')
  assert.equal(p.status, 'pending')
  const a = assignPlan(db, p.id, '赵采样', '2026-07-15')
  assert.equal(a.status, 'assigned')
  assert.equal(a.sampler, '赵采样')
  assert.equal(markSampled(db, p.id).status, 'sampled')
  assert.equal(listPlans(db).length, 1)
})

test('仪器台账：种子数据可列出', () => {
  const db = freshDb()
  seedInstruments(db)
  const list = listInstruments(db)
  assert.ok(list.length >= 6)
  assert.ok(list.find(i => i.id === 'TC-004'))
})

test('认领仪器：记录带上 instrument_id；不在台账的仪器号直接拒', () => {
  const db = freshDb()
  seedInstruments(db)   // 仪器必须真实在台账（追溯链不能挂空编号）
  const s = createSample(db, { matrix: '废水' }, 2026)
  const rec = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-003', instrumentId: 'TC-004', data: { rows: [] } })
  assert.equal(rec.instrument_id, 'TC-004')
  const s2 = createSample(db, { matrix: '废水' }, 2026)
  assert.throws(() => saveRecord(db, { sampleId: s2.id, code: 'HJ-TC-003', instrumentId: '乱写的', data: { rows: [] } }), /不在台账/)
})

test('出报告：汇总已审核通过的记录，签发盖章', () => {
  const db = freshDb()
  const { s } = approvedRecord(db)
  const rep = generateReport(db, s.id, 2026)
  assert.equal(rep.id, 'BG2026-0001')
  assert.equal(rep.status, 'draft')
  assert.equal(rep.data.results.length, 1)
  assert.equal(rep.data.results[0].analyte, '锌')
  assert.equal(rep.data.results[0].value, 1.2)
  // 报告三级：未审核不能签发
  assert.throws(() => issueReport(db, rep.id, '王授权'), /未经审核/)
  const checked = checkReport(db, rep.id, '孙审核')
  assert.equal(checked.status, 'checked')
  assert.equal(checked.checker, '孙审核')
  const issued = issueReport(db, rep.id, '王授权')
  assert.equal(issued.status, 'issued')
  assert.equal(issued.issuer, '王授权')
  assert.equal(listReports(db).length, 1)
})

test('没有审核通过的记录时不能出报告', () => {
  const db = freshDb()
  const s = createSample(db, { matrix: '废水' }, 2026)
  saveRecord(db, { sampleId: s.id, code: 'HJ-TC-003', data: { rows: [] }, submit: true })
  assert.throws(() => generateReport(db, s.id, 2026), /审核通过|未审核定稿/)
})

test('项目视图：聚合合同下的样品/进度/报告', () => {
  const db = freshDb()
  const c = createContract(db, { client: '甲厂', project: '例行监测', plan: [{ matrix: '废水', items: ['锌'], qty: 2 }] }, 2026)
  acceptContract(db, c.id, '周登记')
  generateSamples(db, c.id, 2026)
  // 一个样品录并审完，另一个还没动
  const proj0 = getProject(db, c.id)
  assert.equal(proj0.stats.samples, 2)
  assert.equal(proj0.stats.tested, 0)
  assert.equal(proj0.samples[0].rollup, 'pending')
  const sid = proj0.samples[0].id
  let rec = saveRecord(db, { sampleId: sid, code: 'HJ-TC-003', data: { rows: [{ a: 0.06 }] }, submit: true })
  rec = reviewRecord(db, rec.id, 'review_pass', '郑复核')
  rec = reviewRecord(db, rec.id, 'approve', '孙审核')
  const proj = getProject(db, c.id)
  assert.equal(proj.stats.tested, 1)
  assert.equal(proj.stats.approved, 1)
  assert.equal(proj.samples.find(s => s.id === sid)!.rollup, 'approved')
  // 列表带进度
  const list = listProjects(db)
  assert.equal(list[0].stats.approved, 1)
})

test('计划详情带出样品计划；收样入库生成样品并转已采样', () => {
  const db = freshDb()
  const c = createContract(db, { client: '甲厂', plan: [{ matrix: '废水', items: ['锌', 'COD'], qty: 2 }] }, 2026)
  acceptContract(db, c.id, '周登记')
  const p = planFromContract(db, c.id, 2026)
  const d0 = getPlanDetail(db, p.id)
  assert.equal(d0.planItems.length, 1)          // 待采清单来自合同
  assert.equal(d0.planItems[0].qty, 2)
  assert.equal(d0.samples.length, 0)            // 还没收样
  const made = sampleIn(db, p.id, 2026)
  assert.equal(made.length, 2)
  const d1 = getPlanDetail(db, p.id)
  assert.equal(d1.plan.status, 'sampled')       // 计划转已采样
  assert.equal(d1.samples.length, 2)            // 样品入库
  assert.equal(d1.samples[0].rollup, 'pending')
})

test('sampleRollup 各状态判定', () => {
  assert.equal(sampleRollup([]), 'pending')
  assert.equal(sampleRollup([{ status: 'draft' } as any]), 'testing')
  assert.equal(sampleRollup([{ status: 'submitted' } as any]), 'review')
  assert.equal(sampleRollup([{ status: 'approved' } as any]), 'approved')
})

test('diffData 检出行内改动与元数据改动', () => {
  const changes = diffData(
    { rows: [{ a: 1, b: 2 }], meta: { instrument: 'UV-1801' } },
    { rows: [{ a: 1, b: 9 }], meta: { instrument: 'UV-2000' } },
  )
  assert.deepEqual(changes, [
    { row: 1, col: 'b', from: 2, to: 9 },
    { row: 0, col: 'meta:instrument', from: 'UV-1801', to: 'UV-2000' },
  ])
})

test('diffData 检出多组分 compRows 的字段级改动，带组分名', () => {
  const changes = diffData(
    { rows: [], compRows: { 苯: [{ a: 0.112 }, { a: 0.115 }] }, meta: {} },
    { rows: [], compRows: { 苯: [{ a: 0.112 }, { a: 0.118 }] }, meta: {} },
  )
  assert.deepEqual(changes, [
    { comp: '苯', row: 2, col: 'a', from: 0.115, to: 0.118 },
  ])
})

test('diffData 多组分只报被改的那个组分，不波及其他组分', () => {
  const changes = diffData(
    { rows: [], compRows: { 苯: [{ a: 1 }], 甲苯: [{ a: 2 }], 乙苯: [{ a: 3 }] }, meta: {} },
    { rows: [], compRows: { 苯: [{ a: 1 }], 甲苯: [{ a: 9 }], 乙苯: [{ a: 3 }] }, meta: {} },
  )
  assert.deepEqual(changes, [
    { comp: '甲苯', row: 1, col: 'a', from: 2, to: 9 },
  ])
})

// data.rows 在多组分表里是「当前活动组分」那套的镜像（StructuredSheet.vue 的 bakedRows 取 activeRows）。
// 若同时对 rows 做 diff，同一次编辑会既报一条不带组分名的、又报一条带组分名的，重复且无法定位。
test('diffData 有 compRows 时忽略 rows 镜像，避免同一改动重复留痕', () => {
  const changes = diffData(
    { rows: [{ a: 0.115 }], compRows: { 苯: [{ a: 0.115 }], 甲苯: [{ a: 7 }] }, meta: {} },
    { rows: [{ a: 0.118 }], compRows: { 苯: [{ a: 0.118 }], 甲苯: [{ a: 7 }] }, meta: {} },
  )
  assert.deepEqual(changes, [
    { comp: '苯', row: 1, col: 'a', from: 0.115, to: 0.118 },
  ])
})

test('diffData 多组分表的 meta 改动仍走 row:0，不与组分留痕撞车', () => {
  const changes = diffData(
    { rows: [], compRows: { 苯: [{ a: 1 }] }, meta: { instrument: 'GC-1' } },
    { rows: [], compRows: { 苯: [{ a: 2 }] }, meta: { instrument: 'GC-2' } },
  )
  assert.deepEqual(changes, [
    { comp: '苯', row: 1, col: 'a', from: 1, to: 2 },
    { row: 0, col: 'meta:instrument', from: 'GC-1', to: 'GC-2' },
  ])
})

test('diffData 新增组分整套曲线时逐格留痕', () => {
  const changes = diffData(
    { rows: [], compRows: { 苯: [{ a: 1 }] }, meta: {} },
    { rows: [], compRows: { 苯: [{ a: 1 }], 二甲苯: [{ a: 5 }] }, meta: {} },
  )
  assert.deepEqual(changes, [
    { comp: '二甲苯', row: 1, col: 'a', from: '', to: 5 },
  ])
})

test('diffData 整个组分被移除时逐格留痕（不静默吞掉）', () => {
  const changes = diffData(
    { rows: [], compRows: { 苯: [{ a: 1 }], 二甲苯: [{ a: 5 }] }, meta: {} },
    { rows: [], compRows: { 苯: [{ a: 1 }] }, meta: {} },
  )
  assert.deepEqual(changes, [
    { comp: '二甲苯', row: 1, col: 'a', from: 5, to: '' },
  ])
})

// 单边 compRows：老记录存于本功能上线前（只有 rows），或表定义从多组分改回单组分。
// 约定：任一边有 compRows 就以 compRows 为准，rows 一律不 diff（它是派生副本，diff 它会重复报且无组分名）。
test('diffData 老记录无 compRows、新记录有：按组分逐格补痕，且不报 rows 副本', () => {
  const changes = diffData(
    { rows: [{ a: 1 }], meta: {} },
    { rows: [{ a: 2 }], compRows: { 苯: [{ a: 2 }] }, meta: {} },
  )
  assert.deepEqual(changes, [
    { comp: '苯', row: 1, col: 'a', from: '', to: 2 },
  ])
})

test('diffData 老记录有 compRows、新记录无：报组分数据被清空，且不报 rows 副本', () => {
  const changes = diffData(
    { rows: [{ a: 1 }], compRows: { 苯: [{ a: 1 }] }, meta: {} },
    { rows: [{ a: 2 }], meta: {} },
  )
  assert.deepEqual(changes, [
    { comp: '苯', row: 1, col: 'a', from: 1, to: '' },
  ])
})

// —— 校准曲线系数 reg：ρ=(A₁−a)/b×M/Vm×D，改 a/b 会改掉全表结果，必须留痕 ——
test('diffData 检出单组分表的校准曲线系数改动', () => {
  const changes = diffData(
    { rows: [], meta: {}, reg: { a: 0.002, b: 0.045 } },
    { rows: [], meta: {}, reg: { a: 0.002, b: 0.051 } },
  )
  assert.deepEqual(changes, [
    { row: 0, col: 'reg:b', from: 0.045, to: 0.051 },
  ])
})

// 多组分表的 data.reg 只存「当前活动标签页」那个组分的系数（bakedCompRows 不写 reg）。
// diff 它会导致「切标签页再保存」凭空产生一条组分间的系数变更，是误导性留痕，故不报。
test('diffData 多组分表不报 reg（它只是活动标签页的派生值，会产生误导留痕）', () => {
  const changes = diffData(
    { rows: [], compRows: { 苯: [{ a: 1 }] }, meta: {}, reg: { a: 0.002, b: 0.045 } },
    { rows: [], compRows: { 苯: [{ a: 1 }] }, meta: {}, reg: { a: 0.9, b: 0.9 } },
  )
  assert.deepEqual(changes, [])
})

// —— 曲线核查 cells：质控留痕，键形如 cc_<组分>_<项> / cc_<项> ——
test('diffData 检出曲线核查质控值改动，按组分归位', () => {
  const changes = diffData(
    { rows: [], compRows: { 苯: [{ a: 1 }] }, meta: {}, cells: { cc_苯_midMeasured: 0.5 } },
    { rows: [], compRows: { 苯: [{ a: 1 }] }, meta: {}, cells: { cc_苯_midMeasured: 0.52 } },
  )
  assert.deepEqual(changes, [
    { comp: '苯', row: 0, col: 'cell:midMeasured', from: 0.5, to: 0.52 },
  ])
})

test('diffData 单组分表的曲线核查值不带组分名', () => {
  const changes = diffData(
    { rows: [], meta: {}, cells: { cc_midStd: 1 } },
    { rows: [], meta: {}, cells: { cc_midStd: 2 } },
  )
  assert.deepEqual(changes, [
    { row: 0, col: 'cell:midStd', from: 1, to: 2 },
  ])
})

// 零浓度点测定值改成 0 是真实质控数据（应＜检出限），不能被当成「空」吞掉
test('diffData 曲线核查值改为 0 时如实留痕，不吞成空', () => {
  const changes = diffData(
    { rows: [], meta: {}, cells: { cc_zero: 0.003 } },
    { rows: [], meta: {}, cells: { cc_zero: 0 } },
  )
  assert.deepEqual(changes, [
    { row: 0, col: 'cell:zero', from: 0.003, to: 0 },
  ])
})
