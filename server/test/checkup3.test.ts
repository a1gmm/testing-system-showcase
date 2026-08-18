// 2026-07-30 全自动体检修复·第三批（17条）：
// 10 交接闸指路 / 11 重批保留已填表期次 / 12 期次终止态 / 13 批量录入按项目行合并 /
// 14 样品数统一口径 / 15 合同终止态 / 16 标物试剂软删 / 21 作废报告不算已签发 /
// 26 客户电话分列 / 36 打回原因清理 / 37 failed 先改期 / 38 方案没批准拦派工收样 /
// 39 派工校验人 / 44 台账留痕 diff / 45 体系分包留痕 diff / 46 无记录样品不被 rollup 吞
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import {
  createContract, acceptContract, getContract, generateSamples, terminateContract,
  createScheme, reviewScheme, composeFreq,
  listRounds, listAllRounds, assignRound, failRound, rescheduleRound, cancelRound,
  sampleRound, confirmRoundField, saveRoundField, saveRoundSheet, getRoundSheet,
  generateRoundReport, generateContractReport, checkReport, issueReport, voidReport,
  getProjectPipeline, contractAlerts,
  createSample, saveRecord, reviewRecord, saveRecordsBatch, getRecord, getAudit, listAudit,
  quoteRowsToPlan, saveContractQuote,
  createRefMaterial, deleteRefMaterial, listRefMaterials, createReagent, deleteReagent, listReagents,
  upsertCustomer, createUser, updateUser, createInstrument,
  addSystemRecord, updateSystemRecord, addSubcontract, updateSubcontract, addAttachment,
} from '../src/handlers.ts'

function freshDb() { return openDb(':memory:') }
// 派工要真实在职账号（体检39）：给测试库配一套人
function seedCrew(db: any) {
  createUser(db, { username: 'demo_sampler', name: '赵采样', roles: ['sampler'], password: 'x12345' })
  createUser(db, { username: 'wangcy', name: '王采样', roles: ['sampler'], password: 'x12345' })
  createUser(db, { username: 'demo_tech', name: '许技术', roles: ['tech'], password: 'x12345' })
}
// 建合同+方案+批准 → 排出期次
function makeRound(db: any, opts: { period?: [string, string]; cycle?: number; perDay?: number } = {}) {
  const [ps, pe] = opts.period ?? ['2026-07-01', '2026-07-01']
  const c = createContract(db, { client: '甲厂', project: 'x', periodStart: ps, periodEnd: pe })
  acceptContract(db, c.id, '周登记')
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: ps, periodEnd: pe,
    points: [{ element: '废水', point: '1#口', items: ['COD'], freq: composeFreq(opts.perDay ?? 1, opts.cycle ?? 0), standard: '' }],
  })
  reviewScheme(db, c.id, 'approve', '许技术')
  return { c: getContract(db, c.id)!, rounds: listRounds(db, c.id) }
}
// 一条记录走完三级审核
function approveSample(db: any, sampleId: string) {
  let rec = saveRecord(db, { sampleId, code: 'HJ-TC-001', analyte: 'COD', method: 'm', data: { rows: [{ v: 1 }], resultSummary: { analyte: 'COD', value: 1, unit: 'mg/L' } }, who: '陈检测', submit: true })
  rec = reviewRecord(db, rec.id, 'review_pass', '郑复核')
  return reviewRecord(db, rec.id, 'approve', '孙审核')
}

// ============ 【10】交接闸报错能指路 ============

test('修10 交接闸：报错告诉人先记交接、再质控签收', () => {
  const db = freshDb()
  const c = createContract(db, { client: '甲' })
  const s = createSample(db, { client: '甲', matrix: '废水', items: ['COD'], contractId: c.id })
  assert.throws(
    () => saveRecord(db, { sampleId: s.id, code: 'T', data: { rows: [] }, who: '陈检测' }, { supervisor: false }),
    /先在样品页记一条交接.*质控员签收/,
  )
})

// ============ 【11】方案重批不弄丢已填表的期次 ============

test('修11 重批重排：挂现场表单的待派工期次保留原 id 只挪日期，表不丢，留痕可查', () => {
  const db = freshDb(); seedCrew(db)
  const { c } = makeRound(db, { period: ['2026-01-01', '2026-12-31'], cycle: 3 })   // 每季度 → 4 期
  let rounds = listRounds(db, c.id)
  assert.equal(rounds.length, 4)
  const keepId = rounds[1].id
  saveRoundSheet(db, keepId, 'HJ-TC-136', { rows: [{ v: '现场已填的12行' }] }, { name: '赵采样', username: 'demo_sampler' })
  // 方案改成每半年，重新提交并批准 → 触发重排
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    points: [{ element: '废水', point: '1#口', items: ['COD'], freq: composeFreq(1, 6), standard: '' }],
  })
  reviewScheme(db, c.id, 'approve', '许技术')
  rounds = listRounds(db, c.id)
  assert.equal(rounds.length, 2, '每半年 → 2 期')
  assert.ok(rounds.some(r => r.id === keepId), '挂表单的期次保留原 id 不被删')
  assert.equal(getRoundSheet(db, keepId, 'HJ-TC-136')!.data.rows[0].v, '现场已填的12行', '表单还在')
  assert.ok(listAudit(db, c.id).some(a => a.action === 'round_reschedule_keep'), '保留动作有留痕')
})

test('修11 重批重排：只挂采样单独立附件的期次也必须保留并留痕', () => {
  const db = freshDb(); seedCrew(db)
  const { c } = makeRound(db, { period: ['2026-01-01', '2026-12-31'], cycle: 3 })
  const keepId = listRounds(db, c.id)[1].id
  addAttachment(db, { entityType: 'round_sheet', entityId: `${keepId}::HJ-TC-136`, origName: '采样单现场.jpg', storedName: 'sheet-photo.jpg' }, { name: '赵采样', username: 'demo_sampler' })
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    points: [{ element: '废水', point: '1#口', items: ['COD'], freq: composeFreq(1, 6), standard: '' }],
  })
  reviewScheme(db, c.id, 'approve', '许技术')
  assert.ok(listAudit(db, c.id).some(a => a.action === 'round_reschedule_keep' && JSON.stringify(a.detail).includes(keepId)))
})

// ============ 【12】期次终止态 ============

test('修12 期次终止：failed/未派工可终止、原因必填、终态冻结一切新动作', () => {
  const db = freshDb(); seedCrew(db)
  const actor = { name: '吴质控', username: 'demo_qc' }
  const { c, rounds } = makeRound(db)
  const r = rounds[0]
  // 2026-08-01 放宽：pending 也能直接终止（企业注销在派工前就知道）——这里走 failed 老路继续验证
  assignRound(db, r.id, ['赵采样', '王采样'])
  failRound(db, r.id, '企业注销')
  assert.throws(() => cancelRound(db, r.id, '', actor), /原因/)
  const done = cancelRound(db, r.id, '企业已注销，本期不再采', actor)
  assert.equal(done.status, 'cancelled')
  assert.throws(() => cancelRound(db, r.id, '再来', actor), /已经终止/)
  // 终态冻结：派工/收样/填表/标未采成全拦
  assert.throws(() => assignRound(db, r.id, '赵采样'), /终止/)
  assert.throws(() => sampleRound(db, r.id, { name: '赵采样' }, undefined, { supervisor: true }), /终止/)
  assert.throws(() => saveRoundField(db, r.id, { weather: '晴' }), /终止/)
  assert.throws(() => failRound(db, r.id, 'x'), /终止/)
  assert.ok(listAudit(db, r.id).some(a => a.action === 'round_cancel'), '留痕 round_cancel')
  // 提醒/进度都把 cancelled 当终态
  assert.equal(listAllRounds(db).find(x => x.id === r.id)!.bucket, 'done', '不再算逾期')
  const pipe = getProjectPipeline(db, c.id)
  assert.equal(pipe.round!.no, null, '唯一一期已终止 → 主线不再有当前期')
  assert.ok(!contractAlerts(db, '2026-08-01').some(a => a.id === c.id), '期次全终态的合同不再催')
})

test('修12 合同总报告：cancelled 期次是终态，不再卡「项目未结束」', () => {
  const db = freshDb(); seedCrew(db)
  const actor = { name: '吴质控', username: 'demo_qc' }
  const { c } = makeRound(db, { period: ['2026-01-01', '2026-12-31'], cycle: 6 })   // 2 期
  const rounds = listRounds(db, c.id)
  // 第 1 期走完整流程出报告
  assignRound(db, rounds[0].id, ['赵采样', '王采样'])
  confirmRoundField(db, rounds[0].id, { name: '赵采样' })
  confirmRoundField(db, rounds[0].id, { name: '王采样' })
  const normal = sampleRound(db, rounds[0].id, { name: '赵采样' }).filter(s => !s.qc_type)
  for (const s of normal) approveSample(db, s.id)
  const rep = generateRoundReport(db, rounds[0].id, 2026)
  checkReport(db, rep.id, '孙审核')
  issueReport(db, rep.id, '王签发')
  // 第 2 期采不成 → 终止；此前总报告会报「还有 1 期未完成」
  assignRound(db, rounds[1].id, ['赵采样'])
  failRound(db, rounds[1].id, '停产')
  cancelRound(db, rounds[1].id, '客户下半年注销', actor)
  const total = generateContractReport(db, c.id, '周登记')
  assert.ok(total.id, '终止期次不再挡总报告')
})

// ============ 【13】批量录入按项目行合并 ============

test('修13 批量录入合并：只动本次项目的行，其余项目行保留；留痕记合并', () => {
  const db = freshDb()
  const s = createSample(db, { client: '甲', matrix: '废水', items: ['COD', '氨氮'] })
  saveRecordsBatch(db, { code: 'HJ-TC-030', analyte: 'COD', entries: [{ sampleId: s.id, row: { v: 10 }, resultSummary: { analyte: 'COD', value: 10, unit: 'mg/L' } }], who: '陈检测' })
  saveRecordsBatch(db, { code: 'HJ-TC-030', analyte: '氨氮', entries: [{ sampleId: s.id, row: { v: 20 } }], who: '陈检测' })
  let rec = getRecord(db, s.id, 'HJ-TC-030')!
  assert.equal(rec.data.rows.length, 2, '两个项目各占一行，第二次不覆盖第一次')
  // 更新 COD：只换 COD 那行，氨氮行原样
  saveRecordsBatch(db, { code: 'HJ-TC-030', analyte: 'COD', entries: [{ sampleId: s.id, row: { v: 11 } }], who: '陈检测' })
  rec = getRecord(db, s.id, 'HJ-TC-030')!
  assert.equal(rec.data.rows.length, 2)
  assert.equal(rec.data.rows.find((r: any) => r.analyte === 'COD')!.v, 11)
  assert.equal(rec.data.rows.find((r: any) => r.analyte === '氨氮')!.v, 20)
  assert.ok(getAudit(db, rec.id).some(a => a.action === 'batch_merge' && (a.detail?.kept ?? []).includes('氨氮')), '留痕记了保留的项目行')
  // 状态口径与单条一致：提交后批量也不能改
  saveRecordsBatch(db, { code: 'HJ-TC-030', analyte: 'COD', entries: [{ sampleId: s.id, row: { v: 12 } }], who: '陈检测', submit: true })
  assert.throws(() => saveRecordsBatch(db, { code: 'HJ-TC-030', analyte: 'COD', entries: [{ sampleId: s.id, row: { v: 13 } }], who: '陈检测' }), /提交|不能直接修改/)
})

// ============ 【14】样品数统一口径 qty = 点位数 × 每天次数 ============

test('修14 报价→计划：qty=点位数×每天次数（perDay 不再丢）', () => {
  const plan = quoteRowsToPlan([{ category: '废水', point: '排口', items: ['COD'], price: 100, points: 3, perDay: 2, perYear: 4 }])
  assert.equal(plan[0].qty, 6)
  const db = freshDb()
  const c = createContract(db, { client: 'Q' }, 2026)
  saveContractQuote(db, c.id, { rows: [{ category: '废水', point: '排口', items: ['COD'], price: 100, points: 3, perDay: 2, perYear: 4 }] })
  assert.equal(getContract(db, c.id)!.plan[0].qty, 6)
})

test('修14 方案→计划：同一公式（一行一个点位 → qty=1×每天次数）', () => {
  const db = freshDb()
  const c = createContract(db, { client: 'S', periodStart: '2026-01-01', periodEnd: '2026-12-31' }, 2026)
  createScheme(db, {
    contractId: c.id, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    points: [{ element: '废水', point: '总排口', items: ['COD'], freq: composeFreq(3, 1), standard: '' }],
  }, 2026)
  assert.equal(getContract(db, c.id)!.plan[0].qty, 3)
})

// ============ 【15】合同终止态 ============

test('修15 合同终止：draft/confirmed 都可终止、原因必填、新动作全拦、已有数据可读', () => {
  const db = freshDb(); seedCrew(db)
  const actor = { name: '周登记', username: 'demo_registrar' }
  const { c, rounds } = makeRound(db)
  // 2026-08-01 放宽：周期线合同一直是 draft，也必须能终止（原来这里会把客户注销的合同卡死）
  generateSamples(db, c.id)                                                          // → confirmed
  assert.throws(() => terminateContract(db, c.id, '', actor), /原因/)
  const t = terminateContract(db, c.id, '客户注销', actor)
  assert.equal(t.status, 'terminated')
  assert.throws(() => terminateContract(db, c.id, '再来', actor), /已经终止/)
  // 新动作全拦
  assert.throws(() => assignRound(db, rounds[0].id, '赵采样'), /已终止/)
  assert.throws(() => sampleRound(db, rounds[0].id, { name: '赵采样' }, undefined, { supervisor: true }), /已终止/)
  assert.throws(() => generateSamples(db, c.id), /已终止/)
  assert.throws(() => generateRoundReport(db, rounds[0].id, 2026), /已终止/)
  assert.throws(() => generateContractReport(db, c.id, '周登记'), /已终止/)
  // 已有数据只读不受影响 + 留痕
  assert.ok(getContract(db, c.id)!.samples.length >= 1)
  assert.ok(listAudit(db, c.id).some(a => a.action === 'contract_terminate'))
})

// ============ 【16】标物/试剂软删 ============

test('修16 标物/试剂删除=软删：列表不见、行还在库、返回整行快照供留痕', () => {
  const db = freshDb()
  createRefMaterial(db, { id: 'BW-1', name: '锌标液', batch: 'B1', expiry: '2027-01-01' })
  const snap = deleteRefMaterial(db, 'BW-1')
  assert.equal(snap.name, '锌标液')
  assert.equal(snap.batch, 'B1')
  assert.equal(listRefMaterials(db).length, 0)
  assert.equal((db.prepare(`SELECT deleted FROM ref_materials WHERE id='BW-1'`).get() as any).deleted, 1, '行没物理删')
  assert.throws(() => deleteRefMaterial(db, 'BW-1'), /不存在/)
  createReagent(db, { id: 'SJ-1', name: '硫酸' })
  assert.equal(deleteReagent(db, 'SJ-1').name, '硫酸')
  assert.equal(listReagents(db).length, 0)
  assert.throws(() => deleteReagent(db, 'SJ-1'), /不存在/)
})

// ============ 【21】作废报告不再算「已签发」 ============

test('修21 作废后：期次进度退回「待出报告」，不再和报告页打架', () => {
  const db = freshDb(); seedCrew(db)
  const { c, rounds } = makeRound(db)
  assignRound(db, rounds[0].id, ['赵采样', '王采样'])
  confirmRoundField(db, rounds[0].id, { name: '赵采样' })
  confirmRoundField(db, rounds[0].id, { name: '王采样' })
  const normal = sampleRound(db, rounds[0].id, { name: '赵采样' }).filter(s => !s.qc_type)
  for (const s of normal) approveSample(db, s.id)
  const rep = generateRoundReport(db, rounds[0].id, 2026)
  checkReport(db, rep.id, '孙审核')
  issueReport(db, rep.id, '王签发')
  assert.equal(getProjectPipeline(db, c.id).activeIndex, -1, '签发后本期完结')
  voidReport(db, rep.id, '结果有误重出', { name: '许技术', username: 'demo_tech' }, true)
  const pipe = getProjectPipeline(db, c.id)
  const reportStage = pipe.stages.find(s => s.key === 'report')!
  assert.notEqual(reportStage.status, 'done', '作废后进度条退回待出报告')
})

// ============ 【26】客户电话分列 ============

test('修26 客户档案：电话独立字段，改一半不动另一半', () => {
  const db = freshDb()
  const cu = upsertCustomer(db, { name: '甲厂', contact: '张经理', phone: '13800000000' })
  assert.equal(cu.phone, '13800000000')
  const upd = upsertCustomer(db, { name: '甲厂', phone: '13900000000' })
  assert.equal(upd.phone, '13900000000')
  assert.equal(upd.contact, '张经理')
})

// ============ 【36】打回原因清理 ============

test('修36 打回原因：rejected 时保留给复核台看，重新编辑保存那一刻清掉', () => {
  const db = freshDb()
  const s = createSample(db, { client: '甲', matrix: '废水' })
  let rec = saveRecord(db, { sampleId: s.id, code: 'T1', data: { rows: [{ v: 1 }] }, who: '陈检测', submit: true })
  rec = reviewRecord(db, rec.id, 'review_reject', '郑复核', '数据抄错了')
  assert.equal(rec.reject_reason, '数据抄错了')
  rec = saveRecord(db, { sampleId: s.id, code: 'T1', data: { rows: [{ v: 2 }] }, who: '陈检测' })
  assert.equal(rec.status, 'draft')
  assert.ok(!rec.reject_reason, '重新保存后原因不再残留')
})

// ============ 【37】failed 必须先改期才能收样 ============

test('修37 未采成期次：跳过改期直接收样被拦，改期后放行', () => {
  const db = freshDb(); seedCrew(db)
  const { rounds } = makeRound(db)
  assignRound(db, rounds[0].id, ['赵采样', '王采样'])
  failRound(db, rounds[0].id, '停产')
  assert.throws(() => sampleRound(db, rounds[0].id, { name: '赵采样' }), /先改期/)
  rescheduleRound(db, rounds[0].id, '2026-08-01')
  confirmRoundField(db, rounds[0].id, { name: '赵采样' })
  confirmRoundField(db, rounds[0].id, { name: '王采样' })
  assert.ok(sampleRound(db, rounds[0].id, { name: '赵采样' }).length >= 1)
})

// ============ 【38】方案没批准不能派工/收样 ============

test('修38 方案改回草稿期间：派工/收样都拦；没方案的老数据放行', () => {
  const db = freshDb(); seedCrew(db)
  const { c, rounds } = makeRound(db)
  assignRound(db, rounds[0].id, ['赵采样', '王采样'])   // 已批准 → 可派
  // 方案重编辑 → 回到 draft
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-07-01', periodEnd: '2026-07-01',
    points: [{ element: '废水', point: '1#口', items: ['COD', '氨氮'], freq: composeFreq(1, 0), standard: '' }],
  })
  assert.throws(() => assignRound(db, rounds[0].id, '赵采样'), /还没批准/)
  assert.throws(() => sampleRound(db, rounds[0].id, { name: '赵采样' }), /还没批准/)
  // 重新批准后恢复
  reviewScheme(db, c.id, 'approve', '许技术')
  assert.ok(assignRound(db, rounds[0].id, '赵采样').sampler)
  // 没方案的老数据（快速登记）：放行维持现状
  const c2 = createContract(db, { client: '老数据', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] })
  db.prepare(`INSERT INTO rounds (id, contract_id, round_no, due_date, items, status, created_at) VALUES ('R-OLD', ?, 1, '2026-07-01', '[]', 'pending', '2026-07-01T00:00:00Z')`).run(c2.id)
  assert.equal(assignRound(db, 'R-OLD', '赵采样').sampler, '赵采样')
})

// ============ 【39】派工校验人 ============

test('修39 派工必须是在职采样员：写错名/岗位不符/离职都拦；plan_date 清洗', () => {
  const db = freshDb(); seedCrew(db)
  createUser(db, { username: 'zl', name: '陈检测', roles: ['tester'], password: 'x12345' })
  const { rounds } = makeRound(db)
  assert.throws(() => assignRound(db, rounds[0].id, '不存在的人'), /「不存在的人」不是在职采样员/)
  assert.throws(() => assignRound(db, rounds[0].id, ['赵采样', '陈检测']), /「陈检测」不是在职采样员/)   // 检测员不许被派采样
  const ok = assignRound(db, rounds[0].id, ['赵采样', '许技术'], '2026/08/01')   // tech 兜底可采
  assert.equal(ok.sampler, '赵采样、许技术')
  assert.equal(ok.plan_date, '2026-08-01', '脏日期洗成 YYYY-MM-DD')
  assert.throws(() => assignRound(db, rounds[0].id, '赵采样', '8月1日'), /日期/)
  updateUser(db, 'wangcy', { status: 'left' })
  assert.throws(() => assignRound(db, rounds[0].id, '王采样'), /不是在职采样员/)   // 离职不许派
})

// ============ 【44】台账保存留痕：更新逐字段 diff、新建快照 ============

test('修44 仪器/标物台账：更新留痕记 from→to，新建记整行快照', () => {
  const db = freshDb()
  const actor = { name: '许技术', username: 'demo_tech' }
  createInstrument(db, { id: 'TC-1', name: 'pH计', certNo: 'JD1', certUntil: '2026-01-01' }, actor)
  createInstrument(db, { id: 'TC-1', name: 'pH计', certNo: 'JD2', certUntil: '2027-01-01' }, actor)
  const logs = listAudit(db, 'TC-1').filter(a => a.action === 'instrument_save')   // 倒序：0=更新 1=新建
  assert.equal(logs.length, 2)
  assert.ok(logs[1].detail.snapshot, '新建记快照')
  const chg = logs[0].detail.changes as any[]
  assert.ok(chg.some(x => x.col === 'cert_no' && x.from === 'JD1' && x.to === 'JD2'))
  assert.ok(chg.some(x => x.col === 'cert_until' && x.to === '2027-01-01'))
  createRefMaterial(db, { id: 'BW-1', name: '锌标液', batch: 'B1' }, actor)
  createRefMaterial(db, { id: 'BW-1', name: '锌标液', batch: 'B2' }, actor)
  const rlogs = listAudit(db, 'BW-1').filter(a => a.action === 'refmaterial_save')
  assert.ok((rlogs[0].detail.changes as any[]).some(x => x.col === 'batch' && x.from === 'B1' && x.to === 'B2'))
})

// ============ 【45】体系/分包更新留痕带 diff ============

test('修45 体系记录/分包更新：留痕记变更字段 from→to', () => {
  const db = freshDb()
  const actor = { name: '许技术', username: 'demo_tech' }
  const sr = addSystemRecord(db, { category: '内部审核', title: '2026内审' }, actor)
  updateSystemRecord(db, sr.id, { status: '已完成', result: '体系运行有效' }, actor)
  const log = listAudit(db, String(sr.id)).find(a => a.action === 'sysrecord_update')!
  assert.ok(log.detail.changes.some((x: any) => x.col === 'status' && x.from === '计划中' && x.to === '已完成'))
  assert.ok(log.detail.changes.some((x: any) => x.col === 'result' && x.to === '体系运行有效'))
  const sc = addSubcontract(db, { subcontractor: '外包实验室' }, actor)
  updateSubcontract(db, sc.id, { status: '已分包', consent: true }, actor)
  const slog = listAudit(db, String(sc.id)).find(a => a.action === 'subcontract_update')!
  assert.ok(slog.detail.changes.some((x: any) => x.col === 'status' && x.to === '已分包'))
  assert.ok(slog.detail.changes.some((x: any) => x.col === 'consent' && String(x.to) === '1'))
})

// ============ 【46】没录数据的样品不被 rollup 吞掉 ============

test('修46 期次汇总：有样品零记录 → 不能亮绿灯（全空=pending，测了一半=testing）', () => {
  const db = freshDb(); seedCrew(db)
  const { c, rounds } = makeRound(db, { perDay: 2 })   // qty=2 → 两个普通样
  assignRound(db, rounds[0].id, ['赵采样', '王采样'])
  confirmRoundField(db, rounds[0].id, { name: '赵采样' })
  confirmRoundField(db, rounds[0].id, { name: '王采样' })
  const normal = sampleRound(db, rounds[0].id, { name: '赵采样' }).filter(s => !s.qc_type)
  assert.equal(normal.length, 2)
  assert.equal(listRounds(db, c.id)[0].rollup, 'pending', '全没录 → pending')
  approveSample(db, normal[0].id)
  assert.equal(listRounds(db, c.id)[0].rollup, 'testing', '还有样品零记录 → 不能算 approved')
  approveSample(db, normal[1].id)
  assert.equal(listRounds(db, c.id)[0].rollup, 'approved', '全部走完才亮绿')
})
