import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DB } from '../src/db.ts'
import {
  createUser,
  generateContractReport,
  generateReport,
  generateRoundReport,
  getReport,
  issueReport,
  decideProfessionalWorkflow,
  submitReportWorkflow,
  updateReport,
  withdrawRecord,
  withdrawProfessionalWorkflow,
  type User,
} from '../src/handlers.ts'
import { assignProjectReviewers, setUserQualifications } from '../src/qualifications.ts'
import { decideWorkflow, getWorkflowView } from '../src/workflow.ts'

function actor(username: string, roles: string[] = []): User {
  return { username, name: username, roles, status: 'active', created_at: '', must_change_pw: false }
}

function stableJson(value: unknown): string {
  const normalise = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(normalise)
    if (current && typeof current === 'object') {
      return Object.fromEntries(Object.keys(current as Record<string, unknown>).sort()
        .map(key => [key, normalise((current as Record<string, unknown>)[key])]))
    }
    return current
  }
  return JSON.stringify(normalise(value))
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

type ArchivedRoundFixture = { roundId: string; recordId: string; workflowId: string; workflowHash: string }
function insertArchive(db: DB, input: {
  id: string; contractId: string; rounds: ArchivedRoundFixture[]; version: number; reportBatchId?: string | null
}) {
  const readiness = {
    ready: true, contractId: input.contractId, reportBatchId: input.reportBatchId ?? null,
    roundIds: input.rounds.map(round => round.roundId), issues: [],
  }
  db.prepare(`INSERT INTO archive_packages
    (id,contract_id,report_batch_id,version,status,manifest_sha256,readiness_json,created_by,created_at)
    VALUES (?,?,?,?,'ready',?,?,?,?)`).run(
    input.id, input.contractId, input.reportBatchId ?? null, input.version, '0'.repeat(64), stableJson(readiness), 'archivist', `2026-08-22T0${input.version}:00:00.000Z`,
  )
  const items: { entityType: string; entityId: string; workflowInstanceId: string | null; revision: number | null; contentHash: string }[] = [
    { entityType: 'contract', entityId: input.contractId, workflowInstanceId: null, revision: null, contentHash: 'a'.repeat(64) },
  ]
  input.rounds.forEach((round, index) => {
    items.push({ entityType: 'round', entityId: round.roundId, workflowInstanceId: null, revision: null, contentHash: String(index + 1).repeat(64) })
    items.push({ entityType: 'lab_record_workflow', entityId: round.recordId, workflowInstanceId: round.workflowId, revision: 1, contentHash: round.workflowHash })
  })
  items.forEach((item, index) => db.prepare(`INSERT INTO archive_items
    (archive_package_id,item_order,entity_type,entity_id,workflow_instance_id,revision,content_hash,label,metadata_json)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    input.id, index + 1, item.entityType, item.entityId, item.workflowInstanceId, item.revision,
    item.contentHash, `${item.entityType}:${item.entityId}`, '{}',
  ))
  const manifest = items.map((item, index) => ({ order: index + 1, ...item }))
  db.prepare(`UPDATE archive_packages SET manifest_sha256=?,status='confirmed',confirmed_by='archivist',confirmed_at=? WHERE id=?`)
    .run(sha256(stableJson(manifest)), `2026-08-22T0${input.version}:30:00.000Z`, input.id)
}

function fixture(db = openDb(':memory:'), options: { secondRound?: boolean; reportBatch?: boolean } = {}) {
  const admin = actor('admin', ['admin'])
  const planner = actor('planner', ['planner'])
  const author = actor('report-author', ['report_editor', 'signer'])
  const reviewer = actor('report-reviewer', ['signer'])
  const approver = actor('report-approver', ['signer'])
  const signer = actor('report-signer', ['signer'])
  const outsider = actor('report-outsider', ['report_editor'])
  const archivist = actor('archivist', ['archivist'])
  const labAuthor = actor('lab-author', ['analyst'])
  for (const user of [admin, planner, author, reviewer, approver, signer, outsider, archivist, labAuthor]) {
    createUser(db, { username: user.username, name: user.name, roles: user.roles, password: 'secret1' })
  }
  const contractId = 'WT2026-REPORT'
  const roundId = 'WT2026-REPORT-R01'
  const sampleId = 'REPORT-SAMPLE-1'
  const recordId = 'REPORT-RECORD-1'
  const labWorkflowId = 'REPORT-LAB-WORKFLOW-1'
  db.prepare(`INSERT INTO contracts(id,client,status,created_at) VALUES (?,?,?,?)`)
    .run(contractId, '报告流程测试厂', 'confirmed', '2026-08-22T00:00:00.000Z')
  db.prepare(`INSERT INTO rounds(id,contract_id,round_no,due_date,items,status,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(roundId, contractId, 1, '2026-08-22', '[]', 'done', '2026-08-22T00:00:00.000Z')
  db.prepare(`INSERT INTO samples(id,client,matrix,items,status,contract_id,round_id,source,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    sampleId, '报告流程测试厂', '废水', '["COD"]', 'done', contractId, roundId, 'field', '2026-08-22T00:00:00.000Z',
  )
  db.prepare(`INSERT INTO records
    (id,serial,sample_id,template_code,template_name,sheet_type,method,analyte,matrix,data,status,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    recordId, 'JL2026-REPORT', sampleId, 'HJ-TC-001', '水质记录', 'lab', '重铬酸盐法', 'COD', '废水',
    '{"resultSummary":{"analyte":"COD","value":12,"unit":"mg/L"}}', 'approved', '2026-08-22T00:30:00.000Z',
  )
  const labSnapshot = '{"result":12}'
  const labHash = sha256(labSnapshot)
  db.prepare(`INSERT INTO workflow_instances
    (id,contract_id,round_id,scope,subject_type,subject_id,status,current_revision,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    labWorkflowId, contractId, roundId, 'laboratory', 'lab_record', recordId, 'approved', 1, 'lab-author', '2026-08-22T00:30:00.000Z',
  )
  db.prepare(`INSERT INTO workflow_revisions
    (instance_id,revision,snapshot_json,snapshot_sha256,submitted_by,submitted_at) VALUES (?,?,?,?,?,?)`).run(
    labWorkflowId, 1, labSnapshot, labHash, 'lab-author', '2026-08-22T00:30:00.000Z',
  )
  const archivedRounds: ArchivedRoundFixture[] = [{ roundId, recordId, workflowId: labWorkflowId, workflowHash: labHash }]
  let secondRoundId: string | null = null
  if (options.secondRound) {
    secondRoundId = 'WT2026-REPORT-R02'
    const secondSampleId = 'REPORT-SAMPLE-2'
    const secondRecordId = 'REPORT-RECORD-2'
    const secondWorkflowId = 'REPORT-LAB-WORKFLOW-2'
    db.prepare(`INSERT INTO rounds(id,contract_id,round_no,due_date,items,status,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(secondRoundId, contractId, 2, '2026-09-22', '[]', 'done', '2026-08-22T00:00:00.000Z')
    db.prepare(`INSERT INTO samples(id,client,matrix,items,status,contract_id,round_id,source,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      secondSampleId, '报告流程测试厂', '废水', '["COD"]', 'done', contractId, secondRoundId, 'field', '2026-08-22T00:00:00.000Z',
    )
    db.prepare(`INSERT INTO records
      (id,serial,sample_id,template_code,template_name,sheet_type,method,analyte,matrix,data,status,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      secondRecordId, 'JL2026-REPORT-2', secondSampleId, 'HJ-TC-001', '水质记录', 'lab', '重铬酸盐法', 'COD', '废水',
      '{"resultSummary":{"analyte":"COD","value":18,"unit":"mg/L"}}', 'approved', '2026-08-22T00:30:00.000Z',
    )
    const secondSnapshot = '{"result":18}'
    const secondHash = sha256(secondSnapshot)
    db.prepare(`INSERT INTO workflow_instances
      (id,contract_id,round_id,scope,subject_type,subject_id,status,current_revision,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      secondWorkflowId, contractId, secondRoundId, 'laboratory', 'lab_record', secondRecordId, 'approved', 1, 'lab-author', '2026-08-22T00:30:00.000Z',
    )
    db.prepare(`INSERT INTO workflow_revisions
      (instance_id,revision,snapshot_json,snapshot_sha256,submitted_by,submitted_at) VALUES (?,?,?,?,?,?)`).run(
      secondWorkflowId, 1, secondSnapshot, secondHash, 'lab-author', '2026-08-22T00:30:00.000Z',
    )
    archivedRounds.push({ roundId: secondRoundId, recordId: secondRecordId, workflowId: secondWorkflowId, workflowHash: secondHash })
  }
  setUserQualifications(db, reviewer.username, ['report_review'], admin)
  setUserQualifications(db, approver.username, ['report_approve'], admin)
  assignProjectReviewers(db, contractId, 'report', reviewer.username, approver.username, planner)
  const reportBatchId = options.reportBatch ? 'REPORT-BATCH-1' : null
  if (reportBatchId) {
    db.prepare(`INSERT INTO report_batches(id,contract_id,name,created_by,created_at) VALUES (?,?,?,?,?)`)
      .run(reportBatchId, contractId, '显式两期报告批次', planner.username, '2026-08-22T00:00:00.000Z')
    archivedRounds.forEach(round => db.prepare(`INSERT INTO report_batch_rounds(batch_id,round_id,attached_by,attached_at) VALUES (?,?,?,?)`)
      .run(reportBatchId, round.roundId, planner.username, '2026-08-22T00:00:00.000Z'))
  }
  insertArchive(db, { id: 'ARCHIVE-OLD', contractId, rounds: archivedRounds, version: 1, reportBatchId })
  insertArchive(db, { id: 'ARCHIVE-CURRENT', contractId, rounds: archivedRounds, version: 2, reportBatchId })
  return { db, contractId, roundId, secondRoundId, sampleId, recordId, labWorkflowId, author, reviewer, approver, signer, outsider, planner, archivist, labAuthor, reportBatchId }
}

test('project report creation requires the current confirmed archive and an active report editor', () => {
  const { db, sampleId, author, outsider } = fixture()
  assert.throws(
    () => generateReport(db, sampleId, 2026, author.name, author.username),
    /确认归档|归档版本|ARCHIVE_REQUIRED/,
  )
  assert.throws(
    () => generateReport(db, sampleId, 2026, author.name, author.username, 'ARCHIVE-OLD'),
    /当前.*归档|最新.*归档/,
  )
  db.prepare(`UPDATE users SET status='inactive' WHERE username=?`).run(outsider.username)
  assert.throws(
    () => generateReport(db, sampleId, 2026, outsider.name, outsider.username, 'ARCHIVE-CURRENT'),
    /在职.*报告编制|报告编制人员/,
  )
  const report = generateReport(db, sampleId, 2026, author.name, author.username, 'ARCHIVE-CURRENT')
  assert.equal(report.archive_package_id, 'ARCHIVE-CURRENT')
})

test('single-actor acceptance mode lets the configured admin author, review, approve and issue one project report', () => {
  const previousUsername = process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME
  const previousUntil = process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL
  process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME = 'report-author'
  process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL = '2099-12-31T23:59:59.999Z'
  try {
    const fx = fixture()
    fx.db.prepare(`UPDATE users SET roles='["admin","report_editor","signer"]' WHERE username=?`).run(fx.author.username)
    const singleActor = actor(fx.author.username, ['admin', 'report_editor', 'signer'])
    setUserQualifications(fx.db, singleActor.username, ['report_review', 'report_approve'], singleActor)
    assignProjectReviewers(fx.db, fx.contractId, 'report', singleActor.username, singleActor.username, singleActor, '单人验收')
    const report = generateReport(fx.db, fx.sampleId, 2026, singleActor.name, singleActor.username, 'ARCHIVE-CURRENT')
    const workflow = submitReportWorkflow(fx.db, report.id, singleActor)

    decideProfessionalWorkflow(fx.db, workflow.id, 1, 'review', 'approve', '', singleActor)
    decideProfessionalWorkflow(fx.db, workflow.id, 1, 'approve', 'approve', '', singleActor)
    fx.db.exec(`CREATE TRIGGER reject_acceptance_audit BEFORE INSERT ON audit_log
      WHEN NEW.action='acceptance_override_report_issue'
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`)
    assert.throws(() => issueReport(fx.db, report.id, singleActor.name, singleActor.username), /audit unavailable/)
    assert.notEqual(getReport(fx.db, report.id)!.status, 'issued')
    fx.db.exec(`DROP TRIGGER reject_acceptance_audit`)
    assert.equal(issueReport(fx.db, report.id, singleActor.name, singleActor.username).status, 'issued')
    const overrides = fx.db.prepare(`SELECT action FROM audit_log WHERE username=? AND action LIKE 'acceptance_override_%' ORDER BY id`).all(singleActor.username) as any[]
    assert.deepEqual(overrides.map(row => row.action), [
      'acceptance_override_workflow_assignment',
      'acceptance_override_workflow_submit',
      'acceptance_override_workflow_review',
      'acceptance_override_workflow_approve',
      'acceptance_override_report_issue',
    ])
  } finally {
    if (previousUsername === undefined) delete process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME
    else process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME = previousUsername
    if (previousUntil === undefined) delete process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL
    else process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL = previousUntil
  }
})

test('single-actor acceptance does not let the report author sign a normally separated workflow', () => {
  const previousUsername = process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME
  const previousUntil = process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL
  process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME = 'report-author'
  process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL = '2099-12-31T23:59:59.999Z'
  try {
    const fx = fixture()
    fx.db.prepare(`UPDATE users SET roles='["admin","report_editor","signer"]' WHERE username=?`).run(fx.author.username)
    const configuredAuthor = actor(fx.author.username, ['admin', 'report_editor', 'signer'])
    const report = generateReport(fx.db, fx.sampleId, 2026, configuredAuthor.name, configuredAuthor.username, 'ARCHIVE-CURRENT')
    const workflow = submitReportWorkflow(fx.db, report.id, configuredAuthor)
    decideProfessionalWorkflow(fx.db, workflow.id, 1, 'review', 'approve', '', fx.reviewer)
    decideProfessionalWorkflow(fx.db, workflow.id, 1, 'approve', 'approve', '', fx.approver)

    assert.throws(
      () => issueReport(fx.db, report.id, configuredAuthor.name, configuredAuthor.username),
      /授权签字人不能同时是报告编制人|编制人/,
    )
  } finally {
    if (previousUsername === undefined) delete process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME
    else process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME = previousUsername
    if (previousUntil === undefined) delete process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL
    else process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL = previousUntil
  }
})

test('single-actor acceptance cannot issue after the report assignment returns to separated accounts', () => {
  const previousUsername = process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME
  const previousUntil = process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL
  process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME = 'report-author'
  process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL = '2099-12-31T23:59:59.999Z'
  try {
    const fx = fixture()
    fx.db.prepare(`UPDATE users SET roles='["admin","report_editor","signer"]' WHERE username=?`).run(fx.author.username)
    const singleActor = actor(fx.author.username, ['admin', 'report_editor', 'signer'])
    setUserQualifications(fx.db, singleActor.username, ['report_review', 'report_approve'], singleActor)
    assignProjectReviewers(fx.db, fx.contractId, 'report', singleActor.username, singleActor.username, singleActor, '单人验收')
    const report = generateReport(fx.db, fx.sampleId, 2026, singleActor.name, singleActor.username, 'ARCHIVE-CURRENT')
    const workflow = submitReportWorkflow(fx.db, report.id, singleActor)
    decideProfessionalWorkflow(fx.db, workflow.id, 1, 'review', 'approve', '', singleActor)
    decideProfessionalWorkflow(fx.db, workflow.id, 1, 'approve', 'approve', '', singleActor)

    assignProjectReviewers(fx.db, fx.contractId, 'report', fx.reviewer.username, fx.approver.username, fx.planner, '恢复多人审核')

    assert.throws(
      () => issueReport(fx.db, report.id, singleActor.name, singleActor.username),
      /授权签字人不能同时是报告编制人|编制人/,
    )
  } finally {
    if (previousUsername === undefined) delete process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME
    else process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME = previousUsername
    if (previousUntil === undefined) delete process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL
    else process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL = previousUntil
  }
})

test('contract-total reports bind the exact current archive scope and report workflow', () => {
  const fx = fixture()
  const child = generateRoundReport(fx.db, fx.roundId, 2026, fx.author.name, fx.author.username, 'ARCHIVE-CURRENT')
  approveChildReport(fx.db, child.id, fx)
  assert.throws(
    () => generateContractReport(fx.db, fx.contractId, fx.author.name, 2026, fx.author.username),
    /确认归档|归档版本|ARCHIVE_REQUIRED/,
  )
  const total = generateContractReport(fx.db, fx.contractId, fx.author.name, 2026, fx.author.username, 'ARCHIVE-CURRENT')
  assert.equal(total.archive_package_id, 'ARCHIVE-CURRENT')
  assert.equal(total.data.archiveVersion, 2)
  assert.equal(submitReportWorkflow(fx.db, total.id, fx.author).status, 'pending_review')
})

function approveChildReport(
  db: DB,
  reportId: string,
  actors: Pick<ReturnType<typeof fixture>, 'author' | 'reviewer' | 'approver' | 'signer'>,
  issue = false,
) {
  const workflow = submitReportWorkflow(db, reportId, actors.author)
  decideProfessionalWorkflow(db, workflow.id, workflow.current_revision, 'review', 'approve', '', actors.reviewer)
  decideProfessionalWorkflow(db, workflow.id, workflow.current_revision, 'approve', 'approve', '', actors.approver)
  return issue ? issueReport(db, reportId, actors.signer.name, actors.signer.username) : getReport(db, reportId)!
}

test('contract-total requires one approved-or-issued current-archive child report for every selected round', () => {
  const fx = fixture(openDb(':memory:'), { secondRound: true })
  const first = generateRoundReport(fx.db, fx.roundId, 2026, fx.author.name, fx.author.username, 'ARCHIVE-CURRENT')
  approveChildReport(fx.db, first.id, fx)
  assert.throws(
    () => generateContractReport(fx.db, fx.contractId, fx.author.name, 2026, fx.author.username, 'ARCHIVE-CURRENT'),
    /第2期|每个.*期次|缺少.*期次报告/,
  )
  const second = generateRoundReport(fx.db, fx.secondRoundId!, 2026, fx.author.name, fx.author.username, 'ARCHIVE-CURRENT')
  assert.throws(
    () => generateContractReport(fx.db, fx.contractId, fx.author.name, 2026, fx.author.username, 'ARCHIVE-CURRENT'),
    /草稿|未批准|未签发/,
  )
  approveChildReport(fx.db, second.id, fx, true)
  const total = generateContractReport(fx.db, fx.contractId, fx.author.name, 2026, fx.author.username, 'ARCHIVE-CURRENT')
  assert.deepEqual(total.data.roundReports, [first.id, second.id])
  assert.equal(total.data.results.length, 2)
})

test('contract-total rejects blocked, reissue-required, stale, premature, or wrong-archive child reports', () => {
  const cases: { label: string; mutate: (fx: ReturnType<typeof fixture>, reportId: string) => void; expected: RegExp }[] = [
    {
      label: '被归档失效阻断',
      mutate: (fx, id) => { fx.db.prepare(`UPDATE reports SET archive_blocked_at='2026-08-22',archive_block_reason='上游撤回' WHERE id=?`).run(id) },
      expected: /归档.*阻断|失效/,
    },
    {
      label: '已签发但要求重出',
      mutate: (fx, id) => { fx.db.prepare(`UPDATE reports SET status='issued',archive_requires_reissue=1 WHERE id=?`).run(id) },
      expected: /重出|作废/,
    },
    {
      label: '批准后内容漂移',
      mutate: (fx, id) => { fx.db.prepare(`UPDATE reports SET conclusion='快照后被篡改' WHERE id=?`).run(id) },
      expected: /快照|漂移|版本.*不一致/,
    },
    {
      label: '未批准却伪造 checked 状态',
      mutate: (fx, id) => {
        submitReportWorkflow(fx.db, id, fx.author)
        fx.db.prepare(`UPDATE reports SET status='checked' WHERE id=?`).run(id)
      },
      expected: /尚未批准|专业.*批准/,
    },
    {
      label: '子报告绑定旧归档',
      mutate: (fx, id) => { fx.db.prepare(`UPDATE reports SET archive_package_id='ARCHIVE-OLD' WHERE id=?`).run(id) },
      expected: /当前.*归档|归档.*不一致/,
    },
  ]
  for (const current of cases) {
    const fx = fixture(openDb(':memory:'), { secondRound: true })
    const first = generateRoundReport(fx.db, fx.roundId, 2026, fx.author.name, fx.author.username, 'ARCHIVE-CURRENT')
    const second = generateRoundReport(fx.db, fx.secondRoundId!, 2026, fx.author.name, fx.author.username, 'ARCHIVE-CURRENT')
    approveChildReport(fx.db, first.id, fx)
    if (!current.label.includes('未批准')) approveChildReport(fx.db, second.id, fx)
    current.mutate(fx, second.id)
    assert.throws(
      () => generateContractReport(fx.db, fx.contractId, fx.author.name, 2026, fx.author.username, 'ARCHIVE-CURRENT'),
      current.expected,
      current.label,
    )
  }
})

test('explicit report-batch total requires and aggregates exactly its archived child rounds', () => {
  const fx = fixture(openDb(':memory:'), { secondRound: true, reportBatch: true })
  const first = generateRoundReport(fx.db, fx.roundId, 2026, fx.author.name, fx.author.username, 'ARCHIVE-CURRENT')
  assert.equal(first.data.reportBatchId, 'REPORT-BATCH-1')
  assert.equal(first.data.archiveVersion, 2)
  approveChildReport(fx.db, first.id, fx)
  assert.throws(
    () => generateContractReport(fx.db, fx.contractId, fx.author.name, 2026, fx.author.username, 'ARCHIVE-CURRENT'),
    /缺少第2期报告/,
  )
  const second = generateRoundReport(fx.db, fx.secondRoundId!, 2026, fx.author.name, fx.author.username, 'ARCHIVE-CURRENT')
  approveChildReport(fx.db, second.id, fx, true)
  const total = generateContractReport(fx.db, fx.contractId, fx.author.name, 2026, fx.author.username, 'ARCHIVE-CURRENT')
  assert.equal(total.data.reportBatchId, 'REPORT-BATCH-1')
  assert.deepEqual(total.data.roundReports, [first.id, second.id])
})

test('report rejection creates a new immutable revision and issue stores a permanent receipt', () => {
  const { db, sampleId, author, reviewer, approver, signer, outsider } = fixture()
  const report = generateReport(db, sampleId, 2026, author.name, author.username, 'ARCHIVE-CURRENT')
  const submitted = submitReportWorkflow(db, report.id, author)
  assert.equal(submitted.status, 'pending_review')
  const firstRevisionHash = submittedSnapshotHash(db, submitted.id, 1)
  assert.throws(() => updateReport(db, report.id, { conclusion: '静默修改' }, author), /提交审核.*冻结|内容.*冻结/)
  assert.throws(
    () => decideWorkflow(db, submitted.id, 1, 'review', 'approve', '', outsider),
    /指定的复核人/,
  )
  decideWorkflow(db, submitted.id, 1, 'review', 'reject', '补充结论依据', reviewer)
  updateReport(db, report.id, { conclusion: '已补充结论依据' }, author)
  const resubmitted = submitReportWorkflow(db, report.id, author)
  assert.equal(resubmitted.current_revision, 2)
  assert.equal(getWorkflowView(db, 'report', report.id)!.revisions[0].snapshot_sha256, firstRevisionHash)
  decideWorkflow(db, submitted.id, 2, 'review', 'approve', '', reviewer)
  decideWorkflow(db, submitted.id, 2, 'approve', 'approve', '', approver)
  assert.throws(() => issueReport(db, report.id, author.name, author.username), /编制人/)
  assert.throws(() => issueReport(db, report.id, reviewer.name, reviewer.username), /复核人|授权签字人/)
  assert.throws(() => issueReport(db, report.id, approver.name, approver.username), /审核人|授权签字人/)
  const issued = issueReport(db, report.id, signer.name, signer.username)
  assert.equal(issued.status, 'issued')
  assert.match(String((issued as any).receipt_id), /^RPT-/)
  assert.match(String(issued.issued_at), /^\d{4}-\d{2}-\d{2}T/)
  assert.equal((issued as any).workflow_revision, 2)
  assert.equal((issued as any).archive_version, 2)
  assert.equal((issueReport(db, report.id, signer.name, signer.username) as any).receipt_id, (issued as any).receipt_id)
})

test('approved report detects client or versioned document drift before issue',()=>{
  const{db,sampleId,author,reviewer,approver,signer}=fixture()
  const report=generateReport(db,sampleId,2026,author.name,author.username,'ARCHIVE-CURRENT')
  const submitted=submitReportWorkflow(db,report.id,author)
  decideWorkflow(db,submitted.id,submitted.current_revision,'review','approve','',reviewer)
  decideWorkflow(db,submitted.id,submitted.current_revision,'approve','approve','',approver)
  db.prepare(`UPDATE reports SET client='被篡改客户' WHERE id=?`).run(report.id)
  assert.throws(()=>issueReport(db,report.id,signer.name,signer.username),/批准版本不一致|内容.*不一致/)
})

test('generic withdrawal invalidates every archive containing the exact approved revision and blocks its draft report', () => {
  const { db, sampleId, labWorkflowId, author, labAuthor } = fixture()
  const report = generateReport(db, sampleId, 2026, author.name, author.username, 'ARCHIVE-CURRENT')
  const result = withdrawProfessionalWorkflow(db, labWorkflowId, '原始记录需更正', labAuthor)
  assert.equal(result.workflow.status, 'withdrawn')
  assert.deepEqual(result.invalidation.invalidatedArchiveIds, ['ARCHIVE-OLD', 'ARCHIVE-CURRENT'])
  assert.deepEqual(result.invalidation.blockedReportIds, [report.id])
  assert.ok(getReport(db, report.id)!.archive_blocked_at)
})

test('approved record withdrawal uses the explicit reason and atomically blocks draft/checked reports while preserving issued evidence', () => {
  const { db, sampleId, recordId, author, labAuthor } = fixture()
  const draft = generateReport(db, sampleId, 2026, author.name, author.username, 'ARCHIVE-CURRENT')
  db.prepare(`INSERT INTO reports
    (id,sample_id,contract_id,client,title,conclusion,data,status,author,author_username,archive_package_id,created_at)
    SELECT 'REPORT-CHECKED',sample_id,contract_id,client,title,conclusion,data,'checked',author,author_username,archive_package_id,created_at
    FROM reports WHERE id=?`).run(draft.id)
  db.prepare(`INSERT INTO reports
    (id,sample_id,contract_id,client,title,conclusion,data,status,author,author_username,archive_package_id,issuer,issuer_username,issued_at,created_at)
    SELECT 'REPORT-ISSUED',sample_id,contract_id,client,title,conclusion,data,'issued',author,author_username,archive_package_id,
      'report-signer','report-signer','2026-08-22T02:00:00.000Z',created_at FROM reports WHERE id=?`).run(draft.id)
  const withdrawn = withdrawRecord(db, recordId, labAuthor, '经核对原始谱图需更正')
  assert.equal(withdrawn.status, 'draft')
  assert.equal(getWorkflowView(db, 'lab_record', recordId)!.status, 'withdrawn')
  const archive = db.prepare(`SELECT status,invalidation_reason FROM archive_packages WHERE id='ARCHIVE-CURRENT'`).get() as any
  assert.equal(archive.status, 'invalidated')
  assert.equal(archive.invalidation_reason, '经核对原始谱图需更正')
  assert.ok(getReport(db, draft.id)!.archive_blocked_at)
  assert.ok(getReport(db, 'REPORT-CHECKED')!.archive_blocked_at)
  const issued = getReport(db, 'REPORT-ISSUED')!
  assert.equal(issued.status, 'issued')
  assert.equal(issued.archive_requires_reissue, 1)
  assert.equal(issued.archive_blocked_at, null)
})

function submittedSnapshotHash(db: DB, instanceId: string, revision: number) {
  return (db.prepare(`SELECT snapshot_sha256 FROM workflow_revisions WHERE instance_id=? AND revision=?`)
    .get(instanceId, revision) as { snapshot_sha256: string }).snapshot_sha256
}

test('generic workflow and contract routes enforce exact assignees with stable conflict codes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'report-workflow-http-'))
  const dbPath = join(dir, 'db.sqlite')
  const uploadDir = join(dir, 'uploads')
  const port = 45600 + Math.floor(Math.random() * 300)
  let child: ReturnType<typeof spawn> | undefined
  try {
    const db = openDb(dbPath)
    const fixtureData = fixture(db)
    const report = generateReport(
      db, fixtureData.sampleId, 2026, fixtureData.author.name, fixtureData.author.username, 'ARCHIVE-CURRENT',
    )
    const workflow = submitReportWorkflow(db, report.id, fixtureData.author)
    db.prepare(`UPDATE users SET must_change_pw=0`).run()
    db.close()

    child = spawn(process.execPath, ['src/server.ts'], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, PORT: String(port), DB_PATH: dbPath, UPLOAD_DIR: uploadDir },
      stdio: 'ignore',
    })
    const base = `http://127.0.0.1:${port}`
    const login = async (username: string) => {
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          const response = await fetch(base + '/api/login', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username, password: 'secret1' }),
          })
          if (response.ok) return (await response.json() as any).token as string
        } catch { /* server is still starting */ }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      throw new Error(`测试服务器未启动或 ${username} 登录失败`)
    }
    const request = (token: string, path: string, body?: unknown) => fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    const authorToken = await login(fixtureData.author.username)
    const outsiderToken = await login(fixtureData.outsider.username)
    const reviewerToken = await login(fixtureData.reviewer.username)
    const approverToken = await login(fixtureData.approver.username)
    const plannerToken = await login(fixtureData.planner.username)
    const labAuthorToken = await login(fixtureData.labAuthor.username)

    const view = await request(authorToken, `/api/workflows/report/${encodeURIComponent(report.id)}`)
    assert.equal(view.status, 200)
    assert.equal((await view.json() as any).current_revision, 1)

    const invalidSubject = await request(authorToken, `/api/workflows/not-a-subject/${encodeURIComponent(report.id)}`)
    assert.equal(invalidSubject.status, 400)
    const invalidLevel = await request(reviewerToken, `/api/workflows/${encodeURIComponent(workflow.id)}/decide`, {
      revision: 1, level: 'sign', decision: 'approve', comment: '',
    })
    assert.equal(invalidLevel.status, 400)
    const invalidDecision = await request(reviewerToken, `/api/workflows/${encodeURIComponent(workflow.id)}/decide`, {
      revision: 1, level: 'review', decision: 'skip', comment: '',
    })
    assert.equal(invalidDecision.status, 400)

    const notDistinct = await request(plannerToken, `/api/contracts/${fixtureData.contractId}/workflow-assignments/report`, {
      reviewerUsername: fixtureData.reviewer.username,
      approverUsername: fixtureData.reviewer.username,
      reason: '测试不合法同人指派',
    })
    assert.equal(notDistinct.status, 409)
    assert.equal((await notDistinct.json() as any).error_code, 'WORKFLOW_PERSON_NOT_DISTINCT')

    const denied = await request(outsiderToken, `/api/workflows/${encodeURIComponent(workflow.id)}/decide`, {
      revision: 1, level: 'review', decision: 'approve', comment: '',
    })
    assert.equal(denied.status, 403)
    assert.equal((await denied.json() as any).error_code, 'WORKFLOW_WRONG_ASSIGNEE')

    const stale = await request(reviewerToken, `/api/workflows/${encodeURIComponent(workflow.id)}/decide`, {
      revision: 99, level: 'review', decision: 'approve', comment: '',
    })
    assert.equal(stale.status, 409)
    assert.equal((await stale.json() as any).error_code, 'WORKFLOW_STALE_REVISION')

    const rejectedFirst = await request(reviewerToken, `/api/reports/${encodeURIComponent(report.id)}/reject`, {
      revision: 1, reason: '结论依据需补充',
    })
    assert.equal(rejectedFirst.status, 200)
    const edited = await request(authorToken, `/api/reports/${encodeURIComponent(report.id)}/update`, {
      conclusion: '已补充结论依据',
    })
    assert.equal(edited.status, 200)
    const resubmitted = await request(authorToken, `/api/workflows/report/${encodeURIComponent(report.id)}/submit`, {})
    assert.equal(resubmitted.status, 200)
    assert.equal((await resubmitted.json() as any).current_revision, 2)

    const staleCheck = await request(reviewerToken, `/api/reports/${encodeURIComponent(report.id)}/check`, { revision: 1 })
    assert.equal(staleCheck.status, 409)
    assert.equal((await staleCheck.json() as any).error_code, 'WORKFLOW_STALE_REVISION')
    const staleReject = await request(reviewerToken, `/api/reports/${encodeURIComponent(report.id)}/reject`, {
      revision: 1, reason: '旧页面退回',
    })
    assert.equal(staleReject.status, 409)
    assert.equal((await staleReject.json() as any).error_code, 'WORKFLOW_STALE_REVISION')

    const reviewed = await request(reviewerToken, `/api/reports/${encodeURIComponent(report.id)}/check`, { revision: 2 })
    assert.equal(reviewed.status, 200)
    const rejectedApproval = await request(approverToken, `/api/reports/${encodeURIComponent(report.id)}/reject`, {
      revision: 2, reason: '审核退回再补充',
    })
    assert.equal(rejectedApproval.status, 200)
    assert.equal((await request(authorToken, `/api/reports/${encodeURIComponent(report.id)}/update`, {
      conclusion: '已按审核意见再补充',
    })).status, 200)
    const third = await request(authorToken, `/api/workflows/report/${encodeURIComponent(report.id)}/submit`, {})
    assert.equal((await third.json() as any).current_revision, 3)
    const approvedReview = await request(reviewerToken, `/api/workflows/${encodeURIComponent(workflow.id)}/decide`, {
      revision: 3, level: 'review', decision: 'approve', comment: '',
    })
    assert.equal((await approvedReview.json() as any).status, 'pending_approval')
    const approved = await request(approverToken, `/api/workflows/${encodeURIComponent(workflow.id)}/decide`, {
      revision: 3, level: 'approve', decision: 'approve', comment: '',
    })
    assert.equal(approved.status, 200)
    assert.equal((await approved.json() as any).status, 'approved')

    const assignments = await request(plannerToken, `/api/contracts/${fixtureData.contractId}/workflow-assignments`)
    assert.equal(assignments.status, 200)
    assert.ok((await assignments.json() as any[]).some(item => item.scope === 'report'))
    const readiness = await request(plannerToken, `/api/contracts/${fixtureData.contractId}/archive-readiness`)
    assert.equal(readiness.status, 200)
    assert.equal((await readiness.json() as any).contractId, fixtureData.contractId)

    const missingWithdrawalReason = await request(labAuthorToken, `/api/records/${encodeURIComponent(fixtureData.recordId)}/withdraw`, {})
    assert.equal(missingWithdrawalReason.status, 400)
    assert.match(String((await missingWithdrawalReason.json() as any).error), /原因/)
    const withdrawn = await request(labAuthorToken, `/api/records/${encodeURIComponent(fixtureData.recordId)}/withdraw`, {
      reason: '原始记录需更正',
    })
    assert.equal(withdrawn.status, 200)
    const invalidatedArchive = await request(authorToken, '/api/archive-packages/ARCHIVE-CURRENT')
    assert.equal((await invalidatedArchive.json() as any).status, 'invalidated')
    const blockedReport = await request(authorToken, `/api/reports/${encodeURIComponent(report.id)}`)
    assert.ok((await blockedReport.json() as any).archive_blocked_at)
  } finally {
    child?.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})
