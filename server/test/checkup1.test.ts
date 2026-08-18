// 2026-07-30 全自动体检修复（7条）：现场记录冻结/归属/diff留痕、approved打回、报告草稿删除、
// 报价单次与排期精确铺、登录防爆破、同人校验按登录名、作废限签发本人
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import {
  createContract, acceptContract, createScheme, reviewScheme, listRounds,
  createSample, saveRecord, reviewRecord, getAudit, listAudit,
  addHandover, confirmHandover, assignTestTasks,
  saveRoundField, saveRoundSheet, getRoundSheet, confirmRoundField, sampleRound, getRound,
  generateReport, generateRoundReport, getReport, checkReport, issueReport, voidReport, deleteReport,
  createUser, login,
} from '../src/handlers.ts'

function freshDb() { return openDb(':memory:') }

// 帮手：建合同+方案+审批 → 排出一期，并派工两名采样员（含双确认可选）
function makeRound(db: any, opts: { confirm?: boolean } = {}) {
  const c = createContract(db, { client: '现场厂', project: 'x', periodStart: '2026-07-01', periodEnd: '2026-07-01', plan: [{ matrix: '废水', items: ['COD'], qty: 1, cycleMonths: 0 }] })
  acceptContract(db, c.id, '周登记')
  createScheme(db, { contractId: c.id, cycleMonths: 0, periodStart: '2026-07-01', periodEnd: '2026-07-01', points: [{ element: '废水', point: '1#口', items: ['COD'], freq: '每天1次 · 单次', standard: '' }], limits: [] })
  reviewScheme(db, c.id, 'approve', '许技术')
  const round = (db.prepare(`SELECT * FROM rounds WHERE contract_id=?`).all(c.id) as any[])[0]
  db.prepare(`UPDATE rounds SET sampler='赵采样、许技术', sampler_ids='["demo_sampler","demo_tech"]', assignment_status='active' WHERE id=?`).run(round.id)
  if (opts.confirm !== false) {
    confirmRoundField(db, round.id, { name: '赵采样', username: 'demo_sampler' })
    confirmRoundField(db, round.id, { name: '许技术', username: 'demo_tech' })
  }
  return { c, roundId: round.id as string }
}

// 帮手：一条走完三级审核的记录
function approvedRecord(db: any, opts: { authorU?: string } = {}) {
  const s = createSample(db, { client: '甲厂', matrix: '废水', items: ['COD'] }, 2026)
  let rec = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-001', analyte: 'COD', method: '重铬酸盐法', data: { rows: [{ v: 1 }], resultSummary: { analyte: 'COD', value: 12, unit: 'mg/L' } }, who: '陈检测', whoUsername: opts.authorU ?? 'demo_tester', submit: true })
  rec = reviewRecord(db, rec.id, 'review_pass', '郑复核', '', 'demo_reviewer')
  rec = reviewRecord(db, rec.id, 'approve', '孙审核', '', 'demo_approver')
  return { s, rec }
}

// ============ 【1】现场采样记录：冻结 + 归属 + diff 留痕 ============

test('修1a 冻结：期次已收样入库后，采样单和现场记录都不能再改', () => {
  const db = freshDb()
  const { roundId } = makeRound(db)
  saveRoundSheet(db, roundId, 'HJ-TC-136', { rows: [{ v: '入库前能填' }] }, { name: '赵采样', username: 'demo_sampler' })
  sampleRound(db, roundId, { name: '赵采样', username: 'demo_sampler' })
  assert.equal(getRound(db, roundId)!.status, 'done')
  assert.throws(() => saveRoundSheet(db, roundId, 'HJ-TC-136', { rows: [{ v: '想偷改' }] }, { name: '赵采样', username: 'demo_sampler' }), /冻结/)
  assert.throws(() => saveRoundField(db, roundId, { weather: '想偷改' }), /冻结/)
  // 数据没被动
  assert.equal(getRoundSheet(db, roundId, 'HJ-TC-136')!.data.rows[0].v, '入库前能填')
})

test('修1a 冻结：该期报告已签发（未作废）也拦——即便期次状态被拨回', () => {
  const db = freshDb()
  const { roundId } = makeRound(db)
  const made = sampleRound(db, roundId, { name: '赵采样', username: 'demo_sampler' })
  // 把普通样的记录走完三级审核，出期次报告并签发
  const normal = made.filter(s => !s.qc_type)
  for (const s of normal) {
    let rec = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-001', analyte: 'COD', data: { rows: [], resultSummary: { analyte: 'COD', value: 1, unit: 'mg/L' } }, who: '陈检测', submit: true })
    rec = reviewRecord(db, rec.id, 'review_pass', '郑复核')
    reviewRecord(db, rec.id, 'approve', '孙审核')
  }
  const rep = generateRoundReport(db, roundId, 2026)
  checkReport(db, rep.id, '孙审核')
  issueReport(db, rep.id, '林工程师')
  // 模拟脏数据：期次被拨回 pending，也不能借机改现场记录——报告签发即冻结
  db.prepare(`UPDATE rounds SET status='pending' WHERE id=?`).run(roundId)
  assert.throws(() => saveRoundSheet(db, roundId, 'HJ-TC-136', { rows: [] }, { name: '赵采样' }), /报告已签发.*冻结/)
  assert.throws(() => saveRoundField(db, roundId, { weather: '改' }), /报告已签发.*冻结/)
})

test('修1b 归属：非本期派工采样员不能填（tech/admin 放行）', () => {
  const db = freshDb()
  const { roundId } = makeRound(db, { confirm: false })
  // 名单外的人（哪怕有 round_field 权限）被拦
  assert.throws(() => saveRoundSheet(db, roundId, 'HJ-TC-136', { rows: [] }, { name: '老张', username: 'zhang' }, undefined, { supervisor: false }), /当前有效派工/)
  assert.throws(() => saveRoundField(db, roundId, { weather: '晴' }, { name: '老张', username: 'zhang' }, { supervisor: false }), /当前有效派工/)
  // 名单内的采样员能填
  assert.ok(saveRoundSheet(db, roundId, 'HJ-TC-136', { rows: [{ v: 1 }] }, { name: '赵采样', username: 'demo_sampler' }, undefined, { supervisor: false }))
  // supervisor（tech/admin）兜底放行
  assert.ok(saveRoundField(db, roundId, { weather: '晴' }, { name: '管理员', username: 'admin' }, { supervisor: true }))
})

test('修1c 留痕：采样单保存记逐格 diff（上限50条），现场记录只记变更字段旧值→新值', () => {
  const db = freshDb()
  const { roundId } = makeRound(db, { confirm: false })
  // —— 采样单 diff ——
  saveRoundSheet(db, roundId, 'HJ-TC-136', { rows: [{ v: 'A' }], meta: { weather: '晴' } }, { name: '赵采样', username: 'demo_sampler' })
  saveRoundSheet(db, roundId, 'HJ-TC-136', { rows: [{ v: 'B' }], meta: { weather: '雨' } }, { name: '赵采样', username: 'demo_sampler' })
  const sheetAudit = listAudit(db, roundId).filter((a: any) => a.action === 'round_sheet')
  const last = sheetAudit[0]   // DESC：最新在前
  assert.equal(last.detail.template_code, 'HJ-TC-136')
  assert.ok(last.detail.changes.some((ch: any) => ch.col === 'v' && ch.from === 'A' && ch.to === 'B'))
  assert.ok(last.detail.changes.some((ch: any) => ch.col === 'meta:weather' && ch.from === '晴' && ch.to === '雨'))
  // —— diff 条目上限 50 防膨胀 ——
  const bigRows = Array.from({ length: 60 }, (_, i) => ({ v: `新${i}` }))
  saveRoundSheet(db, roundId, 'HJ-TC-591', { rows: bigRows }, { name: '赵采样', username: 'demo_sampler' })
  const big = listAudit(db, roundId).filter((a: any) => a.action === 'round_sheet')[0]
  assert.equal(big.detail.changes.length, 50)
  assert.equal(big.detail.total, 60)
  // —— 现场记录 field diff：只记变了的字段，不塞整个 body ——
  saveRoundField(db, roundId, { weather: '晴', temp: 20 }, { name: '赵采样', username: 'demo_sampler' })
  saveRoundField(db, roundId, { weather: '雨', temp: 20 }, { name: '赵采样', username: 'demo_sampler' })
  const fieldAudit = listAudit(db, roundId).filter((a: any) => a.action === 'round_field')
  assert.deepEqual(fieldAudit[0].detail.changes, [{ field: 'weather', from: '晴', to: '雨' }])
  assert.equal(fieldAudit[0].detail.total, 1)
})

// ============ 【2】approved 记录打回通道（revoke） ============

test('修2 revoke：审核定稿的记录可带原因打回；原因必填；非 approved 不能打', () => {
  const db = freshDb()
  const { rec } = approvedRecord(db)
  assert.throws(() => reviewRecord(db, rec.id, 'revoke', '孙审核', ''), /原因必填/)
  const r = reviewRecord(db, rec.id, 'revoke', '孙审核', '数据抄录错误', 'demo_approver')
  assert.equal(r.status, 'rejected')
  assert.equal(r.reject_reason, '数据抄录错误')
  // 留痕 action = record_revoke
  assert.ok(getAudit(db, rec.id).some(a => a.action === 'record_revoke' && a.username === 'demo_approver'))
  // 已经 rejected 了，不能再 revoke
  assert.throws(() => reviewRecord(db, r.id, 'revoke', '孙审核', '再打一次'), /审核定稿/)
})

test('修2 revoke：记录已进入未作废的已签发报告 → 先作废报告才能打回', () => {
  const db = freshDb()
  const { s, rec } = approvedRecord(db)
  const rep = generateReport(db, s.id, 2026, '周登记')
  checkReport(db, rep.id, '孙审核')
  issueReport(db, rep.id, '林工程师')
  assert.throws(() => reviewRecord(db, rec.id, 'revoke', '孙审核', '发现问题'), /先作废报告/)
  voidReport(db, rep.id, '要改记录重出', { name: '林工程师', username: 'demo_admin' })
  const r = reviewRecord(db, rec.id, 'revoke', '孙审核', '发现问题')
  assert.equal(r.status, 'rejected')
})

// ============ 【3】报告草稿可删除 ============

test('修3 删报告：draft/checked 可物理删并留痕，删后同一样品能重新生成', () => {
  const db = freshDb()
  const { s } = approvedRecord(db)
  const rep = generateReport(db, s.id, 2026, '周登记')
  deleteReport(db, rep.id, { name: '周登记', username: 'demo_registrar' })
  assert.equal(getReport(db, rep.id), null)
  // 留痕记下报告号/标题/原状态
  const audit = listAudit(db, rep.id).find(a => a.action === 'report_delete')
  assert.ok(audit)
  assert.equal(audit!.detail.report_no, rep.id)
  assert.equal(audit!.detail.status, 'draft')
  assert.ok(audit!.detail.title.includes('检测报告'))
  // 查重放行：能重新生成
  const rep2 = generateReport(db, s.id, 2026, '周登记')
  assert.ok(rep2.id)
  // checked 状态也能删
  checkReport(db, rep2.id, '孙审核')
  deleteReport(db, rep2.id, { name: '周登记', username: 'demo_registrar' })
  assert.equal(getReport(db, rep2.id), null)
})

test('修3 删报告：issued / voided 不许删', () => {
  const db = freshDb()
  const { s } = approvedRecord(db)
  const rep = generateReport(db, s.id, 2026, '周登记')
  checkReport(db, rep.id, '孙审核')
  issueReport(db, rep.id, '林工程师')
  assert.throws(() => deleteReport(db, rep.id, { name: '周登记' }), /作废重出/)
  voidReport(db, rep.id, '有误', { name: '林工程师', username: 'demo_admin' })
  assert.throws(() => deleteReport(db, rep.id, { name: '周登记' }), /永久留档/)
})

// ============ 【4】报价 perYear=0 保留 + 排期一年正好 N 期 ============

test('修4 报价：每年0次（单次）不再被洗成1次；金额按1次计；全合同期只排1期', () => {
  const db = freshDb()
  const c = createContract(db, {
    client: '单次客户', periodStart: '2026-01-01', periodEnd: '2027-12-31',
    quote: { rows: [{ category: '废水', point: '总排口', items: ['COD'], price: 100, points: 2, perDay: 1, perYear: 0 }] },
  } as any, 2026)
  assert.equal(c.quote!.rows[0].perYear, 0)          // 0 保留，不被 Math.max(1,·) 洗掉
  assert.equal(c.quote!.rows[0].subtotal, 200)       // 单次按 1 次计钱：100×2×1×1
  assert.equal(c.plan[0].cycle_months, 0)
  createScheme(db, { contractId: c.id, cycleMonths: 0, periodStart: '2026-01-01', periodEnd: '2027-12-31' }, 2026)
  reviewScheme(db, c.id, 'approve', '许技术')
  const rounds = listRounds(db, c.id)
  assert.equal(rounds.length, 1)                     // 两年合同期，单次只排 1 期
  assert.equal(rounds[0].due_date, '2026-01-01')
})

test('修4 排期：5次/年 一年正好排5期、月份均匀（不再 12/5 取整漂成 6~7 期）', () => {
  const db = freshDb()
  const c = createContract(db, {
    client: '五次客户', periodStart: '2026-01-01', periodEnd: '2026-12-31',
    quote: { rows: [{ category: '废水', point: '排口', items: ['COD'], price: 100, points: 1, perDay: 1, perYear: 5 }] },
  } as any, 2026)
  createScheme(db, { contractId: c.id, cycleMonths: 0, periodStart: '2026-01-01', periodEnd: '2026-12-31' }, 2026)
  reviewScheme(db, c.id, 'approve', '许技术')
  const rounds = listRounds(db, c.id)
  assert.equal(rounds.length, 5)
  assert.deepEqual(rounds.map(r => r.due_date), ['2026-01-01', '2026-03-01', '2026-05-01', '2026-08-01', '2026-10-01'])
})

test('修4 排期：5次/年 跨两年合同 → 正好 10 期', () => {
  const db = freshDb()
  const c = createContract(db, {
    client: '两年客户', periodStart: '2026-01-01', periodEnd: '2027-12-31',
    quote: { rows: [{ category: '废水', point: '排口', items: ['COD'], price: 100, points: 1, perDay: 1, perYear: 5 }] },
  } as any, 2026)
  createScheme(db, { contractId: c.id, cycleMonths: 0, periodStart: '2026-01-01', periodEnd: '2027-12-31' }, 2026)
  reviewScheme(db, c.id, 'approve', '许技术')
  assert.equal(listRounds(db, c.id).length, 10)
})

// ============ 【5】登录防爆破 ============

test('修5 防爆破：连续错5次锁15分钟（429+剩余分钟），到期解锁，成功清零', () => {
  const db = freshDb()
  createUser(db, { username: 'bf1', name: '爆破一', roles: ['tester'], password: 'right123' })
  const t0 = Date.now()
  for (let i = 0; i < 4; i++) assert.throws(() => login(db, 'bf1', 'wrong', t0), /用户名或密码不正确/)
  // 第 5 次失败：上锁，429 + 中文提示
  assert.throws(() => login(db, 'bf1', 'wrong', t0), (e: any) => e.httpCode === 429 && /锁定/.test(e.message))
  // 锁定期内密码对也进不来，提示带剩余分钟
  assert.throws(() => login(db, 'bf1', 'right123', t0 + 60_000), (e: any) => e.httpCode === 429 && /14 分钟/.test(e.message))
  // 15 分钟后解锁，正确密码能登录
  assert.ok(login(db, 'bf1', 'right123', t0 + 15 * 60_000 + 1).token)
  // 成功已清零：再错一次只是普通失败（不是 429）
  assert.throws(() => login(db, 'bf1', 'wrong', t0 + 16 * 60_000), /用户名或密码不正确/)
})

test('修5 防爆破：成功登录清零计数，不会 4+1 凑成锁', () => {
  const db = freshDb()
  createUser(db, { username: 'bf2', name: '爆破二', roles: ['tester'], password: 'right123' })
  const t0 = Date.now()
  for (let i = 0; i < 4; i++) assert.throws(() => login(db, 'bf2', 'wrong', t0), /用户名或密码不正确/)
  assert.ok(login(db, 'bf2', 'right123', t0).token)   // 成功 → 清零
  for (let i = 0; i < 4; i++) assert.throws(() => login(db, 'bf2', 'wrong', t0), /用户名或密码不正确/)   // 又4次仍不锁
})

// ============ 【7】同人校验改用 username（缺则回退姓名） ============

test('修7 三级审核：同名不同账号不再误拦；同账号改名字绕不过', () => {
  const db = freshDb()
  const s = createSample(db, { client: 'x', matrix: '废水', items: ['COD'] }, 2026)
  // 编制人 张三(zhang1)
  const rec = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-001', analyte: 'COD', data: {}, who: '张三', whoUsername: 'zhang1', submit: true })
  // 重名的另一位张三(zhang2) 复核：登录名不同 → 放行（旧逻辑按姓名会误拦）
  const ok = reviewRecord(db, rec.id, 'review_pass', '张三', '', 'zhang2')
  assert.equal(ok.status, 'reviewed')
  // 终审：与复核人同账号（改了显示名）→ 拦
  assert.throws(() => reviewRecord(db, rec.id, 'approve', '张三改名', '', 'zhang2'), /复核人/)
  // 与编制人同账号（改了显示名）→ 拦
  assert.throws(() => reviewRecord(db, rec.id, 'approve', '李某', '', 'zhang1'), /编制人/)
  // 第三个人正常终审
  assert.equal(reviewRecord(db, rec.id, 'approve', '张三', '', 'zhang3').status, 'approved')
  // 历史数据回退：都没 username 时仍按姓名拦
  const rec2 = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-002', analyte: 'COD', data: {}, who: '老王', submit: true })
  assert.throws(() => reviewRecord(db, rec2.id, 'review_pass', '老王'), /编制人/)
})

test('修7 任务归属：重名冒充录不了；本人改过显示名照样能录', () => {
  const db = freshDb()
  const c = createContract(db, { client: '归属厂' }, 2026)
  const s = createSample(db, { client: '归属厂', matrix: '废水', items: ['COD'], contractId: c.id }, 2026)
  const h = addHandover(db, s.id, { action: '采样交接' }, { name: '赵采样', username: 'demo_sampler' })
  confirmHandover(db, h.id, { name: '吴质控', username: 'demo_qc' })
  assignTestTasks(db, s.id, [{ analyte: 'COD', assignee: '陈检测', assigneeUsername: 'demo_tester' }], { name: '吴质控', username: 'demo_qc' })
  // 名字对但登录名不对（重名冒充）→ 拦
  assert.throws(() => saveRecord(db, { sampleId: s.id, code: 'HJ-TC-001', analyte: 'COD', data: {}, who: '陈检测', whoUsername: 'imposter' }, { supervisor: false }), /没有派给你/)
  // 登录名对（哪怕改过姓名）→ 放行
  const rec = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-001', analyte: 'COD', data: {}, who: '陈检测改名', whoUsername: 'demo_tester' }, { supervisor: false })
  assert.ok(rec.id)
})

test('修7 报告三级：审核/签发同人按登录名比对，姓名重名不误拦', () => {
  const db = freshDb()
  const { s } = approvedRecord(db)
  const rep = generateReport(db, s.id, 2026, '周登记', 'demo_registrar')
  // 同账号改名当审核人 → 拦
  assert.throws(() => checkReport(db, rep.id, '张某某', 'demo_registrar'), /编制人/)
  // 重名但不同账号 → 放行（旧逻辑按姓名会误拦）
  const chk = checkReport(db, rep.id, '周登记', 'zhangdj2')
  assert.equal(chk.status, 'checked')
  // 签发人与审核人同账号 → 拦；与编制人同账号 → 拦
  assert.throws(() => issueReport(db, rep.id, '王某', 'zhangdj2'), /审核人/)
  assert.throws(() => issueReport(db, rep.id, '王某', 'demo_registrar'), /编制人/)
  assert.equal(issueReport(db, rep.id, '林工程师', 'demo_admin').status, 'issued')
})

// ============ 【18】作废报告限签发本人 ============

test('修18 作废：非签发人 403（重名也不行）；签发人本人可废；tech/admin 兜底', () => {
  const db = freshDb()
  const { s } = approvedRecord(db)
  const rep = generateReport(db, s.id, 2026, '周登记', 'demo_registrar')
  checkReport(db, rep.id, '孙审核', 'demo_approver')
  issueReport(db, rep.id, '林工程师', 'demo_admin')
  // 重名冒充签发人 → 403
  assert.throws(() => voidReport(db, rep.id, '有问题', { name: '林工程师', username: 'imposter' }),
    (e: any) => e.httpCode === 403 && /签发人本人/.test(e.message))
  // 签发人本人可废
  assert.equal(voidReport(db, rep.id, '数据有误', { name: '林工程师', username: 'demo_admin' }).voided, 1)
  // 重出一份再签发，tech/admin（supervisor）兜底可废
  const rep2 = generateReport(db, s.id, 2026, '周登记', 'demo_registrar')
  checkReport(db, rep2.id, '孙审核', 'demo_approver')
  issueReport(db, rep2.id, '林工程师', 'demo_admin')
  assert.equal(voidReport(db, rep2.id, '技术负责人纠错', { name: '许技术', username: 'demo_tech' }, true).voided, 1)
})
