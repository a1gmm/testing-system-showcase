// 批次二地基+判定引擎v1（拍板3：自动草稿+人工确认，决策15翻案）
// 地基1 公司主数据 org_profile · 地基2 限值结构化(stdName/stdNo/tableNo/level) ·
// 地基3 点位静态扩展 stack_info · 地基4 仪器检定过期警告 · 引擎：verdict草稿+结论句式库
import { test } from 'node:test'
import assert from 'node:assert'
import { openDb } from '../src/db.ts'
import {
  getOrgProfile, updateOrgProfile,
  createContract, acceptContract, createScheme, reviewScheme, getScheme, composeFreq,
  upsertPoint, listPoints,
  createSample, saveRecord, reviewRecord,
  generateReport, updateReport, buildConclusionDraft,
} from '../src/handlers.ts'

const wj = { name: '许技术', username: 'demo_tech' }

test('地基1 公司主数据：默认带示例信息，可改且留痕后读回', () => {
  const db = openDb(':memory:')
  const p = getOrgProfile(db)
  assert.ok(p.name.includes('示例'), '默认公司名')
  assert.ok(p.cma_no !== undefined, '有CMA证书号字段')
  const upd = updateOrgProfile(db, { phone: '010-55550000', address: '示例市高新区南关路7号' }, wj)
  assert.equal(upd.phone, '010-55550000')
  assert.equal(getOrgProfile(db).address, '示例市高新区南关路7号')
})

test('地基2 限值结构化：stdName/stdNo/tableNo/level 随方案存取往返不丢', () => {
  const db = openDb(':memory:')
  const c = createContract(db, { client: '限值厂', project: 'x', periodStart: '2026-07-01', periodEnd: '2026-07-01' })
  acceptContract(db, c.id, '周登记')
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-07-01', periodEnd: '2026-07-01',
    points: [{ element: '废水', point: 'A口', items: ['COD'], freq: composeFreq(1, 0), standard: 'GB 4287-2012' }],
    limits: [{ analyte: 'COD', op: '≤', value: 50, unit: 'mg/L', stdName: '纺织染整工业水污染物排放标准', stdNo: 'GB 4287-2012', tableNo: '表2', level: '' } as any],
  })
  const s = getScheme(db, c.id)!
  assert.equal((s.limits[0] as any).stdNo, 'GB 4287-2012')
  assert.equal((s.limits[0] as any).tableNo, '表2')
})

test('地基3 点位静态档案：排气筒参数 stackInfo 可存、可更新合并', () => {
  const db = openDb(':memory:')
  const c = createContract(db, { client: '点位厂', project: 'x', periodStart: '2026-07-01', periodEnd: '2026-07-01' })
  const p = upsertPoint(db, c.id, { name: '1#排气筒', matrix: '废气', stackInfo: { daCode: 'DA001', height: 15, diameter: 0.75, process: '光氧+活性炭' } } as any, wj)
  assert.equal((p as any).stack_info.daCode, 'DA001')
  assert.equal((p as any).stack_info.height, 15)
  // 再存补燃料：合并不丢旧值
  upsertPoint(db, c.id, { name: '1#排气筒', matrix: '废气', stackInfo: { fuel: '天然气' } } as any, wj)
  const got = listPoints(db, c.id)[0] as any
  assert.equal(got.stack_info.daCode, 'DA001', '旧值保留')
  assert.equal(got.stack_info.fuel, '天然气', '新值并入')
})

test('地基4 仪器检定过期：录记录选了过期仪器→只警告不拦（决策），返回带警告文案', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO instruments (id, name, model, status, cert_until) VALUES ('TC-901','老分光计','UV-1','normal','2020-01-01')`).run()
  db.prepare(`INSERT INTO instruments (id, name, model, status, cert_until) VALUES ('TC-902','新分光计','UV-2','normal','2099-01-01')`).run()
  const s = createSample(db, { matrix: '废水', items: ['COD'] })
  const r1 = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-103', analyte: 'COD', instrumentId: 'TC-901', data: { rows: [], meta: {} } })
  assert.ok((r1 as any).instrument_warning?.includes('过期'), '过期仪器要带警告')
  const s2 = createSample(db, { matrix: '废水', items: ['COD'] })
  const r2 = saveRecord(db, { sampleId: s2.id, code: 'HJ-TC-103', analyte: 'COD', instrumentId: 'TC-902', data: { rows: [], meta: {} } })
  assert.ok(!(r2 as any).instrument_warning, '在检定期内不警告')
})

test('结论句式库：单标准全符合 / 不予判定 / 多标准分组 / 超标句 / 豁免句', () => {
  const rule = (analyte: string, stdName: string, stdNo: string, tableNo: string): any =>
    ({ analyte, op: '≤', value: 50, unit: 'mg/L', stdName, stdNo, tableNo })
  // 单标准全符合
  const c1 = buildConclusionDraft(
    [{ analyte: 'COD', verdict: '达标' }, { analyte: '氨氮', verdict: '达标' }],
    [rule('COD', '纺织染整工业水污染物排放标准', 'GB 4287-2012', '表2'), rule('氨氮', '纺织染整工业水污染物排放标准', 'GB 4287-2012', '表2')])
  assert.equal(c1, '以上检测项目检测结果符合《纺织染整工业水污染物排放标准》（GB 4287-2012）表2限值要求。')
  // 无限值 → 不予判定
  assert.equal(buildConclusionDraft([{ analyte: 'COD', verdict: '' }], []), '以上检测项目检测结果不予判定。')
  // 多标准分组分号串联
  const c3 = buildConclusionDraft(
    [{ analyte: 'COD', verdict: '达标' }, { analyte: '氟化物', verdict: '达标' }],
    [rule('COD', '城镇污水处理厂污染物排放标准', 'GB 18918-2002', '表1'), rule('氟化物', '流域水污染物综合排放标准', 'DB37/3416.5-2018', '表2')])
  assert.ok(c3.includes('COD检测结果符合《城镇污水处理厂污染物排放标准》（GB 18918-2002）表1限值要求'))
  assert.ok(c3.includes('；'))
  assert.ok(c3.includes('氟化物检测结果符合《流域水污染物综合排放标准》（DB37/3416.5-2018）表2限值要求'))
  // 超标句
  const c4 = buildConclusionDraft(
    [{ analyte: 'COD', verdict: '超标' }, { analyte: '氨氮', verdict: '达标' }],
    [rule('COD', 'A标准', 'GB 1-2020', '表1'), rule('氨氮', 'A标准', 'GB 1-2020', '表1')])
  assert.ok(c4.includes('COD检测结果超出《A标准》（GB 1-2020）表1限值要求'), c4)
  // 豁免句（水温<12℃ → BOD5 不予判定）
  const c5 = buildConclusionDraft(
    [{ analyte: 'BOD5', verdict: '' }, { analyte: 'COD', verdict: '达标' }],
    [rule('COD', 'B标准', 'DB 2-2020', '表1')],
    { exemptions: [{ analyte: 'BOD5', reason: '水温低于12℃' }] })
  assert.ok(c5.startsWith('BOD5不予判定；'), c5)
  assert.ok(c5.includes('其它检测项目检测结果符合'), c5)
})

test('报告生成：verdict自动判草稿（拍板3翻案决策15），结论=引擎草稿且编制人可改', () => {
  const db = openDb(':memory:')
  const c = createContract(db, { client: '判定厂', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] })
  acceptContract(db, c.id, '周登记')
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-07-01', periodEnd: '2026-07-01',
    points: [{ element: '废水', point: 'A口', items: ['COD'], freq: composeFreq(1, 0), standard: 'GB 4287-2012' }],
    limits: [{ analyte: 'COD', op: '≤', value: 50, unit: 'mg/L', stdName: '纺织染整工业水污染物排放标准', stdNo: 'GB 4287-2012', tableNo: '表2' } as any],
  })
  reviewScheme(db, c.id, 'approve', '许技术')
  const s = createSample(db, { matrix: '废水', items: ['COD'], client: '判定厂' })
  let rec = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-103', analyte: 'COD', method: '重铬酸盐法',
    data: { rows: [], meta: {}, resultSummary: { analyte: 'COD', value: 30, unit: 'mg/L' } }, submit: true })
  rec = reviewRecord(db, rec.id, 'review_pass', '郑复核')
  rec = reviewRecord(db, rec.id, 'approve', '孙审核')
  // 样品挂上合同才能取到方案限值
  db.prepare(`UPDATE samples SET contract_id=? WHERE id=?`).run(c.id, s.id)
  const rp = generateReport(db, s.id, 2026, '周登记')
  assert.equal(rp.data.results[0].verdict, '达标', '自动判草稿')
  assert.ok(rp.data.results[0].limit.includes('50'), '限值带出')
  assert.ok(rp.conclusion.includes('符合《纺织染整工业水污染物排放标准》（GB 4287-2012）表2限值要求'), rp.conclusion)
  // 编制人可改（人工确认）
  const upd = updateReport(db, rp.id, { conclusion: '人工改过的结论。' })
  assert.equal(upd.conclusion, '人工改过的结论。')
})
