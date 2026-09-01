import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.ts'
import { loginToTestServer } from './support/http-test-server.ts'
import {
  addAttachment,
  addHandover,
  addPretreatment,
  addQc,
  confirmHandover,
  createContract,
  createSample,
  createUser,
  deleteAttachment,
  flagRecheck,
  generateContractReport,
  generateReport,
  generateRoundReport,
  listRecords,
  reviewRecord,
  sampleRollup,
  saveRecord,
  saveRecordsBatch,
  type User,
} from '../src/handlers.ts'
import { assignProjectReviewers, setUserQualifications } from '../src/qualifications.ts'
import { getWorkflowView } from '../src/workflow.ts'

function actor(username: string, name: string, roles: string[] = []): User {
  return { username, name, roles, status: 'active', created_at: '', must_change_pw: false }
}

function fixture(db = openDb(':memory:')) {
  const admin = actor('admin', '管理员', ['admin'])
  const planner = actor('planner', '计划员', ['planner'])
  const analyst = actor('analyst', '张分析', ['analyst'])
  const otherAnalyst = actor('other-analyst', '周分析', ['analyst'])
  const reviewer = actor('lab-reviewer', '郑复核')
  const approver = actor('lab-approver', '孙审核')
  const tech = actor('tech', '赵技术', ['tech'])
  const adminUser = actor('lab-admin', '陈管理', ['admin'])
  const legacyReviewer = actor('legacy-reviewer', '孙复核', ['analyst'])
  const legacyApprover = actor('legacy-approver', '钱审核', ['analyst'])
  const sampler = actor('lab-sampler', '郑采样', ['sampler'])
  const sales = actor('lab-sales', '吴登记', ['sales'])
  const reportEditor = actor('lab-report', '冯报告', ['report_editor'])
  for (const user of [analyst, otherAnalyst, reviewer, approver, tech, adminUser, legacyReviewer, legacyApprover, sampler, sales, reportEditor]) {
    createUser(db, { username: user.username, name: user.name, roles: user.roles, password: `secret-${user.username}` })
  }
  const contract = createContract(db, { client: '实验室流程厂' }, 2026)
  setUserQualifications(db, reviewer.username, ['laboratory_review'], admin)
  setUserQualifications(db, approver.username, ['laboratory_approve'], admin)
  assignProjectReviewers(db, contract.id, 'laboratory', reviewer.username, approver.username, planner)
  db.prepare(`INSERT INTO instruments (id,name,model,status,cert_until) VALUES ('LAB-001','分光计','UV-1','normal','2099-01-01')`).run()

  const makeSample = (code: string) => {
    const sample = createSample(db, { client: contract.client, matrix: '废水', items: ['COD'], contractId: contract.id })
    const handover = addHandover(db, sample.id, { action: '采样交接', fromPerson: '赵采样', toPerson: '吴质控' }, { name: '赵采样', username: 'sampler' })
    confirmHandover(db, handover.id, { name: '吴质控', username: 'quality' })
    db.prepare(`INSERT INTO test_tasks (sample_id,analyte,assignee,assignee_username,assigned_by,assigned_at)
      VALUES (?,?,?,?,?,?)`).run(sample.id, 'COD', analyst.name, analyst.username, '吴质控', '2026-08-21T00:00:00.000Z')
    return { sample, code }
  }
  return {
    db, contract, analyst, otherAnalyst, reviewer, approver, tech, adminUser,
    legacyReviewer, legacyApprover, sampler, sales, reportEditor, makeSample,
  }
}

function saveAs(
  db: ReturnType<typeof openDb>, sampleId: string, code: string, user: User,
  data: any, submit = false, supervisor = false,
) {
  return saveRecord(db, {
    sampleId, code, analyte: 'COD', method: '重铬酸盐法', matrix: '废水', instrumentId: 'LAB-001',
    data, who: user.name, whoUsername: user.username, submit,
  }, { supervisor, actor: user } as any)
}

test('only the active task-assigned analyst authors a project laboratory record and tech has no supervisor bypass', () => {
  const { db, analyst, otherAnalyst, tech, makeSample } = fixture()
  const first = makeSample('HJ-TC-501')
  const data = { rows: [{ sample: first.sample.id, absorbance: 0.12 }], resultSummary: { analyte: 'COD', value: 12, unit: 'mg/L' } }
  assert.throws(() => saveAs(db, first.sample.id, first.code, otherAnalyst, data), /检测任务.*派给|当前账号.*有效分析员/)
  assert.throws(() => saveAs(db, first.sample.id, first.code, tech, data, false, true), /分析人员|检测任务.*派给|当前有效.*分析员/)
  assert.equal(saveAs(db, first.sample.id, first.code, analyst, data).status, 'draft')

  db.prepare(`UPDATE users SET status='disabled' WHERE username=?`).run(analyst.username)
  const second = makeSample('HJ-TC-502')
  assert.throws(() => saveAs(db, second.sample.id, second.code, analyst, data), /在职|有效.*分析员/)
})

test('tech and admin privileges do not replace project author assignment or the analyst role', () => {
  const { db, analyst, tech, adminUser, makeSample } = fixture()
  const techSample = makeSample('HJ-TC-508')
  db.prepare(`UPDATE test_tasks SET assignee=?,assignee_username=? WHERE sample_id=?`)
    .run(tech.name, tech.username, techSample.sample.id)
  assert.throws(() => saveAs(db, techSample.sample.id, techSample.code, tech, { rows: [] }, false, true), /分析人员/)

  const adminSample = makeSample('HJ-TC-509')
  db.prepare(`UPDATE test_tasks SET assignee=?,assignee_username=? WHERE sample_id=?`)
    .run(adminUser.name, adminUser.username, adminSample.sample.id)
  assert.throws(() => saveAs(db, adminSample.sample.id, adminSample.code, adminUser, { rows: [] }, false, true), /分析人员/)

  const dualRoleTech = actor('dual-tech-analyst', '杨技术分析', ['tech', 'analyst'])
  createUser(db, { username: dualRoleTech.username, name: dualRoleTech.name, roles: dualRoleTech.roles, password: 'secret-dual-tech-analyst' })
  const dualSample = makeSample('HJ-TC-510')
  db.prepare(`UPDATE test_tasks SET assignee=?,assignee_username=? WHERE sample_id=?`)
    .run(dualRoleTech.name, dualRoleTech.username, dualSample.sample.id)
  assert.equal(saveAs(db, dualSample.sample.id, dualSample.code, dualRoleTech, { rows: [] }).author_username, dualRoleTech.username)
  assert.notEqual(analyst.username, dualRoleTech.username)
})

test('laboratory submission snapshots content evidence and projects assigned review state from workflow', () => {
  const { db, analyst, reviewer, approver, tech, makeSample } = fixture()
  const { sample, code } = makeSample('HJ-TC-503')
  const firstData = { rows: [{ sample: sample.id, absorbance: 0.12 }], meta: { curve: 'y=0.1x' }, resultSummary: { analyte: 'COD', value: 12, unit: 'mg/L' } }
  let record = saveAs(db, sample.id, code, analyst, firstData)
  const pretreatment = addPretreatment(db, sample.id, { method: '微波消解', reagent: 'HNO3', condition: '180℃' }, analyst)
  const qc = addQc(db, { qcType: '平行样', sampleId: sample.id, analyte: 'COD', v1: 12, v2: 12.2, unit: 'mg/L' }, analyst)
  const activeAttachment = addAttachment(db, {
    entityType: 'record', entityId: record.id, origName: '原始谱图.pdf', storedName: 'spectrum.pdf', contentHash: 'a'.repeat(64),
  }, analyst)
  const deletedAttachment = addAttachment(db, {
    entityType: 'record', entityId: record.id, origName: '误传.pdf', storedName: 'deleted.pdf', contentHash: 'b'.repeat(64),
  }, analyst)
  deleteAttachment(db, deletedAttachment.id, analyst)

  record = saveAs(db, sample.id, code, analyst, firstData, true)
  assert.equal(record.status, 'submitted')
  assert.equal(sampleRollup(listRecords(db, { sampleId: sample.id })), 'review')
  const workflow = getWorkflowView(db, 'lab_record', record.id)!
  assert.equal(workflow.status, 'pending_review')
  assert.equal(workflow.created_by, analyst.username)
  const snapshot = workflow.revisions[0].snapshot as any
  assert.equal(snapshot.contractId, workflow.contract_id)
  assert.equal(snapshot.roundId, null)
  assert.deepEqual(snapshot.record.data, firstData)
  assert.deepEqual(snapshot.instrumentIds, ['LAB-001'])
  assert.equal(snapshot.analyticalQcResults[0].id, qc.id)
  assert.equal(snapshot.analyticalQcResults[0].result, qc.result)
  assert.equal(snapshot.pretreatments[0].id, pretreatment.id)
  assert.deepEqual(snapshot.attachments, [{ id: activeAttachment.id, hash: 'a'.repeat(64) }])

  assert.throws(() => reviewRecord(db, record.id, 'review_pass', tech.name, '', tech.username), /项目指定的复核人/)
  assert.throws(() => reviewRecord(db, record.id, 'review_pass', approver.name, '', approver.username), /项目指定的复核人/)
  assert.equal(reviewRecord(db, record.id, 'review_pass', reviewer.name, '', reviewer.username).status, 'reviewed')
  assert.throws(() => reviewRecord(db, record.id, 'approve', reviewer.name, '', reviewer.username), /项目指定的审核人|复核人/)
  assert.equal(reviewRecord(db, record.id, 'approve', approver.name, '', approver.username).status, 'approved')
  assert.equal(getWorkflowView(db, 'lab_record', record.id)!.status, 'approved')
  assert.equal(sampleRollup(listRecords(db, { sampleId: sample.id })), 'approved')
})

test('single-actor acceptance completes the laboratory record only through an explicit self assignment', () => {
  const previousUsername = process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME
  const previousUntil = process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL
  process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME = 'analyst'
  process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL = '2099-12-31T23:59:59.999Z'
  try {
    const { db, contract, analyst, makeSample } = fixture()
    const adminAnalyst = { ...analyst, roles: ['admin', 'analyst'] }
    db.prepare(`UPDATE users SET roles='["admin","analyst"]' WHERE username=?`).run(analyst.username)
    setUserQualifications(db, analyst.username, ['laboratory_review', 'laboratory_approve'], adminAnalyst)
    assignProjectReviewers(db, contract.id, 'laboratory', analyst.username, analyst.username, adminAnalyst, '单人验收')
    const { sample, code } = makeSample('HJ-TC-ACCEPTANCE')

    let record = saveAs(db, sample.id, code, adminAnalyst, { rows: [{ value: 10 }] }, true)
    record = reviewRecord(db, record.id, 'review_pass', adminAnalyst.name, '', adminAnalyst.username)
    record = reviewRecord(db, record.id, 'approve', adminAnalyst.name, '', adminAnalyst.username)

    assert.equal(record.status, 'approved')
    assert.equal(getWorkflowView(db, 'lab_record', record.id)?.status, 'approved')
  } finally {
    if (previousUsername === undefined) delete process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME
    else process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME = previousUsername
    if (previousUntil === undefined) delete process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL
    else process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL = previousUntil
  }
})

test('rejection reopens evidence and resubmission creates a new immutable laboratory revision', () => {
  const { db, analyst, reviewer, approver, makeSample } = fixture()
  const { sample, code } = makeSample('HJ-TC-504')
  const firstData = { rows: [{ value: 10 }], resultSummary: { analyte: 'COD', value: 10, unit: 'mg/L' } }
  let record = saveAs(db, sample.id, code, analyst, firstData, true)
  assert.equal(reviewRecord(db, record.id, 'review_reject', reviewer.name, '平行样偏差需复核', reviewer.username).status, 'rejected')
  const secondData = { rows: [{ value: 11 }], resultSummary: { analyte: 'COD', value: 11, unit: 'mg/L' } }
  record = saveAs(db, sample.id, code, analyst, secondData, true)
  const workflow = getWorkflowView(db, 'lab_record', record.id)!
  assert.equal(workflow.current_revision, 2)
  assert.deepEqual(workflow.revisions.map(revision => (revision.snapshot as any).record.data), [firstData, secondData])
  assert.deepEqual(workflow.revisions.map(revision => revision.submitted_by), [analyst.username, analyst.username])
  assert.deepEqual(workflow.decisions.map(decision => [decision.revision, decision.decided_by, decision.decision]), [
    [1, reviewer.username, 'reject'],
  ])
  reviewRecord(db, record.id, 'review_pass', reviewer.name, '', reviewer.username)
  reviewRecord(db, record.id, 'approve', approver.name, '', approver.username)
  assert.equal(getWorkflowView(db, 'lab_record', record.id)!.current_revision, 2)
})

test('current reassignment is enforced while immutable same-revision separation survives assignment changes', () => {
  const { db, contract, analyst, reviewer, approver, makeSample } = fixture()
  const admin = actor('admin', '管理员', ['admin'])
  const planner = actor('planner', '计划员', ['planner'])
  const reviewer2 = actor('lab-reviewer-2', '新复核')
  const approver2 = actor('lab-approver-2', '新审核')
  for (const user of [reviewer2, approver2]) {
    createUser(db, { username: user.username, name: user.name, roles: [], password: `secret-${user.username}` })
  }
  setUserQualifications(db, reviewer2.username, ['laboratory_review', 'laboratory_approve'], admin)
  setUserQualifications(db, approver2.username, ['laboratory_approve'], admin)
  setUserQualifications(db, analyst.username, ['laboratory_approve'], admin)
  const { sample, code } = makeSample('HJ-TC-511')
  const record = saveAs(db, sample.id, code, analyst, { rows: [{ value: 10 }] }, true)

  assignProjectReviewers(db, contract.id, 'laboratory', reviewer2.username, approver2.username, planner, '审核人员换班')
  assert.throws(() => reviewRecord(db, record.id, 'review_pass', reviewer.name, '', reviewer.username), /项目指定的复核人/)
  assert.equal(reviewRecord(db, record.id, 'review_pass', reviewer2.name, '', reviewer2.username).status, 'reviewed')

  assignProjectReviewers(db, contract.id, 'laboratory', reviewer.username, reviewer2.username, planner, '复核人转任审核人')
  assert.throws(() => reviewRecord(db, record.id, 'approve', reviewer2.name, '', reviewer2.username), /复核人与审核人必须不同/)

  assignProjectReviewers(db, contract.id, 'laboratory', reviewer.username, analyst.username, planner, '编制人被误指定为审核人')
  assert.throws(() => reviewRecord(db, record.id, 'approve', analyst.name, '', analyst.username), /编制人与复核人和审核人必须不同/)

  assignProjectReviewers(db, contract.id, 'laboratory', reviewer.username, approver2.username, planner, '恢复三人分离')
  assert.equal(reviewRecord(db, record.id, 'approve', approver2.name, '', approver2.username).status, 'approved')
  assert.deepEqual(getWorkflowView(db, 'lab_record', record.id)!.decisions.map(decision => decision.decided_by), [reviewer2.username, approver2.username])
})

test('tech and admin decision actors need current assignment and qualification despite privileged roles', () => {
  const { db, contract, analyst, approver, tech, adminUser, makeSample } = fixture()
  const admin = actor('admin', '管理员', ['admin'])
  const planner = actor('planner', '计划员', ['planner'])
  const { sample, code } = makeSample('HJ-TC-512')
  const record = saveAs(db, sample.id, code, analyst, { rows: [{ value: 10 }] }, true)
  assert.throws(() => reviewRecord(db, record.id, 'review_pass', tech.name, '', tech.username), /项目指定的复核人/)
  assert.throws(() => reviewRecord(db, record.id, 'review_pass', adminUser.name, '', adminUser.username), /项目指定的复核人/)

  setUserQualifications(db, tech.username, ['laboratory_review'], admin)
  assignProjectReviewers(db, contract.id, 'laboratory', tech.username, approver.username, planner, '指定技术负责人复核')
  assert.equal(reviewRecord(db, record.id, 'review_pass', tech.name, '', tech.username).status, 'reviewed')
  assert.throws(() => reviewRecord(db, record.id, 'approve', adminUser.name, '', adminUser.username), /项目指定的审核人/)

  setUserQualifications(db, adminUser.username, ['laboratory_approve'], admin)
  assignProjectReviewers(db, contract.id, 'laboratory', tech.username, adminUser.username, planner, '指定管理员审核')
  assert.equal(reviewRecord(db, record.id, 'approve', adminUser.name, '', adminUser.username).status, 'approved')
})

test('project legacy approved status is migration-required and cannot generate a sample report', () => {
  const { db, contract } = fixture()
  const sample = createSample(db, { client: contract.client, matrix: '废水', items: ['COD'], contractId: contract.id })
  const record = saveRecord(db, {
    sampleId: sample.id, code: 'HJ-TC-513', analyte: 'COD', data: { resultSummary: { analyte: 'COD', value: 10 } }, submit: true,
  })
  db.prepare(`UPDATE records SET status='approved' WHERE id=?`).run(record.id)
  assert.equal(listRecords(db, { sampleId: sample.id })[0].status, 'migration_required')
  assert.throws(() => generateReport(db, sample.id, 2026), /迁移.*工作流|工作流.*迁移/)
})

test('round report generation rejects contract records missing laboratory workflows', () => {
  const { db, contract } = fixture()
  db.prepare(`INSERT INTO rounds (id,contract_id,round_no,due_date,items,status,created_at) VALUES ('LAB-LEGACY-ROUND',?,1,'2026-08-21','[]','done','2026-08-21')`).run(contract.id)
  const sample = createSample(db, { client: contract.client, matrix: '废水', items: ['COD'], contractId: contract.id, roundId: 'LAB-LEGACY-ROUND' })
  const record = saveRecord(db, {
    sampleId: sample.id, code: 'HJ-TC-514', analyte: 'COD', data: { resultSummary: { analyte: 'COD', value: 10 } }, submit: true,
  })
  db.prepare(`UPDATE records SET status='approved' WHERE id=?`).run(record.id)
  assert.throws(() => generateRoundReport(db, 'LAB-LEGACY-ROUND', 2026), /迁移.*工作流|工作流.*迁移/)
})

test('contract total report generation rejects any project record missing a laboratory workflow', () => {
  const { db, contract } = fixture()
  db.prepare(`INSERT INTO rounds (id,contract_id,round_no,due_date,items,status,created_at) VALUES ('LAB-TOTAL-ROUND',?,1,'2026-08-21','[]','done','2026-08-21')`).run(contract.id)
  const sample = createSample(db, { client: contract.client, matrix: '废水', items: ['COD'], contractId: contract.id, roundId: 'LAB-TOTAL-ROUND' })
  const record = saveRecord(db, {
    sampleId: sample.id, code: 'HJ-TC-515', analyte: 'COD', data: { resultSummary: { analyte: 'COD', value: 10 } }, submit: true,
  })
  db.prepare(`UPDATE records SET status='approved' WHERE id=?`).run(record.id)
  db.prepare(`INSERT INTO reports (id,round_id,contract_id,client,title,conclusion,data,status,created_at)
    VALUES ('LAB-OLD-ROUND-REPORT','LAB-TOTAL-ROUND',?,?,'旧期次报告','—','{"round":{"no":1},"results":[]}','issued','2026-08-21')`)
    .run(contract.id, contract.client)
  assert.throws(() => generateContractReport(db, contract.id, '', 2026), /迁移.*工作流|工作流.*迁移/)
})

test('submitted and approved laboratory evidence cannot drift through any relevant write path', () => {
  const { db, analyst, reviewer, approver, makeSample } = fixture()
  const { sample, code } = makeSample('HJ-TC-505')
  const data = { rows: [{ value: 10 }], resultSummary: { analyte: 'COD', value: 10, unit: 'mg/L' } }
  const record = saveAs(db, sample.id, code, analyst, data)
  const attachment = addAttachment(db, {
    entityType: 'record', entityId: record.id, origName: '原始谱图.pdf', storedName: 'spectrum.pdf', contentHash: 'c'.repeat(64),
  }, analyst)
  saveAs(db, sample.id, code, analyst, data, true)
  assert.throws(() => addAttachment(db, { entityType: 'record', entityId: record.id, origName: '补传.pdf', storedName: 'late.pdf' }, analyst), /冻结/)
  assert.throws(() => deleteAttachment(db, attachment.id, analyst), /冻结/)
  assert.throws(() => addPretreatment(db, sample.id, { method: '定容' }, analyst), /冻结/)
  assert.throws(() => addQc(db, { qcType: '平行样', sampleId: sample.id, analyte: 'COD', v1: 1, v2: 1 }, analyst), /冻结/)
  reviewRecord(db, record.id, 'review_pass', reviewer.name, '', reviewer.username)
  reviewRecord(db, record.id, 'approve', approver.name, '', approver.username)
  assert.throws(() => saveAs(db, sample.id, code, analyst, { rows: [{ value: 99 }] }), /冻结/)
  assert.throws(() => saveRecordsBatch(db, {
    code, analyte: 'COD', entries: [{ sampleId: sample.id, row: { value: 99 } }], who: analyst.name, whoUsername: analyst.username,
  }, { supervisor: true, actor: analyst } as any), /冻结/)
  assert.throws(() => flagRecheck(db, record.id, '复检', true, analyst.name, { username: analyst.username }), /冻结/)
})

test('real HTTP record routes enforce analyst ownership and assigned qualified laboratory decisions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'laboratory-workflow-http-'))
  const dbPath = join(dir, 'db.sqlite')
  const uploadDir = join(dir, 'uploads')
  const port = 45600 + Math.floor(Math.random() * 250)
  let child: ReturnType<typeof spawn> | undefined
  try {
    const db = openDb(dbPath)
    const {
      contract, analyst, otherAnalyst, reviewer, approver, tech, adminUser,
      legacyReviewer, legacyApprover, sampler, sales, reportEditor, makeSample,
    } = fixture(db)
    const { sample, code } = makeSample('HJ-TC-506')
    const legacy = makeSample('HJ-TC-507')
    const legacyRecord = saveRecord(db, {
      sampleId: legacy.sample.id, code: legacy.code, analyte: 'COD', data: { rows: [{ value: 9 }] },
      who: analyst.name, whoUsername: analyst.username, submit: true,
    })
    db.prepare(`UPDATE records SET status='approved' WHERE id=?`).run(legacyRecord.id)

    const selfReviewSample = createSample(db, { client: '散样复核客户', matrix: '废水', items: ['COD'] })
    const selfReviewRecord = saveRecord(db, {
      sampleId: selfReviewSample.id, code: 'HJ-TC-516', analyte: 'COD', data: { rows: [{ value: 8 }] },
      who: analyst.name, whoUsername: analyst.username, submit: true,
    })
    const selfReviewRejectSample = createSample(db, { client: '散样复核退回客户', matrix: '废水', items: ['COD'] })
    const selfReviewRejectRecord = saveRecord(db, {
      sampleId: selfReviewRejectSample.id, code: 'HJ-TC-516-R', analyte: 'COD', data: { rows: [{ value: 8 }] },
      who: analyst.name, whoUsername: analyst.username, submit: true,
    })
    const selfApprovalRejectSample = createSample(db, { client: '散样审核退回客户', matrix: '废水', items: ['COD'] })
    const selfApprovalRejectRecord = saveRecord(db, {
      sampleId: selfApprovalRejectSample.id, code: 'HJ-TC-516-A', analyte: 'COD', data: { rows: [{ value: 8 }] },
      who: analyst.name, whoUsername: analyst.username, submit: true,
    })
    const selfSaveSample = createSample(db, { client: '散样录入客户', matrix: '废水', items: ['COD'] })
    const projectLeak = makeSample('HJ-TC-517')
    db.prepare(`UPDATE test_tasks SET assignee=?,assignee_username=? WHERE sample_id=?`)
      .run(otherAnalyst.name, otherAnalyst.username, projectLeak.sample.id)

    db.prepare(`INSERT INTO rounds (id,contract_id,round_no,due_date,items,status,created_at)
      VALUES ('LAB-HTTP-MIGRATION-ROUND',?,1,'2026-08-21','[]','done','2026-08-21'),
             ('LAB-HTTP-SUMMARY-ROUND',?,2,'2026-08-22','[]','done','2026-08-21')`).run(contract.id, contract.id)
    const roundLegacySample = createSample(db, {
      client: contract.client, matrix: '废水', items: ['COD'], contractId: contract.id, roundId: 'LAB-HTTP-MIGRATION-ROUND',
    })
    const roundLegacyRecord = saveRecord(db, {
      sampleId: roundLegacySample.id, code: 'HJ-TC-518', analyte: 'COD',
      data: { resultSummary: { analyte: 'COD', value: 7 } }, submit: true,
    })
    db.prepare(`UPDATE records SET status='approved' WHERE id=?`).run(roundLegacyRecord.id)
    db.prepare(`INSERT INTO reports (id,round_id,contract_id,client,title,conclusion,data,status,created_at)
      VALUES ('LAB-HTTP-OLD-ROUND-REPORT','LAB-HTTP-SUMMARY-ROUND',?,?,'已有期次报告','—','{"round":{"no":2},"results":[]}','issued','2026-08-21')`)
      .run(contract.id, contract.client)
    db.prepare(`UPDATE users SET must_change_pw=0`).run()
    db.close()
    child = spawn(process.execPath, ['src/server.ts'], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, PORT: String(port), DB_PATH: dbPath, UPLOAD_DIR: uploadDir },
      stdio: 'ignore',
    })
    const base = `http://127.0.0.1:${port}`
    const login = (user: User) => loginToTestServer(base, user.username, `secret-${user.username}`)
    const tokens = new Map<User, string>()
    for (const user of [
      analyst, otherAnalyst, reviewer, approver, tech, adminUser, legacyReviewer, legacyApprover,
      sampler, sales, reportEditor,
    ]) tokens.set(user, await login(user))
    const post = (path: string, user: User, body: any) => fetch(base + path, {
      method: 'POST', headers: { authorization: `Bearer ${tokens.get(user)}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const get = (path: string, user: User) => fetch(base + path, {
      headers: { authorization: `Bearer ${tokens.get(user)}` },
    })
    const body = {
      sampleId: sample.id, code, analyte: 'COD', method: '重铬酸盐法',
      data: { rows: [{ value: 12 }], resultSummary: { analyte: 'COD', value: 12, unit: 'mg/L' } }, submit: true,
    }
    assert.notEqual((await post(`/api/records/${legacyRecord.id}/review`, reviewer, { op: 'review_pass' })).status, 200,
      'a legacy mutable status row without a workflow must fail closed on the live route')
    assert.equal((await post('/api/records', tech, body)).status, 403, 'tech role alone must not author records')
    assert.notEqual((await post('/api/records', adminUser, body)).status, 200, 'admin role alone must not author records')

    for (const denied of [sampler, sales]) {
      assert.equal((await post(`/api/records/${selfReviewRecord.id}/review`, denied, { op: 'review_pass' })).status, 403)
    }
    assert.equal((await post(`/api/records/${selfReviewRecord.id}/review`, legacyReviewer, { op: 'review_pass' })).status, 200)
    for (const denied of [sampler, sales]) {
      assert.equal((await post(`/api/records/${selfReviewRejectRecord.id}/review`, denied, { op: 'review_reject', comment: '无权复核退回' })).status, 403)
    }
    assert.equal((await post(`/api/records/${selfReviewRejectRecord.id}/review`, legacyReviewer, { op: 'review_reject', comment: '授权复核退回' })).status, 200)

    assert.equal((await post(`/api/records/${selfApprovalRejectRecord.id}/review`, legacyReviewer, { op: 'review_pass' })).status, 200)
    for (const denied of [sampler, sales]) {
      assert.equal((await post(`/api/records/${selfApprovalRejectRecord.id}/review`, denied, { op: 'reject', comment: '无权审核退回' })).status, 403)
    }
    assert.equal((await post(`/api/records/${selfApprovalRejectRecord.id}/review`, legacyApprover, { op: 'reject', comment: '授权审核退回' })).status, 200)

    for (const denied of [sampler, sales]) {
      assert.equal((await post(`/api/records/${selfReviewRecord.id}/review`, denied, { op: 'approve' })).status, 403)
    }
    assert.equal((await post(`/api/records/${selfReviewRecord.id}/review`, legacyApprover, { op: 'approve' })).status, 200)
    assert.equal((await post(`/api/records/${selfReviewRecord.id}/review`, sampler, { op: 'revoke', comment: '无权打回' })).status, 403)
    assert.equal((await post(`/api/records/${selfReviewRecord.id}/review`, legacyApprover, { op: 'revoke', comment: '授权审核人打回' })).status, 200)

    assert.notEqual((await post('/api/reports/generate', reportEditor, { sampleId: legacy.sample.id })).status, 200,
      'sample report route must reject project legacy approved status')
    assert.notEqual((await post('/api/reports/generate-round', reportEditor, { roundId: 'LAB-HTTP-MIGRATION-ROUND' })).status, 200,
      'round report route must reject project legacy approved status')
    assert.notEqual((await post('/api/reports/generate-contract', reportEditor, { contractId: contract.id })).status, 200,
      'contract total report route must reject any project legacy record')

    const selfSaved = await post('/api/records', analyst, {
      sampleId: selfSaveSample.id, code: 'HJ-TC-519', analyte: 'COD', data: { rows: [{ value: 6 }] }, submit: true,
    })
    assert.equal(selfSaved.status, 200, 'an authenticated analyst can preserve the self-delivered sample path without a project task')
    assert.equal((await selfSaved.json() as any).status, 'submitted')
    assert.notEqual((await post('/api/records', analyst, {
      sampleId: projectLeak.sample.id, code: projectLeak.code, analyte: 'COD', data: { rows: [{ value: 6 }] }, submit: true,
    })).status, 200, 'the self-sample fallback must not bypass a contract task assigned to another analyst')

    const submitted = await post('/api/records', analyst, body)
    assert.equal(submitted.status, 200)
    const record = await submitted.json() as any
    assert.equal(record.status, 'submitted')
    assert.notEqual((await post(`/api/records/${record.id}/review`, tech, { op: 'review_pass' })).status, 200)
    const legacyQualificationOnlyReview = await post(`/api/records/${record.id}/review`, reviewer, { op: 'review_pass' })
    assert.equal(legacyQualificationOnlyReview.status, 403, 'qualification-only reviewer must not use an ordinary record route')
    assert.equal((await legacyQualificationOnlyReview.json() as any).error_code, 'QUALIFICATION_ONLY_ROUTE_FORBIDDEN')
    const workflowResponse = await get(`/api/workflows/lab_record/${record.id}`, reviewer)
    assert.equal(workflowResponse.status, 200)
    const workflow = await workflowResponse.json() as any
    assert.equal(workflow.subject_id, record.id)
    assert.equal(workflow.revisions.at(-1).snapshot.record.id, record.id)
    const reviewed = await post(`/api/workflows/${workflow.id}/decide`, reviewer, {
      revision: workflow.current_revision, level: 'review', decision: 'approve', comment: '实验室复核通过',
    })
    assert.equal(reviewed.status, 200)
    assert.equal((await reviewed.json() as any).status, 'pending_approval')
    const approvalView = await get(`/api/workflows/lab_record/${record.id}`, approver)
    assert.equal(approvalView.status, 200)
    const approved = await post(`/api/workflows/${workflow.id}/decide`, approver, {
      revision: workflow.current_revision, level: 'approve', decision: 'approve', comment: '实验室审核通过',
    })
    assert.equal(approved.status, 200)
    assert.equal((await approved.json() as any).status, 'approved')
  } finally {
    child?.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})
