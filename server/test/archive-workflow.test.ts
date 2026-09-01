import { createHash } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DB } from '../src/db.ts'
import {
  archiveReadiness,
  assertConfirmedArchiveForReport,
  buildArchivePackage,
  confirmArchivePackage,
  createReportBatch,
  getArchivePackage,
  invalidateAffectedArchives,
} from '../src/archivePackages.ts'

const archivist = {
  username: 'archive-user', name: '归档员', roles: ['archivist'], status: 'active', created_at: '', must_change_pw: false,
}
const planner = {
  username: 'planner-user', name: '计划员', roles: ['planner'], status: 'active', created_at: '', must_change_pw: false,
}
const editor = {
  username: 'report-user', name: '报告编制', roles: ['report_editor'], status: 'active', created_at: '', must_change_pw: false,
}

function jsonHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function addWorkflow(
  db: DB,
  input: { id: string; contractId: string; roundId: string; type: 'round_sampling' | 'quality_plan' | 'lab_record'; subjectId: string; scope: string; status?: string; revision?: number },
) {
  const revision = input.revision ?? 1
  const snapshot = { subjectId: input.subjectId, roundId: input.roundId, immutableValue: `${input.id}-r${revision}` }
  const hash = jsonHash(snapshot)
  db.prepare(`INSERT INTO workflow_instances
    (id,contract_id,round_id,scope,subject_type,subject_id,status,current_revision,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(input.id, input.contractId, input.roundId, input.scope, input.type, input.subjectId, input.status ?? 'approved', revision, 'author', '2026-08-22T01:00:00.000Z')
  db.prepare(`INSERT INTO workflow_revisions
    (instance_id,revision,snapshot_json,snapshot_sha256,submitted_by,submitted_at) VALUES (?,?,?,?,?,?)`)
    .run(input.id, revision, JSON.stringify(snapshot), hash, 'author', '2026-08-22T01:00:00.000Z')
  return { id: input.id, revision, hash, snapshot }
}

type RoundFixtureOptions = {
  status?: string
  cancellationReason?: string | null
  sampling?: 'approved' | 'missing'
  quality?: 'approved' | 'missing'
  laboratory?: 'approved' | 'pending' | 'missing'
}

function addRound(db: DB, contractId: string, index: number, options: RoundFixtureOptions = {}) {
  const roundId = `${contractId}-R${String(index).padStart(2, '0')}`
  const sampleId = `S-${index}`
  const recordId = `REC-${index}`
  const status = options.status ?? 'done'
  db.prepare(`INSERT INTO rounds
    (id,contract_id,round_no,due_date,items,status,sampler,sampler_ids,assignment_status,created_at,sampled_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(roundId, contractId, index, `2026-${String(index).padStart(2, '0')}-10`, JSON.stringify([{ matrix: '废水', items: ['COD'], qty: 1 }]), status,
      status === 'cancelled' ? null : '赵采样', status === 'cancelled' ? '[]' : '["sampler-1"]', status === 'cancelled' ? 'revoked' : 'active',
      '2026-08-22T00:00:00.000Z', status === 'done' ? '2026-08-22T02:00:00.000Z' : null)
  db.prepare(`INSERT INTO audit_log(record_id,who,username,action,detail,at) VALUES (?,?,?,?,?,?)`)
    .run(roundId, '系统', null, status === 'cancelled' ? 'round_cancel' : 'round_sample',
      status === 'cancelled' ? JSON.stringify({ reason: options.cancellationReason === undefined ? '企业停产' : options.cancellationReason }) : '{}',
      '2026-08-22T02:00:00.000Z')
  if (status === 'cancelled') return { roundId, sampleId: null, recordId: null, sampling: null, quality: null, laboratory: null }

  db.prepare(`INSERT INTO samples
    (id,client,matrix,items,status,contract_id,round_id,source,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(sampleId, '归档测试厂', '废水', '["COD"]', 'done', contractId, roundId, 'field', '2026-08-22T02:00:00.000Z')
  db.prepare(`INSERT INTO handover_sheets
    (id,round_id,contract_id,source,sample_ids,detail,from_person,from_username,from_at,to_person,to_at,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`HS-${index}`, roundId, contractId, 'field', JSON.stringify([sampleId]), '[]', '赵采样', 'sampler-1',
      '2026-08-22T02:10:00.000Z', '钱收样', '2026-08-22T02:20:00.000Z', 'confirmed', '2026-08-22T02:00:00.000Z')
  db.prepare(`INSERT INTO sample_handovers
    (sample_id,action,from_person,to_person,condition,note,who,username,at,confirmed_by,confirmed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(sampleId, '采样交接', '赵采样', '钱收样', '完好', '', '赵采样', 'sampler-1',
      '2026-08-22T02:10:00.000Z', '钱收样', '2026-08-22T02:20:00.000Z')
  db.prepare(`INSERT INTO round_sheets
    (id,round_id,template_code,data,who,username,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run(`RS-${index}`, roundId, 'HJ-TC-136', JSON.stringify({ rows: [{ point: '总排口', temperature: 20 }] }),
      '赵采样', 'sampler-1', '2026-08-22T02:05:00.000Z')
  db.prepare(`INSERT INTO test_notices
    (id,sheet_id,round_id,contract_id,category,nature,source,sample_desc,groups_json,received_at,due_at,dept,
      issuer,issuer_username,status,issued_at,note,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`TZ-${index}`, `HS-${index}`, roundId, contractId, '废水', '自行监测', '现场采样', '1份水样',
      JSON.stringify([{ sampleId, analytes: ['COD'] }]), '2026-08-22T02:20:00.000Z', '2026-08-23', '环境室',
      '吴质控', 'qc-author', 'issued', '2026-08-22T02:30:00.000Z', '', '2026-08-22T02:25:00.000Z')
  db.prepare(`INSERT INTO test_tasks
    (sample_id,analyte,assignee,assignee_username,assigned_by,assigned_at) VALUES (?,?,?,?,?,?)`)
    .run(sampleId, 'COD', '王分析', 'lab-author', '吴质控', '2026-08-22T02:35:00.000Z')
  db.prepare(`INSERT INTO quality_plans
    (subject_id,round_id,batch_id,contract_id,requirements_json,adjustments_json,author_username,updated_at)
    VALUES (?,?,NULL,?,?,?,?,?)`)
    .run(roundId, roundId, contractId, '[{"qcType":"平行样","qty":1}]', '[]', 'qc-author', '2026-08-22T03:00:00.000Z')
  db.prepare(`INSERT INTO qc_records
    (qc_type,round_id,sample_id,analyte,data,unit,result,verdict,criterion,note,who,username,at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('平行样', roundId, sampleId, 'COD', JSON.stringify({ first: 20, second: 20.4 }), '%', 0.99,
      '合格', '相对偏差≤10%', '', '吴质控', 'qc-author', '2026-08-22T03:10:00.000Z')
  db.prepare(`INSERT INTO pretreatments
    (sample_id,method,reagent,condition,vol_final,note,who,username,at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(sampleId, '消解', '重铬酸钾', '165℃ 15min', '50mL', '', '王分析', 'lab-author', '2026-08-22T03:30:00.000Z')
  db.prepare(`INSERT INTO records
    (id,serial,sample_id,template_code,template_name,sheet_type,method,analyte,matrix,data,status,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(recordId, `JL-${index}`, sampleId, 'HJ-TC-103', 'COD记录', 'lab', '重铬酸盐法', 'COD', '废水',
      JSON.stringify({ rows: [], resultSummary: { analyte: 'COD', value: 20, unit: 'mg/L' } }),
      options.laboratory === 'pending' ? 'submitted' : 'approved', '2026-08-22T04:00:00.000Z')
  db.prepare(`INSERT INTO attachments
    (id,entity_type,entity_id,orig_name,stored_name,mime,size,who,username,at,content_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`ATT-R-${index}`, 'round', roundId, `round-${index}.jpg`, `round-${index}.jpg`, 'image/jpeg', 10, '赵采样', 'sampler-1', '2026-08-22T02:05:00.000Z', 'a'.repeat(64))
  db.prepare(`INSERT INTO attachments
    (id,entity_type,entity_id,orig_name,stored_name,mime,size,who,username,at,content_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`ATT-L-${index}`, 'record', recordId, `lab-${index}.pdf`, `lab-${index}.pdf`, 'application/pdf', 20, '分析员', 'lab-author', '2026-08-22T04:05:00.000Z', 'b'.repeat(64))
  db.prepare(`INSERT INTO audit_log(record_id,who,username,action,detail,at) VALUES (?,?,?,?,?,?)`)
    .run(recordId, '审核员', 'lab-approver', 'approve', '{"revision":1}', '2026-08-22T05:00:00.000Z')
  db.prepare(`INSERT INTO audit_log(record_id,who,username,action,detail,at) VALUES (?,?,?,?,?,?)`)
    .run('1', '其他模块管理员', 'unrelated-admin', 'unrelated_numeric_entity', '{}', '2026-08-22T05:10:00.000Z')

  const sampling = options.sampling === 'missing' ? null : addWorkflow(db, {
    id: `WF-S-${index}`, contractId, roundId, type: 'round_sampling', subjectId: roundId, scope: 'sampling',
  })
  const quality = options.quality === 'missing' ? null : addWorkflow(db, {
    id: `WF-Q-${index}`, contractId, roundId, type: 'quality_plan', subjectId: roundId, scope: 'quality',
  })
  const laboratory = options.laboratory === 'missing' ? null : addWorkflow(db, {
    id: `WF-L-${index}`, contractId, roundId, type: 'lab_record', subjectId: recordId, scope: 'laboratory',
    status: options.laboratory === 'pending' ? 'pending_review' : 'approved',
  })
  return { roundId, sampleId, recordId, sampling, quality, laboratory }
}

function project(options: RoundFixtureOptions[] = [{}]) {
  const db = openDb(':memory:')
  const contractId = 'WT2026-ARCHIVE'
  db.prepare(`INSERT INTO contracts
    (id,client,project,status,review_info,accepted_at,accepted_by,cycle_months,period_start,period_end,created_at,
      tech_approved_by,tech_approved_at,tech_approve_note,tech_review_result)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(contractId, '归档测试厂', '版本化归档', 'confirmed', '{"ability":"具备"}', '2026-08-21T01:00:00.000Z', '登记员', 1,
      '2026-01-01', '2026-12-31', '2026-08-21T00:00:00.000Z', '技术负责人', '2026-08-21T02:00:00.000Z', '同意', 'approve')
  db.prepare(`INSERT INTO schemes
    (id,contract_id,points,limits,cycle_months,period_start,period_end,status,reviewer,reviewed_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('FA2026-ARCHIVE', contractId, '[{"point":"总排口","items":["COD"]}]', '[]', 1, '2026-01-01', '2026-12-31',
      'approved', '方案审核员', '2026-08-21T03:00:00.000Z', '2026-08-21T00:30:00.000Z')
  for (const [scope, reviewer, approver] of [
    ['sampling', 'sample-review', 'sample-approve'],
    ['quality', 'quality-review', 'quality-approve'],
    ['laboratory', 'lab-review', 'lab-approve'],
  ]) {
    db.prepare(`INSERT INTO project_stage_assignments
      (contract_id,scope,reviewer_username,approver_username,active,reason,assigned_by,assigned_at)
      VALUES (?,?,?,?,1,?,?,?)`)
      .run(contractId, scope, reviewer, approver, 'project fixture', 'planner-1', '2026-08-21T04:00:00.000Z')
  }
  db.prepare(`INSERT INTO audit_log(record_id,who,username,action,detail,at) VALUES (?,?,?,?,?,?)`)
    .run(contractId, '技术负责人', 'tech-1', 'contract_tech_review', '{"decision":"approve"}', '2026-08-21T02:00:00.000Z')
  const rounds = options.map((roundOptions, index) => addRound(db, contractId, index + 1, roundOptions))
  return { db, contractId, rounds }
}

function addQcLaboratoryRecord(db: DB, contractId: string, roundId: string, suffix: string, status: 'approved' | 'pending' | 'missing') {
  const sampleId = `Q-${suffix}`, recordId = `QC-REC-${suffix}`
  db.prepare(`INSERT INTO samples
    (id,client,matrix,items,status,contract_id,round_id,source,qc_type,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(sampleId, '归档测试厂', '废水', '["COD"]', 'done', contractId, roundId, 'field', '现场平行', '2026-08-22T02:00:00.000Z')
  db.prepare(`INSERT INTO records
    (id,serial,sample_id,template_code,template_name,sheet_type,method,analyte,matrix,data,status,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(recordId, `QC-JL-${suffix}`, sampleId, `HJ-TC-QC-${suffix}`, '质控记录', 'lab', '重铬酸盐法', 'COD', '废水',
      JSON.stringify({ rows: [], resultSummary: { analyte: 'COD', value: 21, unit: 'mg/L' } }),
      status === 'pending' ? 'submitted' : 'approved', '2026-08-22T04:00:00.000Z')
  const workflow = status === 'missing' ? null : addWorkflow(db, {
    id: `WF-QC-${suffix}`, contractId, roundId, type: 'lab_record', subjectId: recordId, scope: 'laboratory',
    status: status === 'pending' ? 'pending_review' : 'approved',
  })
  return { sampleId, recordId, workflow }
}

test('单期项目齐备时可归档，并以工作流实例、版本和原始哈希固化完整证据清单', () => {
  const { db, contractId, rounds } = project()
  const readiness = archiveReadiness(db, { contractId })
  assert.equal(readiness.ready, true)
  assert.deepEqual(readiness.roundIds, [rounds[0].roundId])
  assert.deepEqual(readiness.issues, [])

  const archive = buildArchivePackage(db, { contractId }, archivist)
  assert.equal(archive.status, 'ready')
  assert.equal(archive.version, 1)
  const types = new Set(archive.items.map(item => item.entity_type))
  for (const required of [
    'contract', 'contract_review', 'scheme', 'assignment', 'round', 'sampling_workflow', 'handover_sheet',
    'round_sheet', 'sample', 'sample_handover', 'test_notice', 'test_task', 'quality_plan_workflow',
    'qc_record', 'pretreatment', 'lab_record_workflow', 'attachment', 'audit_entry',
  ]) assert.ok(types.has(required), `归档清单应包含 ${required}`)
  const sampling = archive.items.find(item => item.entity_type === 'sampling_workflow')!
  assert.ok(archive.items.some(item => item.entity_type === 'assignment' && item.label === '采样专业复核/审核指派'))
  assert.ok(archive.items.some(item => item.entity_type === 'assignment' && item.label === '质控专业复核/审核指派'))
  assert.ok(archive.items.some(item => item.entity_type === 'assignment' && item.label === '实验室分析专业复核/审核指派'))
  assert.ok(archive.items.some(item => item.entity_type === 'audit_entry' && item.label === `技术合同评审 · ${contractId}`))
  assert.ok(archive.items.some(item => item.entity_type === 'audit_entry' && item.label === `现场采样完成 · ${rounds[0].roundId}`))
  assert.ok(archive.items.some(item => item.entity_type === 'audit_entry' && item.label === `审核通过 · ${rounds[0].recordId}`))
  assert.equal(archive.items.some(item => item.entity_type === 'audit_entry'
    && (item.metadata.snapshot as any)?.action === 'unrelated_numeric_entity'), false)
  assert.deepEqual(
    { instance: sampling.workflow_instance_id, revision: sampling.revision, hash: sampling.content_hash },
    { instance: rounds[0].sampling!.id, revision: rounds[0].sampling!.revision, hash: rounds[0].sampling!.hash },
  )
})

test('默认项目归档等待所有非取消期次；取消期次不再阻塞', () => {
  const incomplete = project([{}, { status: 'pending', sampling: 'missing', quality: 'missing', laboratory: 'missing' }])
  const waiting = archiveReadiness(incomplete.db, { contractId: incomplete.contractId })
  assert.equal(waiting.ready, false)
  assert.ok(waiting.issues.some(issue => issue.roundId === incomplete.rounds[1].roundId && issue.code === 'ROUND_NOT_COMPLETE'))

  const cancelled = project([{}, { status: 'cancelled' }])
  const ready = archiveReadiness(cancelled.db, { contractId: cancelled.contractId })
  assert.equal(ready.ready, true)
  assert.deepEqual(ready.roundIds, [cancelled.rounds[0].roundId])

  const cancellationBatch = createReportBatch(cancelled.db, {
    contractId: cancelled.contractId, name: '终止期次留证', roundIds: [cancelled.rounds[1].roundId],
  }, planner)
  const cancellationEvidence = archiveReadiness(cancelled.db, { reportBatchId: cancellationBatch.id })
  assert.equal(cancellationEvidence.ready, true)
  assert.deepEqual(cancellationEvidence.roundIds, [cancelled.rounds[1].roundId])
  const cancellationArchive = buildArchivePackage(cancelled.db, { reportBatchId: cancellationBatch.id }, archivist)
  const cancellationRound = cancellationArchive.items.find(item => item.entity_type === 'round' && item.entity_id === cancelled.rounds[1].roundId)!
  assert.equal((cancellationRound.metadata.snapshot as any).status, 'cancelled')
  const cancellationAudit = cancellationArchive.items.find(item => item.entity_type === 'audit_entry' && (item.metadata.snapshot as any).action === 'round_cancel')!
  assert.equal(JSON.parse((cancellationAudit.metadata.snapshot as any).detail).reason, '企业停产')

  const missingReason = project([{}, { status: 'cancelled', cancellationReason: '' }])
  const missingReasonBatch = createReportBatch(missingReason.db, {
    contractId: missingReason.contractId, name: '缺原因', roundIds: [missingReason.rounds[1].roundId],
  }, planner)
  assert.ok(archiveReadiness(missingReason.db, { reportBatchId: missingReasonBatch.id }).issues
    .some(issue => issue.code === 'CANCELLATION_EVIDENCE_INVALID' && issue.roundId === missingReason.rounds[1].roundId))

  const missingAudit = project([{}, { status: 'cancelled' }])
  missingAudit.db.prepare(`DELETE FROM audit_log WHERE record_id=? AND action='round_cancel'`).run(missingAudit.rounds[1].roundId)
  const missingAuditBatch = createReportBatch(missingAudit.db, {
    contractId: missingAudit.contractId, name: '缺留痕', roundIds: [missingAudit.rounds[1].roundId],
  }, planner)
  assert.ok(archiveReadiness(missingAudit.db, { reportBatchId: missingAuditBatch.id }).issues
    .some(issue => issue.code === 'CANCELLATION_EVIDENCE_INVALID' && issue.roundId === missingAudit.rounds[1].roundId))
})

test('预定义报告批次只等待显式附加的期次', () => {
  const { db, contractId, rounds } = project([{}, { status: 'pending', sampling: 'missing', quality: 'missing', laboratory: 'missing' }])
  assert.equal(archiveReadiness(db, { contractId }).ready, false)
  const batch = createReportBatch(db, { contractId, name: '第一批报告', roundIds: [rounds[0].roundId] }, planner)
  assert.deepEqual(batch.round_ids, [rounds[0].roundId])
  const scoped = archiveReadiness(db, { reportBatchId: batch.id })
  assert.equal(scoped.ready, true)
  assert.deepEqual(scoped.roundIds, [rounds[0].roundId])
  const archive = buildArchivePackage(db, { reportBatchId: batch.id }, archivist)
  assert.equal(archive.report_batch_id, batch.id)
  assert.equal(archive.status, 'ready')
})

test('采样、质量安排或任一实验室记录未批准时分别关闭归档门禁', () => {
  const sampling = project([{ sampling: 'missing' }])
  assert.ok(archiveReadiness(sampling.db, { contractId: sampling.contractId }).issues
    .some(issue => issue.code === 'SAMPLING_NOT_APPROVED'))

  const quality = project([{ quality: 'missing' }])
  assert.ok(archiveReadiness(quality.db, { contractId: quality.contractId }).issues
    .some(issue => issue.code === 'QUALITY_PLAN_NOT_APPROVED'))

  const laboratory = project([{ laboratory: 'pending' }])
  assert.ok(archiveReadiness(laboratory.db, { contractId: laboratory.contractId }).issues
    .some(issue => issue.code === 'LAB_RECORD_NOT_APPROVED' && issue.entityId === laboratory.rounds[0].recordId))

  const attachment = project()
  attachment.db.prepare(`UPDATE attachments SET content_hash=NULL WHERE id='ATT-L-1'`).run()
  assert.ok(archiveReadiness(attachment.db, { contractId: attachment.contractId }).issues
    .some(issue => issue.code === 'ATTACHMENT_HASH_INVALID' && issue.entityId === 'ATT-L-1'))
})

test('归档就绪要求采样、质量和实验室都有当前有效指派，但不提前要求报告指派', () => {
  const missing = project()
  missing.db.prepare(`DELETE FROM project_stage_assignments WHERE contract_id=? AND scope='sampling'`).run(missing.contractId)
  const missingState = archiveReadiness(missing.db, { contractId: missing.contractId })
  assert.ok(missingState.issues.some(issue => issue.code === 'ASSIGNMENT_NOT_ACTIVE' && issue.entityId === 'sampling'))

  const inactive = project()
  inactive.db.prepare(`UPDATE project_stage_assignments SET active=0 WHERE contract_id=? AND scope IN ('quality','laboratory')`).run(inactive.contractId)
  const inactiveState = archiveReadiness(inactive.db, { contractId: inactive.contractId })
  assert.ok(inactiveState.issues.some(issue => issue.code === 'ASSIGNMENT_NOT_ACTIVE' && issue.entityId === 'quality'))
  assert.ok(inactiveState.issues.some(issue => issue.code === 'ASSIGNMENT_NOT_ACTIVE' && issue.entityId === 'laboratory'))
  assert.ok(!inactiveState.issues.some(issue => issue.entityId === 'report'))
  const draft = buildArchivePackage(inactive.db, { contractId: inactive.contractId }, archivist)
  assert.equal(draft.status, 'draft')
  const assignmentHistory = draft.items.filter(item => item.entity_type === 'assignment')
  assert.equal(assignmentHistory.length, 3)
  assert.equal(assignmentHistory.filter(item => !(item.metadata.snapshot as any).active).length, 2)
})

test('质控样实验室记录也必须逐条批准并进入精确版本清单', () => {
  const pending = project()
  const pendingQc = addQcLaboratoryRecord(pending.db, pending.contractId, pending.rounds[0].roundId, 'PENDING', 'pending')
  assert.ok(archiveReadiness(pending.db, { contractId: pending.contractId }).issues
    .some(issue => issue.code === 'LAB_RECORD_NOT_APPROVED' && issue.entityId === pendingQc.recordId))

  const missing = project()
  const missingQc = addQcLaboratoryRecord(missing.db, missing.contractId, missing.rounds[0].roundId, 'MISSING', 'missing')
  assert.ok(archiveReadiness(missing.db, { contractId: missing.contractId }).issues
    .some(issue => issue.code === 'LAB_RECORD_NOT_APPROVED' && issue.entityId === missingQc.recordId))

  const approved = project()
  const approvedQc = addQcLaboratoryRecord(approved.db, approved.contractId, approved.rounds[0].roundId, 'APPROVED', 'approved')
  const archive = buildArchivePackage(approved.db, { contractId: approved.contractId }, archivist)
  assert.equal(archive.status, 'ready')
  assert.ok(archive.items.some(item => item.entity_type === 'lab_record_workflow' &&
    item.entity_id === approvedQc.recordId && item.workflow_instance_id === approvedQc.workflow!.id))
})

test('归档员确认后版本不可改，旧版本永久保留', () => {
  const { db, contractId } = project()
  const first = buildArchivePackage(db, { contractId }, archivist)
  assert.throws(() => confirmArchivePackage(db, first.id, editor), /归档员/)
  const confirmed = confirmArchivePackage(db, first.id, archivist)
  assert.equal(confirmed.status, 'confirmed')
  assert.equal(confirmed.confirmed_by, archivist.username)
  assert.ok(confirmed.confirmed_at)
  assert.throws(() => db.prepare(`INSERT INTO archive_items
    (archive_package_id,item_order,entity_type,entity_id,content_hash,label,metadata_json) VALUES (?,?,?,?,?,?,?)`)
    .run(first.id, 999, 'audit_entry', 'late', 'c'.repeat(64), 'late append', '{}'), /immutable|不可追加|已确认/)
  assert.throws(() => db.prepare(`UPDATE archive_items SET label='篡改' WHERE archive_package_id=?`).run(first.id), /immutable|不可修改/)
  assert.throws(() => db.prepare(`DELETE FROM archive_items WHERE archive_package_id=?`).run(first.id), /immutable|不可删除/)
  assert.throws(() => db.prepare(`UPDATE archive_packages SET invalidation_reason='伪造失效原因' WHERE id=?`).run(first.id), /immutable|不可修改/)

  const second = buildArchivePackage(db, { contractId }, archivist)
  assert.equal(second.version, 2)
  confirmArchivePackage(db, second.id, archivist)
  const versions = db.prepare(`SELECT id,version,status FROM archive_packages WHERE contract_id=? ORDER BY version`).all(contractId) as any[]
  assert.deepEqual(versions.map(row => row.version), [1, 2])
  assert.deepEqual(versions.map(row => row.status), ['confirmed', 'confirmed'])
  assert.equal(getArchivePackage(db, first.id)!.items.length, first.items.length)
})

test('确认前按持久化条目重算清单哈希，拒绝追加或包头哈希篡改', () => {
  const appended = project()
  const appendedArchive = buildArchivePackage(appended.db, { contractId: appended.contractId }, archivist)
  appended.db.prepare(`INSERT INTO archive_items
    (archive_package_id,item_order,entity_type,entity_id,content_hash,label,metadata_json) VALUES (?,?,?,?,?,?,?)`)
    .run(appendedArchive.id, 999, 'audit_entry', 'unexpected', 'c'.repeat(64), 'unexpected', '{}')
  assert.throws(() => confirmArchivePackage(appended.db, appendedArchive.id, archivist), /清单|哈希|篡改/)

  const header = project()
  const headerArchive = buildArchivePackage(header.db, { contractId: header.contractId }, archivist)
  header.db.prepare(`UPDATE archive_packages SET manifest_sha256=? WHERE id=?`).run('d'.repeat(64), headerArchive.id)
  assert.throws(() => confirmArchivePackage(header.db, headerArchive.id, archivist), /清单|哈希|篡改/)
})

test('附件按实体类型和真实项目关系归档，不因跨合同数字 ID 碰撞串入', () => {
  const fixture = project()
  fixture.db.prepare(`INSERT INTO contracts(id,client,status,created_at) VALUES ('WT-FOREIGN','外部项目','confirmed','2026-08-22T00:00:00.000Z')`).run()
  fixture.db.prepare(`INSERT INTO samples(id,client,matrix,items,status,contract_id,round_id,source,created_at)
    VALUES ('FOREIGN-S','外部项目','废水','["COD"]','done','WT-FOREIGN',?,'field','2026-08-22T00:00:00.000Z')`)
    .run(fixture.rounds[0].roundId)
  fixture.db.prepare(`INSERT INTO records(id,sample_id,template_code,data,status,updated_at)
    VALUES ('1','FOREIGN-S','FOREIGN','{}','approved','2026-08-22T00:00:00.000Z')`).run()
  fixture.db.prepare(`INSERT INTO attachments
    (id,entity_type,entity_id,orig_name,stored_name,mime,size,who,at,content_hash)
    VALUES ('ATT-FOREIGN','record','1','foreign.pdf','foreign.pdf','application/pdf',20,'外部人员','2026-08-22T00:00:00.000Z',?)`)
    .run('c'.repeat(64))
  assert.equal(archiveReadiness(fixture.db, { contractId: fixture.contractId }).ready, true)
  const archive = buildArchivePackage(fixture.db, { contractId: fixture.contractId }, archivist)
  assert.ok(!archive.items.some(item => item.entity_type === 'attachment' && item.entity_id === 'ATT-FOREIGN'))
})

test('报告归档校验要求正确项目/期次及每条实验室记录的精确批准版本', () => {
  const fixture = project()
  const archive = confirmArchivePackage(fixture.db, buildArchivePackage(fixture.db, { contractId: fixture.contractId }, archivist).id, archivist)
  assert.equal(assertConfirmedArchiveForReport(fixture.db, archive.id, {
    contractId: fixture.contractId, roundId: fixture.rounds[0].roundId, recordIds: [fixture.rounds[0].recordId!],
  }).id, archive.id)
  assert.throws(() => assertConfirmedArchiveForReport(fixture.db, archive.id), /合同.*期次|验证范围|记录范围/)
  assert.throws(() => assertConfirmedArchiveForReport(fixture.db, archive.id, {
    contractId: fixture.contractId, roundId: fixture.rounds[0].roundId,
  }), /实验室记录|记录范围/)
  assert.throws(() => assertConfirmedArchiveForReport(fixture.db, archive.id, {
    contractId: fixture.contractId, roundId: fixture.rounds[0].roundId, recordIds: [],
  }), /实验室记录|记录范围/)
  assert.throws(() => assertConfirmedArchiveForReport(fixture.db, archive.id, {
    contractId: 'WT-WRONG', roundId: fixture.rounds[0].roundId, recordIds: [fixture.rounds[0].recordId!],
  }), /合同|项目/)
  assert.throws(() => assertConfirmedArchiveForReport(fixture.db, archive.id, {
    contractId: fixture.contractId, roundId: 'WRONG-ROUND', recordIds: [fixture.rounds[0].recordId!],
  }), /期次/)

  fixture.db.prepare(`INSERT INTO archive_packages
    (id,contract_id,version,status,manifest_sha256,readiness_json,created_by,created_at,confirmed_by,confirmed_at)
    VALUES ('ARCHIVE-EMPTY',?,99,'confirmed',?,?,?,?,'archive-user','2026-08-22T06:00:00.000Z')`)
    .run(fixture.contractId, jsonHash([]), JSON.stringify({ ready: true, contractId: fixture.contractId, reportBatchId: null, roundIds: [fixture.rounds[0].roundId], issues: [] }), 'manual', '2026-08-22T05:00:00.000Z')
  assert.throws(() => assertConfirmedArchiveForReport(fixture.db, 'ARCHIVE-EMPTY', {
    contractId: fixture.contractId, roundId: fixture.rounds[0].roundId, recordIds: [fixture.rounds[0].recordId!],
  }), /实验室记录|归档条目|清单/)
})

test('撤回只失效含精确工作流版本的归档，并阻断草稿/已审核报告而保留已签发报告', () => {
  const { db, contractId, rounds } = project()
  const first = confirmArchivePackage(db, buildArchivePackage(db, { contractId }, archivist).id, archivist)
  const workflow = rounds[0].laboratory!
  for (const [id, status] of [['R-DRAFT', 'draft'], ['R-CHECKED', 'checked'], ['R-ISSUED', 'issued']] as const) {
    db.prepare(`INSERT INTO reports
      (id,contract_id,client,title,conclusion,data,status,archive_package_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, contractId, '归档测试厂', id, '', '{}', status, first.id, '2026-08-22T06:00:00.000Z')
  }

  const unrelated = invalidateAffectedArchives(db, 'WF-NOT-IN-PACKAGE', 1, '不相关撤回', editor)
  assert.equal(unrelated.invalidatedArchiveIds.length, 0)
  assert.equal(getArchivePackage(db, first.id)!.status, 'confirmed')

  const invalidated = invalidateAffectedArchives(db, workflow.id, workflow.revision, '原始记录撤回', editor)
  assert.deepEqual(invalidated.invalidatedArchiveIds, [first.id])
  assert.deepEqual(invalidated.blockedReportIds.sort(), ['R-CHECKED', 'R-DRAFT'])
  assert.deepEqual(invalidated.reissueRequiredReportIds, ['R-ISSUED'])
  assert.equal(getArchivePackage(db, first.id)!.status, 'invalidated')
  assert.throws(() => db.prepare(`INSERT INTO archive_items
    (archive_package_id,item_order,entity_type,entity_id,content_hash,label,metadata_json) VALUES (?,?,?,?,?,?,?)`)
    .run(first.id, 999, 'audit_entry', 'late-invalidated', 'c'.repeat(64), 'late invalidated append', '{}'), /immutable|不可追加|已失效/)
  assert.throws(() => assertConfirmedArchiveForReport(db, first.id), /失效|确认/)
  const draft = db.prepare(`SELECT * FROM reports WHERE id='R-DRAFT'`).get() as any
  const issued = db.prepare(`SELECT * FROM reports WHERE id='R-ISSUED'`).get() as any
  assert.ok(draft.archive_blocked_at)
  assert.equal(issued.status, 'issued')
  assert.equal(issued.archive_requires_reissue, 1)

  const revision2 = 2
  const snapshot2 = { subjectId: rounds[0].recordId, roundId: rounds[0].roundId, immutableValue: `${workflow.id}-r2` }
  db.prepare(`INSERT INTO workflow_revisions
    (instance_id,revision,snapshot_json,snapshot_sha256,submitted_by,submitted_at) VALUES (?,?,?,?,?,?)`)
    .run(workflow.id, revision2, JSON.stringify(snapshot2), jsonHash(snapshot2), 'author', '2026-08-22T07:00:00.000Z')
  db.prepare(`UPDATE workflow_instances SET status='approved',current_revision=? WHERE id=?`).run(revision2, workflow.id)
  const second = confirmArchivePackage(db, buildArchivePackage(db, { contractId }, archivist).id, archivist)
  assert.equal(second.version, 2)
  assert.ok(second.items.some(item => item.workflow_instance_id === workflow.id && item.revision === 2))
  invalidateAffectedArchives(db, workflow.id, 1, '重复通知', editor)
  assert.equal(getArchivePackage(db, second.id)!.status, 'confirmed')
})
