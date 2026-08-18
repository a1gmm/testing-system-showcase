import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import {
  createContract, acceptContract, getContract,
  createScheme, getScheme, reviewScheme,
  createSample, saveRecord, reviewRecord, nextRecordSerial,
  planFromContract, assignPlan, sampleIn,
  generateReport, checkReport, issueReport,
  getProjectPipeline,
  listRounds, listDueRounds, sampleRound, listSamples,
  assignRound, generateRoundReport, listAllRounds, getRoundDetail, getRound,
  judgeResult, createUser,
} from '../src/handlers.ts'

// 帮手：把一个样品的记录走完 录入→提交→复核→审核
function approveSample(db: any, sampleId: string, analyte = '锌', value: number = 1.2) {
  let rec = saveRecord(db, { sampleId, code: 'HJ-TC-' + analyte, analyte, method: '方法', data: { rows: [{ id: sampleId + '-1', a: 1 }], meta: {}, reg: {}, resultSummary: { analyte, value, unit: 'mg/L' } }, submit: true })
  rec = reviewRecord(db, rec.id, 'review_pass', '郑复核')
  return reviewRecord(db, rec.id, 'approve', '孙审核')
}

function freshDb() {
  const db = openDb(':memory:')
  // 体检39：派工名字必须是在职采样员账号（写错名字期次会卡死）
  createUser(db, { username: 'demo_sampler', name: '赵采样', roles: ['sampler'], password: 'x12345' })
  createUser(db, { username: 'wangcy', name: '王采样', roles: ['sampler'], password: 'x12345' })
  return db
}

test('委托受理：确认受理后落时间与受理人', () => {
  const db = freshDb()
  const c = createContract(db, { client: '甲厂', plan: [{ matrix: '废水', items: ['锌'], qty: 1 }] }, 2026)
  assert.equal(c.accepted_at, null)
  const c2 = acceptContract(db, c.id, '周登记')
  assert.ok(c2.accepted_at)
  assert.equal(c2.accepted_by, '周登记')
  // 幂等：再次受理不改时间
  const t = c2.accepted_at
  const c3 = acceptContract(db, c.id, '别人')
  assert.equal(c3.accepted_at, t)
})

test('监测方案：一合同一方案，编制→审核通过', () => {
  const db = freshDb()
  const c = createContract(db, { client: '甲厂' }, 2026)
  const s = createScheme(db, { contractId: c.id, points: [{ element: '有组织废气', point: '排气筒', items: ['颗粒物'], freq: '1次', standard: 'DB37/2374' }] }, 2026)
  assert.equal(s.id, 'FA2026-0001')
  assert.equal(s.status, 'draft')
  assert.equal(s.points.length, 1)
  // 再次编制 = 更新同一份方案（不新建）
  const s2 = createScheme(db, { contractId: c.id, points: [{ element: '噪声', point: '厂界', items: ['昼间'], freq: '1次', standard: 'GB12348' }] }, 2026)
  assert.equal(s2.id, 'FA2026-0001')
  assert.equal(s2.points[0].element, '噪声')
  // 审核通过
  const s3 = reviewScheme(db, c.id, 'approve', '许技术')
  assert.equal(s3.status, 'approved')
  assert.equal(s3.reviewer, '许技术')
  // 已批准不能再审
  assert.throws(() => reviewScheme(db, c.id, 'approve', '许技术'))
})

test('方案打回记原因，可重编再审', () => {
  const db = freshDb()
  const c = createContract(db, { client: '乙厂' }, 2026)
  createScheme(db, { contractId: c.id }, 2026)   // 旧流程：不带 points（带空数组会被"空方案不能送审"拦）
  const r = reviewScheme(db, c.id, 'reject', '许技术', '点位不全')
  assert.equal(r.status, 'rejected')
  assert.equal(r.reject_reason, '点位不全')
  // 重新编制 → 回到待审核
  const again = createScheme(db, { contractId: c.id, points: [{ element: '废水', point: '总排口', items: ['COD'], freq: '1次', standard: 'GB8978' }] }, 2026)
  assert.equal(again.status, 'draft')
})

test('检测记录连号 JL2026-XXXX 递增', () => {
  const db = freshDb()
  assert.equal(nextRecordSerial(db, 2026), 'JL2026-0001')
  const s = createSample(db, { matrix: '废水' }, 2026)
  const rec = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-003', analyte: '锌', data: { rows: [], meta: {}, reg: {} } })
  assert.equal(rec.serial, 'JL2026-0001')
  assert.equal(nextRecordSerial(db, 2026), 'JL2026-0002')
})

test('主线状态机：随流程推进，activeIndex 逐环前移', () => {
  const db = freshDb()
  const c = createContract(db, { client: '甲厂', plan: [{ matrix: '废水', items: ['锌'], qty: 1 }] }, 2026)

  // 刚建单：卡在「委托受理」(index 0)
  let p = getProjectPipeline(db, c.id)
  assert.equal(p.activeIndex, 0)
  assert.equal(p.stages[0].key, 'accept')
  assert.equal(p.stages[0].status, 'active')

  // 受理 → 卡在「监测方案」(1)
  acceptContract(db, c.id, '周登记')
  p = getProjectPipeline(db, c.id)
  assert.equal(p.activeIndex, 1)
  assert.equal(p.stages[0].status, 'done')

  // 方案审核通过 → 卡在「采样任务」(2)
  createScheme(db, { contractId: c.id }, 2026)
  reviewScheme(db, c.id, 'approve', '许技术')
  p = getProjectPipeline(db, c.id)
  assert.equal(p.activeIndex, 2)

  // 下达采样任务+派工 → 卡在「样品建档」(3)
  const plan = planFromContract(db, c.id, 2026)
  assignPlan(db, plan.id, '赵采样', '2026-07-11')
  p = getProjectPipeline(db, c.id)
  assert.equal(p.activeIndex, 3)

  // 收样入库 → 卡在「检测记录」(4)
  const made = sampleIn(db, plan.id, 2026)
  p = getProjectPipeline(db, c.id)
  assert.equal(p.activeIndex, 4)
  assert.ok(p.stages[3].code.includes('样品'))

  // 录入提交 + 三级审核通过 → 卡在「报告签发」(6)
  let rec = saveRecord(db, { sampleId: made[0].id, code: 'HJ-TC-003', analyte: '锌', method: '原子吸收', data: { rows: [{ id: 'F-1', a: 0.06 }], meta: {}, reg: {}, resultSummary: { analyte: '锌', value: 1.2, unit: 'mg/L' } }, submit: true })
  rec = reviewRecord(db, rec.id, 'review_pass', '郑复核')
  rec = reviewRecord(db, rec.id, 'approve', '孙审核')
  p = getProjectPipeline(db, c.id)
  assert.equal(p.activeIndex, 6)
  assert.equal(p.stages[6].key, 'report')

  // 生成并签发报告 → 全部完成 activeIndex = -1
  const rep = generateReport(db, made[0].id, 2026)
  checkReport(db, rep.id, '孙审核')
  issueReport(db, rep.id, '林工程师')
  p = getProjectPipeline(db, c.id)
  assert.equal(p.activeIndex, -1)
  assert.ok(p.stages.every(s => s.status === 'done'))
})

test('监测排期：季度频次一年排出4期采样日期', () => {
  const db = freshDb()
  const c = createContract(db, { client: '甲厂', plan: [{ matrix: '废水', items: ['锌'], qty: 1 }] }, 2026)
  createScheme(db, { contractId: c.id, cycleMonths: 3, periodStart: '2026-01-15', periodEnd: '2026-12-31' }, 2026)
  // 批准即自动排期
  reviewScheme(db, c.id, 'approve', '许技术')
  const rounds = listRounds(db, c.id)
  assert.equal(rounds.length, 4)
  assert.deepEqual(rounds.map(r => r.due_date), ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15'])
  assert.equal(rounds[0].id, `${c.id}-R01`)
})

test('按项目分周期排期：废水每月+废气每季，合并期次每期只采到期项目', () => {
  const db = freshDb()
  const c = createContract(db, { client: '甲厂', plan: [
    { matrix: '废水', items: ['COD'], qty: 1, cycleMonths: 1 },   // 每月
    { matrix: '废气', items: ['颗粒物'], qty: 1, cycleMonths: 3 }, // 每季
  ] }, 2026)
  createScheme(db, { contractId: c.id, periodStart: '2026-01-10', periodEnd: '2026-03-31' }, 2026)
  reviewScheme(db, c.id, 'approve', '许技术')
  const rounds = listRounds(db, c.id)
  // 1月/2月/3月都有废水；1月还叠加废气 → 3期
  assert.deepEqual(rounds.map(r => r.due_date), ['2026-01-10', '2026-02-10', '2026-03-10'])
  const r1 = getRound(db, rounds[0].id)!
  const r2 = getRound(db, rounds[1].id)!
  // 第1期(1月)：废水+废气两项；第2期(2月)：只有废水
  assert.equal(r1.items.length, 2)
  assert.equal(r2.items.length, 1)
  assert.equal(r2.items[0].matrix, '废水')
  // 去采样只建本期到期的样品：第2期普通样只有1个废水（S4 会另建质控样）
  assignRound(db, rounds[1].id, ['赵采样', '王采样'])
  const made2 = sampleRound(db, rounds[1].id, 2026)
  const normal2 = made2.filter(s => !s.qc_type)
  assert.equal(normal2.length, 1)
  assert.equal(normal2[0].matrix, '废水')
})

test('监测排期：单次(cycle=0)只排1期', () => {
  const db = freshDb()
  const c = createContract(db, { client: '乙厂', plan: [{ matrix: '废水', items: ['锌'], qty: 1 }] }, 2026)
  createScheme(db, { contractId: c.id, cycleMonths: 0, periodStart: '2026-05-01', periodEnd: '2026-05-01' }, 2026)
  reviewScheme(db, c.id, 'approve', '许技术')
  assert.equal(listRounds(db, c.id).length, 1)
})

test('某期去采样：为这一期建一批样品(挂round_id)，期次转已采，幂等', () => {
  const db = freshDb()
  const c = createContract(db, { client: '甲厂', plan: [{ matrix: '废水', items: ['锌'], qty: 1 }, { matrix: '废气', items: ['颗粒物'], qty: 1 }] }, 2026)
  createScheme(db, { contractId: c.id, cycleMonths: 6, periodStart: '2026-01-10', periodEnd: '2026-12-31' }, 2026)
  reviewScheme(db, c.id, 'approve', '许技术')   // 2期
  const r1 = listRounds(db, c.id)[0]
  assert.equal(r1.status, 'pending')
  assert.equal(r1.sample_count, 0)
  // 第1期去采样 → 普通样2个（废水+废气），挂 round_id + contract_id；S4 另建质控样
  assignRound(db, r1.id, ['赵采样', '王采样'])
  const made = sampleRound(db, r1.id, 2026)
  const normal = made.filter(s => !s.qc_type)
  assert.equal(normal.length, 2)
  assert.equal(normal[0].round_id, r1.id)
  assert.equal(normal[0].contract_id, c.id)
  // 期次转已采、带出样品数（普通样+质控样）
  const r1b = listRounds(db, c.id)[0]
  assert.equal(r1b.status, 'done')
  assert.equal(r1b.sample_count, made.length)
  // 幂等：再采不重复建
  assert.equal(sampleRound(db, r1.id, 2026).length, made.length)
  assert.equal(listSamples(db).length, made.length)
  // 第2期还在待采、到期提醒里还有它
  assert.equal(listRounds(db, c.id)[1].status, 'pending')
  assert.ok(listDueRounds(db, '2026-08-01').some(r => r.round_no === 2))
})

test('周期项目主线按期推进：第1期报告签发后主线回到第2期，全部期完才算完成', () => {
  const db = freshDb()
  const c = createContract(db, { client: '甲厂', plan: [{ matrix: '废水', items: ['锌'], qty: 1 }] }, 2026)
  acceptContract(db, c.id, '周登记')
  createScheme(db, { contractId: c.id, cycleMonths: 6, periodStart: '2026-01-10', periodEnd: '2026-12-31' }, 2026)
  reviewScheme(db, c.id, 'approve', '许技术')   // 排出 2 期

  // 有期次后：主线卡在「采样派工」，标注第 1 期
  let p = getProjectPipeline(db, c.id)
  assert.equal(p.round?.no, 1)
  assert.equal(p.round?.total, 2)
  assert.equal(p.stages[p.activeIndex].key, 'dispatch')

  // 派工 → 收样 → 审核通过 → 出本期报告并签发
  const r1 = listRounds(db, c.id)[0]
  assignRound(db, r1.id, '赵采样', '2026-01-10')
  p = getProjectPipeline(db, c.id)
  assert.equal(p.stages[p.activeIndex].key, 'sampleIn')
  const made = sampleRound(db, r1.id, 2026)
  approveSample(db, made[0].id)
  p = getProjectPipeline(db, c.id)
  assert.equal(p.stages[p.activeIndex].key, 'report')
  const rep = generateRoundReport(db, r1.id, 2026)
  checkReport(db, rep.id, '孙审核')
  issueReport(db, rep.id, '林工程师')

  // 关键断言：第 1 期完了，主线不是「已完成」，而是回到第 2 期的派工
  p = getProjectPipeline(db, c.id)
  assert.notEqual(p.activeIndex, -1)
  assert.equal(p.round?.no, 2)
  assert.equal(p.stages[p.activeIndex].key, 'dispatch')

  // 第 2 期也走完 → 这才是真·已完成
  const r2 = listRounds(db, c.id)[1]
  assignRound(db, r2.id, '赵采样')
  const made2 = sampleRound(db, r2.id, 2026)
  approveSample(db, made2[0].id, '氨氮')
  const rep2 = generateRoundReport(db, r2.id, 2026)
  checkReport(db, rep2.id, '孙审核')
  issueReport(db, rep2.id, '林工程师')
  p = getProjectPipeline(db, c.id)
  assert.equal(p.activeIndex, -1)
  assert.equal(p.round?.no, null)
})

test('一期一报告：汇总该期全部样品；有样品没审完就报人话错', () => {
  const db = freshDb()
  const c = createContract(db, { client: '乙厂', plan: [{ matrix: '废水', items: ['锌'], qty: 2 }] }, 2026)
  createScheme(db, { contractId: c.id, cycleMonths: 0, periodStart: '2026-05-01', periodEnd: '2026-05-01' }, 2026)
  reviewScheme(db, c.id, 'approve', '许技术')
  const r = listRounds(db, c.id)[0]
  assignRound(db, r.id, ['赵采样', '王采样'])
  const made = sampleRound(db, r.id, 2026).filter(s => !s.qc_type)
  assert.equal(made.length, 2)
  // 只审完 1 个样品 → 出报告要报错并点名是谁没审完
  approveSample(db, made[0].id)
  assert.throws(() => generateRoundReport(db, r.id, 2026), new RegExp(made[1].id))
  // 全审完 → 一份报告汇总 2 个普通样（质控样不进报告）
  approveSample(db, made[1].id, '氨氮')
  const rep = generateRoundReport(db, r.id, 2026)
  assert.equal(rep.round_id, r.id)
  assert.equal(rep.data.results.length, 2)
  assert.ok(rep.title.includes('第1期'))
  const sids = rep.data.results.map((x: any) => x.sampleId)
  assert.ok(sids.includes(made[0].id) && sids.includes(made[1].id))
})

test('定稿保护：已复核/已审核的记录不能直接改，打回后才能改', () => {
  const db = freshDb()
  const s = createSample(db, { matrix: '废水' }, 2026)
  const mk = (v: number) => ({ sampleId: s.id, code: 'HJ-TC-003', analyte: '锌', method: '原子吸收', data: { rows: [{ id: 'a', a: v }], meta: {}, reg: {}, resultSummary: { analyte: '锌', value: v, unit: 'mg/L' } } })
  let rec = saveRecord(db, { ...mk(1.2), submit: true })       // submitted
  rec = reviewRecord(db, rec.id, 'review_pass', '郑复核')       // reviewed
  // 已复核：不能直接改
  assert.throws(() => saveRecord(db, mk(9.9)), /不能直接修改|打回/)
  // 打回（从已复核）→ rejected，之后可改并重新提交
  rec = reviewRecord(db, rec.id, 'reject', '孙审核', '数据存疑')
  const back = saveRecord(db, { ...mk(0.8), submit: true })
  assert.equal(back.status, 'submitted')
  // 再一路走到已审核：又不能直接改
  back && reviewRecord(db, back.id, 'review_pass', '郑复核')
  reviewRecord(db, back.id, 'approve', '孙审核')               // approved
  assert.throws(() => saveRecord(db, mk(5.5)), /不能直接修改|打回/)
})

test('一期一报告防重复：同一期不能生成两份报告', () => {
  const db = freshDb()
  const c = createContract(db, { client: '甲厂', plan: [{ matrix: '废水', items: ['锌'], qty: 1 }] }, 2026)
  createScheme(db, { contractId: c.id, cycleMonths: 0, periodStart: '2026-05-01', periodEnd: '2026-05-01' }, 2026)
  reviewScheme(db, c.id, 'approve', '许技术')
  const r = listRounds(db, c.id)[0]
  assignRound(db, r.id, ['赵采样', '王采样'])
  const made = sampleRound(db, r.id, 2026).filter(s => !s.qc_type)
  approveSample(db, made[0].id)
  generateRoundReport(db, r.id, 2026)
  // 第二次生成 → 拒绝，点名已有报告
  assert.throws(() => generateRoundReport(db, r.id, 2026), /已生成报告|重复/)
})

test('防跳步：合同未受理不能一键生成样品', () => {
  const db = freshDb()
  const c = createContract(db, { client: '甲厂', plan: [{ matrix: '废水', items: ['锌'], qty: 1 }] }, 2026)
  assert.throws(() => sampleIn(db, planFromContract(db, c.id, 2026).id, 2026), /尚未受理|未受理/)
})

test('达标判定：≤/≥/范围 三种规则', () => {
  assert.equal(judgeResult(1.3, { analyte: '锌', op: '≤', value: 2.0, unit: 'mg/L' }).verdict, '达标')
  assert.equal(judgeResult(2.6, { analyte: '锌', op: '≤', value: 2.0, unit: 'mg/L' }).verdict, '超标')
  assert.equal(judgeResult(6.5, { analyte: '溶解氧', op: '≥', value: 5, unit: 'mg/L' }).verdict, '达标')
  assert.equal(judgeResult(3, { analyte: '溶解氧', op: '≥', value: 5, unit: 'mg/L' }).verdict, '超标')
  assert.equal(judgeResult(7.2, { analyte: 'pH', op: 'range', value: 6, value2: 9, unit: '' }).verdict, '达标')
  assert.equal(judgeResult(9.8, { analyte: 'pH', op: 'range', value: 6, value2: 9, unit: '' }).verdict, '超标')
  assert.equal(judgeResult(1.3, undefined).verdict, '')        // 没限值不判
  assert.equal(judgeResult('未检出', { analyte: 'x', op: '≤', value: 1, unit: '' }).verdict, '')  // 非数值不判
  assert.equal(judgeResult(1.3, { analyte: '锌', op: '≤', value: 2.0, unit: 'mg/L' }).limitText, '≤2mg/L')
})

test('报告自动判定草稿（拍板3翻案决策15）：verdict 自动、结论按标准分组含超标句', () => {
  const db = freshDb()
  const c = createContract(db, { client: '甲厂', plan: [{ matrix: '废水', items: ['锌'], qty: 2 }] }, 2026)
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-05-01', periodEnd: '2026-05-01',
    points: [{ element: '废水', point: '总排口', items: ['锌', '铜'], freq: '每天2次', standard: 'GB8978-1996' }],  // 每天2次 → 本期2件样品（方案频次决定数量）
    limits: [{ analyte: '锌', op: '≤', value: 2.0, unit: 'mg/L' }, { analyte: '铜', op: '≤', value: 0.5, unit: 'mg/L' }],
  }, 2026)
  reviewScheme(db, c.id, 'approve', '许技术')
  const r = listRounds(db, c.id)[0]
  assignRound(db, r.id, ['赵采样', '王采样'])
  const made = sampleRound(db, r.id, 2026).filter(s => !s.qc_type)
  approveSample(db, made[0].id, '锌', 1.3)   // 达标
  approveSample(db, made[1].id, '铜', 0.9)   // 超标
  const rep = generateRoundReport(db, r.id, 2026)
  const zinc = rep.data.results.find((x: any) => x.analyte === '锌')
  const copper = rep.data.results.find((x: any) => x.analyte === '铜')
  // 拍板3：自动判定草稿（编制人仍可改结论——人工确认在 updateReport）
  assert.equal(zinc.verdict, '达标')
  assert.equal(zinc.limit, '≤2mg/L')
  assert.equal(copper.verdict, '超标')
  assert.match(rep.conclusion, /铜检测结果超出/)
  assert.match(rep.conclusion, /GB8978-1996/)
})

test('期次派工与全局期次列表', () => {
  const db = freshDb()
  const c = createContract(db, { client: '丙厂', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] }, 2026)
  createScheme(db, { contractId: c.id, cycleMonths: 6, periodStart: '2026-01-10', periodEnd: '2026-12-31' }, 2026)
  reviewScheme(db, c.id, 'approve', '许技术')
  const r = listRounds(db, c.id)[0]
  const assigned = assignRound(db, r.id, '赵采样', '2026-01-12')
  assert.equal(assigned.sampler, '赵采样')
  const all = listAllRounds(db, '2026-07-05')
  assert.equal(all.length, 2)
  assert.equal(all[0].client, '丙厂')
  assert.equal(all[0].bucket, 'overdue')
  const detail = getRoundDetail(db, r.id)
  assert.equal(detail.planItems.length, 1)
  assert.equal(detail.round.sampler, '赵采样')
})

test('到期提醒：按今天把待采期次分成 已逾期/临近/以后', () => {
  const db = freshDb()
  const c = createContract(db, { client: '丙厂', plan: [{ matrix: '废水', items: ['锌'], qty: 1 }] }, 2026)
  createScheme(db, { contractId: c.id, cycleMonths: 6, periodStart: '2026-01-10', periodEnd: '2026-12-31' }, 2026)
  reviewScheme(db, c.id, 'approve', '许技术')  // 2期：2026-01-10、2026-07-10
  const due = listDueRounds(db, '2026-07-05')   // 假设今天 7/5
  const byBucket = Object.fromEntries(due.map(r => [r.due_date, r.bucket]))
  assert.equal(byBucket['2026-01-10'], 'overdue')  // 早已过
  assert.equal(byBucket['2026-07-10'], 'soon')      // 5天后到期，14天内
})
