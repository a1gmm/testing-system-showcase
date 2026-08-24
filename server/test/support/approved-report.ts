import { createHash, randomUUID } from 'node:crypto'
import type { DB } from '../../src/db.ts'
import {
  createUser,
  generateContractReport,
  generateReport,
  generateRoundReport,
  getReport,
  issueReport,
  submitReportWorkflow,
  type Report,
  type User,
} from '../../src/handlers.ts'
import { confirmArchivePackage } from '../../src/archivePackages.ts'
import { assignProjectReviewers, getProjectAssignment, setUserQualifications } from '../../src/qualifications.ts'
import { decideWorkflow, getWorkflowView } from '../../src/workflow.ts'

export const reportTestActors = {
  author: { username: '__test_report_author__', name: '测试报告编制', roles: ['report_editor'], status: 'active', created_at: '', must_change_pw: false } as User,
  reviewer: { username: '__test_report_reviewer__', name: '测试报告复核', roles: [], status: 'active', created_at: '', must_change_pw: false } as User,
  approver: { username: '__test_report_approver__', name: '测试报告审核', roles: [], status: 'active', created_at: '', must_change_pw: false } as User,
  signer: { username: '__test_report_signer__', name: '测试授权签字', roles: ['signer'], status: 'active', created_at: '', must_change_pw: false } as User,
  archivist: { username: '__test_archivist__', name: '测试归档员', roles: ['archivist'], status: 'active', created_at: '', must_change_pw: false } as User,
}

const admin = { username: '__test_admin__', name: '测试管理员', roles: ['admin'], status: 'active', created_at: '', must_change_pw: false } as User
const planner = { username: '__test_planner__', name: '测试计划员', roles: ['planner'], status: 'active', created_at: '', must_change_pw: false } as User

function ensureUser(db: DB, user: User) {
  if (!db.prepare(`SELECT 1 FROM users WHERE username=?`).get(user.username)) {
    createUser(db, { username: user.username, name: user.name, roles: user.roles, password: 'test-only-secret' })
  }
}

function canonicalJson(value: unknown): string {
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
function hash(value: string) { return createHash('sha256').update(value).digest('hex') }

function ensureRoundForSample(db: DB, sampleId: string) {
  const sample = db.prepare(`SELECT contract_id,round_id FROM samples WHERE id=?`).get(sampleId) as any
  if (!sample?.contract_id) throw new Error('测试项目报告要求样品关联合同')
  if (sample.round_id) return String(sample.round_id)
  const roundId = `__REPORT_TEST_ROUND__${sample.contract_id}`
  if (!db.prepare(`SELECT 1 FROM rounds WHERE id=?`).get(roundId)) {
    const next = Number((db.prepare(`SELECT COALESCE(MAX(round_no),0)+1 n FROM rounds WHERE contract_id=?`).get(sample.contract_id) as any).n)
    db.prepare(`INSERT INTO rounds(id,contract_id,round_no,due_date,items,status,created_at,sampled_at)
      VALUES (?,?,?,?,?,'done',?,?)`).run(
      roundId, sample.contract_id, next, '2026-08-22', '[]', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z',
    )
  }
  db.prepare(`UPDATE samples SET round_id=? WHERE id=?`).run(roundId, sampleId)
  return roundId
}

export function prepareReportTestActors(db: DB, contractId: string) {
  for (const user of Object.values(reportTestActors)) ensureUser(db, user)
  setUserQualifications(db, reportTestActors.reviewer.username, ['report_review'], admin)
  setUserQualifications(db, reportTestActors.approver.username, ['report_approve'], admin)
  const current = getProjectAssignment(db, contractId, 'report')
  assignProjectReviewers(
    db,
    contractId,
    'report',
    reportTestActors.reviewer.username,
    reportTestActors.approver.username,
    planner,
    current && (current.reviewer_username !== reportTestActors.reviewer.username || current.approver_username !== reportTestActors.approver.username)
      ? '测试切换到固定报告审核人'
      : undefined,
  )
}

/** Build a minimal immutable report archive around already-approved production workflows. */
export function confirmReportTestArchive(db: DB, contractId: string, roundIds: string[]) {
  prepareReportTestActors(db, contractId)
  const uniqueRounds = [...new Set(roundIds)]
  const version = Number((db.prepare(`SELECT COALESCE(MAX(version),0)+1 version FROM archive_packages WHERE contract_id=? AND report_batch_id IS NULL`)
    .get(contractId) as any).version)
  const packageId = randomUUID()
  const readiness = { ready: true, contractId, reportBatchId: null, roundIds: uniqueRounds, issues: [] }
  db.prepare(`INSERT INTO archive_packages
    (id,contract_id,version,status,manifest_sha256,readiness_json,created_by,created_at)
    VALUES (?,?,?,'ready',?,?,?,?)`).run(
    packageId, contractId, version, '0'.repeat(64), canonicalJson(readiness), reportTestActors.archivist.username, new Date().toISOString(),
  )
  const items: { entityType: string; entityId: string; workflowInstanceId: string | null; revision: number | null; contentHash: string }[] = [
    { entityType: 'contract', entityId: contractId, workflowInstanceId: null, revision: null, contentHash: hash(`contract:${contractId}`) },
  ]
  for (const roundId of uniqueRounds) {
    items.push({ entityType: 'round', entityId: roundId, workflowInstanceId: null, revision: null, contentHash: hash(`round:${roundId}`) })
    const records = db.prepare(`SELECT r.id FROM records r JOIN samples s ON s.id=r.sample_id WHERE s.round_id=? ORDER BY r.id`).all(roundId) as { id: string }[]
    for (const record of records) {
      const workflow = getWorkflowView(db, 'lab_record', record.id)
      if (!workflow || workflow.status !== 'approved') continue
      const revision = workflow.revisions.find(item => item.revision === workflow.current_revision)!
      items.push({
        entityType: 'lab_record_workflow', entityId: record.id, workflowInstanceId: workflow.id,
        revision: workflow.current_revision, contentHash: revision.snapshot_sha256,
      })
    }
  }
  items.forEach((item, index) => db.prepare(`INSERT INTO archive_items
    (archive_package_id,item_order,entity_type,entity_id,workflow_instance_id,revision,content_hash,label,metadata_json)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    packageId, index + 1, item.entityType, item.entityId, item.workflowInstanceId, item.revision,
    item.contentHash, `${item.entityType}:${item.entityId}`, '{}',
  ))
  const manifest = items.map((item, index) => ({ order: index + 1, ...item }))
  db.prepare(`UPDATE archive_packages SET manifest_sha256=? WHERE id=?`).run(hash(canonicalJson(manifest)), packageId)
  return confirmArchivePackage(db, packageId, reportTestActors.archivist)
}

export function generateTestSampleReport(db: DB, sampleId: string, year = 2026): Report {
  const roundId = ensureRoundForSample(db, sampleId)
  const contractId = (db.prepare(`SELECT contract_id FROM samples WHERE id=?`).get(sampleId) as any).contract_id as string
  const archive = confirmReportTestArchive(db, contractId, [roundId])
  return generateReport(db, sampleId, year, reportTestActors.author.name, reportTestActors.author.username, archive.id)
}

export function generateTestRoundReport(db: DB, roundId: string, year = 2026): Report {
  const contractId = (db.prepare(`SELECT contract_id FROM rounds WHERE id=?`).get(roundId) as any)?.contract_id as string
  if (!contractId) throw new Error('测试期次报告找不到合同')
  const archive = confirmReportTestArchive(db, contractId, [roundId])
  return generateRoundReport(db, roundId, year, reportTestActors.author.name, reportTestActors.author.username, archive.id)
}

export function generateTestContractReport(db: DB, contractId: string, year = 2026): Report {
  const roundIds = (db.prepare(`SELECT id FROM rounds WHERE contract_id=? AND status<>'cancelled' ORDER BY round_no,id`)
    .all(contractId) as { id: string }[]).map(round => round.id)
  const existing = db.prepare(`SELECT id,readiness_json FROM archive_packages
    WHERE contract_id=? AND report_batch_id IS NULL AND status='confirmed' ORDER BY version DESC LIMIT 1`).get(contractId) as any
  const existingRoundIds = existing ? JSON.parse(existing.readiness_json || '{}').roundIds ?? [] : []
  const sameScope = existingRoundIds.length === roundIds.length && roundIds.every((id, index) => id === existingRoundIds[index])
  const archive = sameScope ? { id: String(existing.id) } : confirmReportTestArchive(db, contractId, roundIds)
  return generateContractReport(
    db, contractId, reportTestActors.author.name, year, reportTestActors.author.username, archive.id,
  )
}

export function approveTestReport(db: DB, reportId: string): Report {
  let workflow = getWorkflowView(db, 'report', reportId)
  if (!workflow) workflow = getWorkflowView(db, 'report', submitReportWorkflow(db, reportId, reportTestActors.author).subject_id)
  if (!workflow) throw new Error('测试报告工作流创建失败')
  if (workflow.status === 'pending_review') {
    decideWorkflow(db, workflow.id, workflow.current_revision, 'review', 'approve', '', reportTestActors.reviewer)
  }
  workflow = getWorkflowView(db, 'report', reportId)!
  if (workflow.status === 'pending_approval') {
    decideWorkflow(db, workflow.id, workflow.current_revision, 'approve', 'approve', '', reportTestActors.approver)
  }
  db.prepare(`UPDATE reports SET status='checked',checker=?,checker_username=?,checked_at=? WHERE id=?`).run(
    reportTestActors.approver.name, reportTestActors.approver.username, new Date().toISOString(), reportId,
  )
  return getReport(db, reportId)!
}

export function issueTestReport(db: DB, reportId: string): Report {
  approveTestReport(db, reportId)
  return issueReport(db, reportId, reportTestActors.signer.name, reportTestActors.signer.username)
}
