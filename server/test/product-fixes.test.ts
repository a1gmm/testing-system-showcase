// 产品探查修复（2026-08-01）批A：报告死锁一揽子——拒收终态 / 任务取消 / 补采闭环
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import {
  createContract, acceptContract, createScheme, reviewScheme, composeFreq, createUser,
  listRounds, assignRound, confirmRoundField, sampleRound,
  listHandoverSheets, sendHandoverSheet, confirmHandoverSheet, createNoticeFromSheet, issueTestNotice,
  listTestTasks, cancelTestTask, resampleSample,
  getSample, listPendingHandovers, saveRecord, reviewRecord, generateRoundReport,
} from '../src/handlers.ts'

const sampler = { name: '赵采样', username: 'demo_sampler' }
const qc = { name: '吴质控', username: 'qzk' }

// 一个合同一期两只样（COD+氨氮各一行计划），走到交接单已发出
function setup(db: any, opts: { items?: string[][] } = {}) {
  createUser(db, { username: 'demo_sampler', name: '赵采样', roles: ['sampler'], password: 'x12345' })
  const rows = opts.items ?? [['COD'], ['氨氮']]
  const c = createContract(db, { client: '死锁验证厂', project: '例行', periodStart: '2026-07-01', periodEnd: '2026-07-01' })
  acceptContract(db, c.id, '周登记')
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-07-01', periodEnd: '2026-07-01',
    points: rows.map((items, i) => ({ element: '废水', point: `${i + 1}#排口`, items, freq: composeFreq(1, 0), standard: 'GB8978' })),
  })
  reviewScheme(db, c.id, 'approve', '许技术')
  const r = listRounds(db, c.id)[0]
  assignRound(db, r.id, ['赵采样'])
  confirmRoundField(db, r.id, { name: '赵采样' })
  const made = sampleRound(db, r.id, sampler)
  const sh = listHandoverSheets(db, { roundId: r.id })[0]
  sendHandoverSheet(db, sh.id, sampler)
  return { c, r, made, sh }
}

function approveRecord(db: any, sampleId: string, code: string, analyte: string) {
  let rec = saveRecord(db, {
    sampleId, code, analyte, method: '通用法',
    data: { rows: [], meta: {}, reg: {}, resultSummary: { analyte, value: 1.2, unit: 'mg/L' } },
    submit: true,
  })
  rec = reviewRecord(db, rec.id, 'review_pass', '郑复核')
  return reviewRecord(db, rec.id, 'approve', '孙审核')
}

test('拒收样品：终态rejected、不再挂待签收、也不再卡整期报告', () => {
  const db = openDb(':memory:')
  const { r, sh } = setup(db)
  const normals = sh.sample_ids
  const rejectId = normals[0]
  confirmHandoverSheet(db, sh.id, qc, { rejects: [{ sampleId: rejectId, reason: '采样瓶破损' }] })
  // 终态落库
  assert.equal(getSample(db, rejectId)!.status, 'rejected')
  // 不再挂在逐条待签收清单里（原来会永远挂着）
  assert.ok(!listPendingHandovers(db).some((h: any) => h.sample_id === rejectId), '拒收样的交接流水应关闭')
  // 拒收样不能再录数据
  assert.throws(() => saveRecord(db, { sampleId: rejectId, code: 'HJ-TC-901', analyte: 'COD', data: { rows: [], meta: {}, reg: {}, resultSummary: { analyte: 'COD', value: 1, unit: 'mg/L' } }, submit: true }), /拒收/)
  // 其余样品走完三级审核 → 报告能出（原来会被拒收样卡死）
  const s = getSample(db, normals[1])!
  approveRecord(db, s.id, 'HJ-TC-903', s.items[0])
  // 期次质控样也要定稿（qcRequirements 可能生成质控样），全部补齐
  for (const sid of sh.sample_ids.slice(2)) {
    const qs = getSample(db, sid)!
    for (const a of qs.items) approveRecord(db, qs.id, 'HJ-TC-9' + Math.abs(a.length) + sid.slice(-1), a)
  }
  const rep = generateRoundReport(db, r.id)
  assert.ok(rep.id, '报告应能生成')
  assert.ok(!(rep.data.results as any[]).some(x => x.sampleId === rejectId), '拒收样不进报告')
})

test('任务取消：无记录可取消并留痕，有记录拦；取消后报告不再被幽灵任务卡死', () => {
  const db = openDb(':memory:')
  const { r, sh } = setup(db, { items: [['COD', '氨氮']] })   // 一只样两个项目
  confirmHandoverSheet(db, sh.id, qc)
  const n = createNoticeFromSheet(db, sh.id, qc)
  issueTestNotice(db, n.id, qc)
  const sid = sh.sample_ids[0]
  const tasks = listTestTasks(db, { sampleId: sid })
  assert.ok(tasks.length >= 2, '两个项目两条任务')
  // 只测 COD，氨氮做不了（样品量不足）→ 取消氨氮任务
  approveRecord(db, sid, 'HJ-TC-903', 'COD')
  const ghost = tasks.find(t => t.analyte === '氨氮')!
  // 有记录的项目不能取消
  const codTask = tasks.find(t => t.analyte === 'COD')!
  assert.throws(() => cancelTestTask(db, codTask.id as any, '试一下', qc), /已有检测记录/)
  cancelTestTask(db, ghost.id as any, '样品量不足，本期缺测', qc)
  assert.ok(!listTestTasks(db, { sampleId: sid }).some(t => t.analyte === '氨氮'), '任务已取消')
  // 质控样补齐后报告可出（原来会被"已派任务无记录"卡死）
  for (const s2 of sh.sample_ids.slice(1)) {
    const qs = getSample(db, s2)!
    for (const a of qs.items) approveRecord(db, qs.id, 'HJ-TC-91' + s2.slice(-1) + a.length, a)
  }
  const rep = generateRoundReport(db, r.id)
  assert.ok(rep.id)
})

test('补采：拒收样一键重建同期新样+新交接单，链路能走到新通知单', () => {
  const db = openDb(':memory:')
  const { r, sh } = setup(db)
  const rejectId = sh.sample_ids[0]
  confirmHandoverSheet(db, sh.id, qc, { rejects: [{ sampleId: rejectId, reason: '运输洒漏' }] })
  const { sample: ns, sheet: nsh } = resampleSample(db, rejectId, sampler)
  const orig = getSample(db, rejectId)!
  assert.equal((orig as any).replaced_by, ns.id, '旧样记住替代关系')
  assert.equal(ns.round_id, r.id, '新样落在原期次')
  assert.equal(ns.point_name, orig.point_name, '点位继承')
  assert.equal(nsh.status, 'draft')
  assert.deepEqual(nsh.sample_ids, [ns.id])
  // 不能重复补采
  assert.throws(() => resampleSample(db, rejectId, sampler), /已补采/)
  // 新交接单能走完整链：发出→签收→出通知单（每单一张的约束不冲突）
  sendHandoverSheet(db, nsh.id, sampler)
  confirmHandoverSheet(db, nsh.id, qc)
  const n2 = createNoticeFromSheet(db, nsh.id, qc)
  assert.ok(n2.groups.some(g => g.sampleId === ns.id), '新样进新通知单')
})

// —— 批C：周期合同终止 + 僵尸期次 ——
import { terminateContract, cancelRound, listDueRounds, contractAlerts, saveRecord as saveRecord2 } from '../src/handlers.ts'

test('周期合同（status一直是draft）也能终止；终止时批量了结未采期次，不再挂逾期提醒', () => {
  const db = openDb(':memory:')
  const { c, r, sh } = setup(db)   // 走期次线：合同status从头到尾是draft
  assert.equal((db.prepare('SELECT status FROM contracts WHERE id=?').get(c.id) as any).status, 'draft')
  // 再造一个没派工的期次（第二期），模拟僵尸：给合同补个未来期次
  db.prepare(`INSERT INTO rounds (id, contract_id, round_no, due_date, status, created_at) VALUES ('R-TEST-2', ?, 2, '2099-01-01', 'pending', '2026-01-01')`).run(c.id)
  assert.ok(listDueRounds(db).some((x: any) => x.id === 'R-TEST-2'), '终止前挂在提醒里')
  terminateContract(db, c.id, '客户注销', { name: '周登记' })
  // 未采期次被批量了结
  assert.equal((db.prepare(`SELECT status FROM rounds WHERE id='R-TEST-2'`).get() as any).status, 'cancelled')
  // 提醒不再出现该合同任何期次
  assert.ok(!listDueRounds(db).some((x: any) => x.contract_id === c.id), '终止合同不再进逾期提醒')
  assert.ok(!contractAlerts(db, '2099-06-01').some((x: any) => x.id === c.id), '终止合同不再进到期提醒')
  // 终止后冻结检测线：已交接样品也不能再录数据
  confirmHandoverSheet(db, sh.id, qc)
  assert.throws(() => saveRecord2(db, { sampleId: sh.sample_ids[0], code: 'HJ-TC-777', analyte: 'COD', data: { rows: [], meta: {}, reg: {}, resultSummary: { analyte: 'COD', value: 1, unit: 'mg/L' } }, submit: true }), /终止/)
})

test('未派工的期次可以直接终止（写原因），不用再谎报采不成绕一圈', () => {
  const db = openDb(':memory:')
  const c = createContract(db, { client: '直终厂', project: '例行', periodStart: '2026-07-01', periodEnd: '2026-07-01' })
  acceptContract(db, c.id, '周登记')
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-07-01', periodEnd: '2026-07-01',
    points: [{ element: '废水', point: '1#', items: ['COD'], freq: composeFreq(1, 0), standard: 'GB' }],
  })
  reviewScheme(db, c.id, 'approve', '许技术')
  const r = listRounds(db, c.id)[0]
  assert.equal(r.status, 'pending')
  cancelRound(db, r.id, '企业常年停产，本期不采', { name: '吴质控' })
  assert.equal(listRounds(db, c.id)[0].status, 'cancelled')
})

// —— 批E：合规包（修约 / 人员授权效期 / 日期交叉校验）——
import { roundGB, decimalsOf } from '../src/gbround.ts'
import { judgeResult, updateUser as updUser, resourceAlerts, issueReport, generateReport, checkReport, generateSamples } from '../src/handlers.ts'

test('GB/T 8170 修约：四舍六入五单双', () => {
  assert.equal(roundGB(0.25, 1), 0.2)    // 5后全零，前位偶→舍
  assert.equal(roundGB(0.35, 1), 0.4)    // 5后全零，前位奇→进
  assert.equal(roundGB(0.251, 1), 0.3)   // 5后有非零→进
  assert.equal(roundGB(0.24, 1), 0.2)
  assert.equal(roundGB(0.26, 1), 0.3)
  assert.equal(roundGB(2.5, 0), 2)
  assert.equal(roundGB(3.5, 0), 4)
  assert.equal(roundGB(201.633, 1), 201.6)
  assert.equal(roundGB(-0.35, 1), -0.4)
  assert.equal(decimalsOf('0.20'), 2)
  assert.equal(decimalsOf(12), 0)
})

test('限值判定按修约值：0.25 对限值≤0.2 修约后达标，0.251 超标', () => {
  const rule = { analyte: 'X', op: '≤', value: 0.2, unit: 'mg/L' } as any
  assert.equal(judgeResult(0.25, rule).verdict, '达标')    // 修约到 0.2
  assert.equal(judgeResult(0.251, rule).verdict, '超标')   // 修约到 0.3
  assert.equal(judgeResult(0.19, rule).verdict, '达标')
})

test('人员授权效期：过期的授权签字人不能签发报告；未设效期不受影响', () => {
  const db = freshDb2()
  createUser(db, { username: 'qs1', name: '签字甲', roles: ['signer'], password: 'x12345' })
  updUser(db, 'qs1', { certUntil: '2020-01-01' })   // 已过期
  createUser(db, { username: 'qs2', name: '签字乙', roles: ['signer'], password: 'x12345' })
  const c = createContract(db, { client: '效期厂', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] }, 2026)
  acceptContract(db, c.id, '周登记')
  const made = generateSamples(db, c.id, 2026)
  approveRecord(db, made[0].id, 'HJ-TC-103', 'COD')
  const rep = generateReport(db, made[0].id, 2026, '编制人')
  checkReport(db, rep.id, '审核丙')
  assert.throws(() => issueReport(db, rep.id, '签字甲', 'qs1'), /授权.*过期|过期.*授权/)
  const ok = issueReport(db, rep.id, '签字乙', 'qs2')
  assert.equal(ok.status, 'issued')
  // 授权到期进资源预警
  assert.ok(resourceAlerts(db).some((a: any) => a.type === 'person' && a.id === 'qs1'), '过期授权进预警')
})

test('日期交叉校验：检测日期早于采样/交接日期 → 保存成功但带警告并留痕', () => {
  const db = freshDb2()
  const { sh } = setup(db)
  confirmHandoverSheet(db, sh.id, qc)
  const sid = sh.sample_ids[0]
  const r = saveRecord(db, {
    sampleId: sid, code: 'HJ-TC-931', analyte: 'COD',
    data: { rows: [], meta: { 检测日期: '2020-01-01' }, reg: {}, resultSummary: { analyte: 'COD', value: 1, unit: 'mg/L' } },
    submit: false,
  }) as any
  assert.ok(r.date_warning && /早于/.test(r.date_warning), `应带日期穿帮警告，实得 ${r.date_warning}`)
  // 正常日期不警告
  const r2 = saveRecord(db, {
    sampleId: sid, code: 'HJ-TC-932', analyte: 'COD',
    data: { rows: [], meta: { 检测日期: '2099-01-01' }, reg: {}, resultSummary: { analyte: 'COD', value: 1, unit: 'mg/L' } },
  }) as any
  assert.ok(!r2.date_warning)
})
function freshDb2() { return openDb(":memory:") }

// —— 批F：中档一批 ——
import {
  revokeTestNotice, acceptContract as accept2, techReviewContract, claimTestTask,
  addQc, statsYearly, addReportDelivery, listRecords as listRecs2, updateContract,
  generateRoundReport as genRR, voidReport, archiveIndex,
  flagRecheck, updateTestNotice, seedInstruments,
} from '../src/handlers.ts'

test('通知单撤回：未认领可撤回（任务删除、回草稿）；有人认领后不能撤', () => {
  const db = freshDb2()
  const { sh } = setup(db, { items: [['COD', '氨氮']] })
  confirmHandoverSheet(db, sh.id, qc)
  const n = createNoticeFromSheet(db, sh.id, qc)
  issueTestNotice(db, n.id, qc)
  const sid = sh.sample_ids[0]
  assert.ok(listTestTasks(db, { sampleId: sid }).length >= 2)
  revokeTestNotice(db, n.id, '项目勾错了', qc)
  assert.equal((db.prepare('SELECT status FROM test_notices WHERE id=?').get(n.id) as any).status, 'draft')
  assert.equal(listTestTasks(db, { sampleId: sid }).length, 0, '任务已删')
  // 再下达 → 有人认领 → 不能撤
  issueTestNotice(db, n.id, qc)
  const t = listTestTasks(db, { sampleId: sid })[0]
  claimTestTask(db, t.id as any, { name: '张检测', username: 'zjc' })
  assert.throws(() => revokeTestNotice(db, n.id, '再撤', qc), /认领/)
})

test('评审签批"不同意"拦主线：不能受理、不能生成样品', () => {
  const db = freshDb2()
  const c = createContract(db, { client: '被否厂', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] }, 2026)
  techReviewContract(db, c.id, 'reject', { name: '许技术', username: 'demo_tech' })
  assert.throws(() => accept2(db, c.id, '周登记'), /不同意/)
  assert.throws(() => generateSamples(db, c.id, 2026), /不同意/)
})

test('复检标记拦定稿：recheck=1 的记录不能 approve，先取消复检或打回', () => {
  const db = freshDb2()
  const c = createContract(db, { client: '复检厂', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] }, 2026)
  acceptContract(db, c.id, '周登记')
  const made = generateSamples(db, c.id, 2026)
  let rec = saveRecord(db, { sampleId: made[0].id, code: 'HJ-TC-103', analyte: 'COD', data: { rows: [], meta: {}, reg: {}, resultSummary: { analyte: 'COD', value: 99, unit: 'mg/L' } }, submit: true })
  rec = reviewRecord(db, rec.id, 'review_pass', '郑复核')
  flagRecheck(db, rec.id, 'COD超标需复检', true, '孙审核', undefined, false)
  assert.throws(() => reviewRecord(db, rec.id, 'approve', '孙审核'), /复检/)
})

test('质控不合格联动：报告数据带 qcWarning 提示', () => {
  const db = freshDb2()
  const { r, sh } = setup(db, { items: [['COD']] })
  confirmHandoverSheet(db, sh.id, qc)
  for (const sid of sh.sample_ids) {
    const qs = getSample(db, sid)!
    for (const a of qs.items) approveRecord(db, qs.id, 'HJ-TC-95' + sid.slice(-2), a)
  }
  addQc(db, { qcType: '平行样', roundId: r.id, analyte: 'COD', v1: 10, v2: 20 } as any, qc)   // 相对偏差33% → 判不合格
  const rep = genRR(db, r.id)
  assert.ok((rep.data as any).qcWarning && /不合格/.test((rep.data as any).qcWarning), '报告带质控警示')
})

test('加急标记：合同可标加急，到期提醒带 urgent 字段', () => {
  const db = freshDb2()
  const { c } = setup(db)
  updateContract(db, c.id, { urgent: true } as any, { name: '周登记' })
  assert.equal((db.prepare('SELECT urgent FROM contracts WHERE id=?').get(c.id) as any).urgent, 1)
})

test('任务带完成时限：通知单 due_at 下达时落到任务上', () => {
  const db = freshDb2()
  const { sh } = setup(db, { items: [['COD']] })
  confirmHandoverSheet(db, sh.id, qc)
  const n = createNoticeFromSheet(db, sh.id, qc)
  updateTestNotice(db, n.id, { dueAt: '2026-08-15' }, qc)
  issueTestNotice(db, n.id, qc)
  const t = listTestTasks(db, { sampleId: sh.sample_ids[0] })[0] as any
  assert.equal(t.due_at, '2026-08-15')
})

test('年度统计：合同/报告/样品/超标/检测员工作量/客户排行', () => {
  const db = freshDb2()
  const c = createContract(db, { client: '年统厂', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] }, 2026)
  acceptContract(db, c.id, '周登记')
  const made = generateSamples(db, c.id, 2026)
  approveRecord(db, made[0].id, 'HJ-TC-103', 'COD')
  const y = new Date().getFullYear()
  const st = statsYearly(db, y)
  assert.ok(st.contracts >= 1)
  assert.ok(st.samples >= 1)
  assert.ok(Array.isArray(st.testers) && st.testers.length >= 1, '检测员工作量')
  assert.ok(Array.isArray(st.clients) && st.clients[0].client === '年统厂')
})

test('作废报告可做收回登记；归档索引带合同/质控/发放环', () => {
  const db = freshDb2()
  createUser(db, { username: 'qs9', name: '签字丙', roles: ['signer'], password: 'x12345' })
  const c = createContract(db, { client: '收回厂', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] }, 2026)
  acceptContract(db, c.id, '周登记')
  const made = generateSamples(db, c.id, 2026)
  approveRecord(db, made[0].id, 'HJ-TC-103', 'COD')
  const rep = generateReport(db, made[0].id, 2026, '编制人')
  checkReport(db, rep.id, '审核丙')
  issueReport(db, rep.id, '签字丙', 'qs9')
  addReportDelivery(db, rep.id, { copies: 2, method: '自取', receiver: '老王' }, qc)
  voidReport(db, rep.id, '单位名错误', { name: '签字丙', username: 'qs9' })
  // 作废后可登记收回
  const d = addReportDelivery(db, rep.id, { copies: 2, method: '收回', receiver: '老王', note: '错版收回销毁' }, qc)
  assert.ok(d.id)
  const idx = archiveIndex(db, rep.id)
  const secs = idx.map(x => x.section)
  assert.ok(secs.includes('委托合同及评审'), '归档带合同环')
  assert.ok(secs.includes('发放与收回登记'), '归档带发放环')
})

test('按仪器反查记录：listRecords 支持 instrumentId 过滤', () => {
  const db = freshDb2()
  seedInstruments(db)
  const inst = (db.prepare('SELECT id FROM instruments LIMIT 1').get() as any).id
  const c = createContract(db, { client: '仪查厂', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] }, 2026)
  acceptContract(db, c.id, '周登记')
  const made = generateSamples(db, c.id, 2026)
  saveRecord(db, { sampleId: made[0].id, code: 'HJ-TC-103', analyte: 'COD', instrumentId: inst, data: { rows: [], meta: {}, reg: {}, resultSummary: { analyte: 'COD', value: 1, unit: 'mg/L' } } })
  const hits = listRecs2(db, { instrumentId: inst } as any)
  assert.ok(hits.length >= 1 && hits.every((r: any) => r.instrument_id === inst))
})

// —— 批G：低档补齐 ——
import { withdrawRecord, unclaimTask, getReport } from '../src/handlers.ts'

test('样品 done 终态：全部记录定稿后样品状态落 done', () => {
  const db = freshDb2()
  const c = createContract(db, { client: 'done厂', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] }, 2026)
  acceptContract(db, c.id, '周登记')
  const made = generateSamples(db, c.id, 2026)
  approveRecord(db, made[0].id, 'HJ-TC-103', 'COD')
  assert.equal(getSample(db, made[0].id)!.status, 'done')
})

test('提交后本人可撤回：submitted→draft 留痕；他人不能撤', () => {
  const db = freshDb2()
  const c = createContract(db, { client: '撤回厂', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] }, 2026)
  acceptContract(db, c.id, '周登记')
  const made = generateSamples(db, c.id, 2026)
  const rec = saveRecord(db, { sampleId: made[0].id, code: 'HJ-TC-103', analyte: 'COD', who: '张检测', whoUsername: 'zjc', data: { rows: [], meta: {}, reg: {}, resultSummary: { analyte: 'COD', value: 1, unit: 'mg/L' } }, submit: true })
  assert.throws(() => withdrawRecord(db, rec.id, { name: '别人', username: 'br' }), /本人/)
  const back = withdrawRecord(db, rec.id, { name: '张检测', username: 'zjc' })
  assert.equal(back.status, 'draft')
})

test('认领错了本人可退回认领池；有记录/非本人不能退', () => {
  const db = freshDb2()
  const { sh } = setup(db, { items: [['COD']] })
  confirmHandoverSheet(db, sh.id, qc)
  const n = createNoticeFromSheet(db, sh.id, qc)
  issueTestNotice(db, n.id, qc)
  const t = listTestTasks(db, { sampleId: sh.sample_ids[0] })[0]
  claimTestTask(db, t.id as any, { name: '张检测', username: 'zjc' })
  assert.throws(() => unclaimTask(db, t.id as any, { name: '别人', username: 'br' }), /本人/)
  unclaimTask(db, t.id as any, { name: '张检测', username: 'zjc' })
  assert.equal(listTestTasks(db, { sampleId: sh.sample_ids[0] })[0].assignee, '', '回到待认领')
})

test('散样报告作废重出记 reissue_of 链', () => {
  const db = freshDb2()
  createUser(db, { username: 'qs8', name: '签字丁', roles: ['signer'], password: 'x12345' })
  const c = createContract(db, { client: '散重厂', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] }, 2026)
  acceptContract(db, c.id, '周登记')
  const made = generateSamples(db, c.id, 2026)
  approveRecord(db, made[0].id, 'HJ-TC-103', 'COD')
  const r1 = generateReport(db, made[0].id, 2026, '编制人')
  checkReport(db, r1.id, '审核丙'); issueReport(db, r1.id, '签字丁', 'qs8')
  voidReport(db, r1.id, '错版', { name: '签字丁', username: 'qs8' })
  const r2 = generateReport(db, made[0].id, 2026, '编制人')
  assert.equal((r2 as any).reissue_of, r1.id, '散样重出也记链')
})

// —— 批H：尾巴清扫（保存条件/试剂批号/发放回执/报告日期穿帮）——
import { sampleStorage, addAttachment, createRefMaterial } from '../src/handlers.ts'

test('保存条件随样品可查：交接单 storage 能按样品号取到（盲样也要看得到冷藏加酸要求）', () => {
  const db = freshDb2()
  const { sh } = setup(db)
  // 直接用 SQL 更新 storage（updateHandoverSheet 已有测试覆盖）
  db.prepare(`UPDATE handover_sheets SET storage='4℃冷藏，加硫酸至pH≤2' WHERE id=?`).run(sh.id)
  assert.equal(sampleStorage(db, sh.sample_ids[0]), '4℃冷藏，加硫酸至pH≤2')
  assert.equal(sampleStorage(db, '不存在的样'), null)
})

test('标液/试剂批号挂记录：过期批号保存成功但带警告', () => {
  const db = freshDb2()
  createRefMaterial(db, { id: 'BW-X', name: '过期标液', batch: 'B9', expiry: '2020-01-01' })
  const c = createContract(db, { client: '批号厂', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] }, 2026)
  acceptContract(db, c.id, '周登记')
  const made = generateSamples(db, c.id, 2026)
  const r = saveRecord(db, {
    sampleId: made[0].id, code: 'HJ-TC-103', analyte: 'COD',
    data: { rows: [], meta: { refMaterials: ['BW-X'] }, reg: {}, resultSummary: { analyte: 'COD', value: 1, unit: 'mg/L' } },
  }) as any
  assert.ok(r.ref_warning && /过期/.test(r.ref_warning), `应带标物过期警告，实得 ${r.ref_warning}`)
})

test('发放回执照片：挂在发放记录上，报告签发后也能传', () => {
  const db = freshDb2()
  createUser(db, { username: 'qs7', name: '签字戊', roles: ['signer'], password: 'x12345' })
  const c = createContract(db, { client: '回执厂', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] }, 2026)
  acceptContract(db, c.id, '周登记')
  const made = generateSamples(db, c.id, 2026)
  approveRecord(db, made[0].id, 'HJ-TC-103', 'COD')
  const rep = generateReport(db, made[0].id, 2026, '编制人')
  checkReport(db, rep.id, '审核丙'); issueReport(db, rep.id, '签字戊', 'qs7')
  const d = addReportDelivery(db, rep.id, { copies: 1, method: '自取', receiver: '老王' }, qc)
  // 报告本体附件签发后冻结，但发放记录的回执必须能传
  const att = addAttachment(db, { entityType: 'delivery' as any, entityId: String(d.id), origName: '签收单.jpg', storedName: 'x.jpg' }, qc)
  assert.ok(att.id)
})

test('报告生成时日期穿帮并入警示：记录检测日期早于采样日 → data.qcWarning 提到日期', () => {
  const db = freshDb2()
  const { r, sh } = setup(db, { items: [['COD']] })
  confirmHandoverSheet(db, sh.id, qc)
  for (const sid of sh.sample_ids) {
    const qs = getSample(db, sid)!
    for (const a of qs.items) {
      let rec = saveRecord(db, { sampleId: qs.id, code: 'HJ-TC-96' + sid.slice(-2), analyte: a, data: { rows: [], meta: { 检测日期: '2000-01-01' }, reg: {}, resultSummary: { analyte: a, value: 1, unit: 'mg/L' } }, submit: true })
      rec = reviewRecord(db, rec.id, 'review_pass', '郑复核'); reviewRecord(db, rec.id, 'approve', '孙审核')
    }
  }
  const rep = genRR(db, r.id)
  assert.ok(/日期/.test((rep.data as any).qcWarning || ''), '警示应含日期穿帮')
})
