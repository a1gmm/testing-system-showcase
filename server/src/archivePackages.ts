import { createHash, randomUUID } from 'node:crypto'
import type { DB } from './db.ts'
import type { User } from './handlers.ts'

export type ArchiveStatus = 'draft' | 'ready' | 'confirmed' | 'invalidated'
export type ArchiveIssue = {
  code: string
  message: string
  roundId?: string
  entityId?: string
}
export type ArchiveReadiness = {
  ready: boolean
  contractId: string
  reportBatchId: string | null
  roundIds: string[]
  issues: ArchiveIssue[]
}
export type ArchiveItem = {
  id: number
  archive_package_id: string
  item_order: number
  entity_type: string
  entity_id: string
  workflow_instance_id: string | null
  revision: number | null
  content_hash: string
  label: string
  metadata: Record<string, unknown>
}
export type ArchivePackage = {
  id: string
  contract_id: string
  report_batch_id: string | null
  version: number
  status: ArchiveStatus
  manifest_sha256: string
  readiness: ArchiveReadiness
  created_by: string
  created_at: string
  confirmed_by: string | null
  confirmed_at: string | null
  invalidated_by: string | null
  invalidated_at: string | null
  invalidation_reason: string | null
  items: ArchiveItem[]
}
export type ReportBatch = {
  id: string
  contract_id: string
  name: string
  created_by: string
  created_at: string
  round_ids: string[]
}

type ArchiveScope = { contractId?: string; reportBatchId?: string }
type WorkflowEvidence = {
  id: string
  subject_type: string
  subject_id: string
  current_revision: number
  snapshot_json: string
  snapshot_sha256: string
  submitted_by: string
  submitted_at: string
}
type ItemDraft = Omit<ArchiveItem, 'id' | 'archive_package_id' | 'item_order'>

let savepointSequence = 0
function transaction<T>(db: DB, operation: () => T): T {
  const savepoint = `archive_${++savepointSequence}`
  db.exec(`SAVEPOINT ${savepoint}`)
  try {
    const result = operation()
    db.exec(`RELEASE ${savepoint}`)
    return result
  } catch (error) {
    db.exec(`ROLLBACK TO ${savepoint}`)
    db.exec(`RELEASE ${savepoint}`)
    throw error
  }
}
function now() { return new Date().toISOString() }
function required(value: unknown, label: string) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`${label}必填`)
  return text
}
function parseJson<T>(value: unknown, fallback: T): T {
  if (value && typeof value === 'object') return value as T
  try { return JSON.parse(String(value)) as T } catch { return fallback }
}
function stableJson(value: unknown): string {
  const normalise = (current: unknown): unknown => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error('归档快照包含无效数字')
      return current
    }
    if (Array.isArray(current)) return current.map(normalise)
    if (typeof current === 'object') {
      const result: Record<string, unknown> = {}
      for (const key of Object.keys(current as Record<string, unknown>).sort()) {
        result[key] = normalise((current as Record<string, unknown>)[key])
      }
      return result
    }
    if (current === undefined) return null
    throw new Error('归档快照必须是 JSON 数据')
  }
  return JSON.stringify(normalise(value))
}
function sha256(value: string) { return createHash('sha256').update(value).digest('hex') }
function snapshotHash(value: unknown) { return sha256(stableJson(value)) }
function isSha256(value: unknown): value is string { return /^[a-f0-9]{64}$/.test(String(value ?? '')) }
function manifestEntry(item: Pick<ArchiveItem, 'item_order' | 'entity_type' | 'entity_id' | 'workflow_instance_id' | 'revision' | 'content_hash'>) {
  return {
    order: Number(item.item_order), entityType: item.entity_type, entityId: item.entity_id,
    workflowInstanceId: item.workflow_instance_id, revision: item.revision, contentHash: item.content_hash,
  }
}
function persistedManifestHash(db: DB, archivePackageId: string) {
  const rows = db.prepare(`SELECT item_order,entity_type,entity_id,workflow_instance_id,revision,content_hash
    FROM archive_items WHERE archive_package_id=? ORDER BY item_order`).all(archivePackageId) as any[]
  return snapshotHash(rows.map(row => manifestEntry({ ...row, revision: row.revision === null ? null : Number(row.revision) })))
}
function attachmentKey(entityType: string, entityId: string | number) { return `${entityType}\u0000${entityId}` }
function archiveAttachmentScope(db: DB, rounds: any[]) {
  const keys = new Set<string>(), roundIds = new Set(rounds.map(round => String(round.id)))
  for (const round of rounds) {
    const roundId = String(round.id)
    keys.add(attachmentKey('round', roundId))
    const samples = db.prepare(`SELECT id FROM samples WHERE round_id=? AND contract_id=?`).all(roundId, round.contract_id) as any[]
    for (const sample of samples) {
      const handovers = db.prepare(`SELECT id FROM sample_handovers WHERE sample_id=?`).all(sample.id) as any[]
      handovers.forEach(row => keys.add(attachmentKey('handover', row.id)))
      const records = db.prepare(`SELECT id FROM records WHERE sample_id=?`).all(sample.id) as any[]
      records.forEach(row => keys.add(attachmentKey('record', row.id)))
      const pretreatments = db.prepare(`SELECT id FROM pretreatments WHERE sample_id=?`).all(sample.id) as any[]
      pretreatments.forEach(row => keys.add(attachmentKey('pretreatment', row.id)))
      const qcRows = db.prepare(`SELECT id FROM qc_records WHERE sample_id=? OR round_id=?`).all(sample.id, roundId) as any[]
      qcRows.forEach(row => keys.add(attachmentKey('qc', row.id)))
    }
    const roundQc = db.prepare(`SELECT id FROM qc_records WHERE round_id=?`).all(roundId) as any[]
    roundQc.forEach(row => keys.add(attachmentKey('qc', row.id)))
  }
  return {
    includes(attachment: { entity_type: string; entity_id: string }) {
      if (keys.has(attachmentKey(attachment.entity_type, attachment.entity_id))) return true
      return attachment.entity_type === 'round_sheet' && [...roundIds].some(roundId => String(attachment.entity_id).startsWith(`${roundId}::`))
    },
  }
}

function getReportBatch(db: DB, id: string): ReportBatch | null {
  const row = db.prepare(`SELECT * FROM report_batches WHERE id=?`).get(id) as any
  if (!row) return null
  const rounds = db.prepare(`SELECT r.id FROM report_batch_rounds b
    JOIN rounds r ON r.id=b.round_id WHERE b.batch_id=? ORDER BY r.round_no,r.id`).all(id) as { id: string }[]
  return { ...row, round_ids: rounds.map(round => round.id) }
}

export function listReportBatches(db: DB, contractId?: string): ReportBatch[] {
  const rows = db.prepare(`SELECT b.*,br.round_id FROM report_batches b
    LEFT JOIN report_batch_rounds br ON br.batch_id=b.id
    ${contractId ? 'WHERE b.contract_id=?' : ''}
    ORDER BY b.created_at DESC,b.id,br.round_id`).all(...(contractId ? [contractId] : [])) as any[]
  const batches = new Map<string, ReportBatch>()
  for (const row of rows) {
    if (!batches.has(row.id)) batches.set(row.id, {
      id: row.id, contract_id: row.contract_id, name: row.name, created_by: row.created_by,
      created_at: row.created_at, round_ids: [],
    })
    if (row.round_id) batches.get(row.id)!.round_ids.push(row.round_id)
  }
  return [...batches.values()]
}

export function createReportBatch(
  db: DB,
  input: { contractId: string; name: string; roundIds: string[] },
  actor: Pick<User, 'username' | 'name' | 'roles'>,
): ReportBatch {
  if (!actor?.roles?.some(role => role === 'planner' || role === 'admin')) throw new Error('只有计划员可以预设报告批次和选择期次')
  const contractId = required(input?.contractId, '合同')
  const name = required(input?.name, '报告批次名称')
  const createdBy = required(actor?.username, '创建人账号')
  if (!db.prepare(`SELECT 1 FROM contracts WHERE id=?`).get(contractId)) throw new Error('合同不存在')
  const roundIds = [...new Set(Array.isArray(input?.roundIds) ? input.roundIds.map(id => required(id, '期次')) : [])]
  if (!roundIds.length) throw new Error('报告批次至少附加一个期次')
  for (const roundId of roundIds) {
    const round = db.prepare(`SELECT contract_id FROM rounds WHERE id=?`).get(roundId) as { contract_id: string } | undefined
    if (!round) throw new Error(`监测期次不存在：${roundId}`)
    if (round.contract_id !== contractId) throw new Error(`报告批次不能附加其他合同的期次：${roundId}`)
  }
  const id = randomUUID(), createdAt = now()
  return transaction(db, () => {
    db.prepare(`INSERT INTO report_batches(id,contract_id,name,created_by,created_at) VALUES (?,?,?,?,?)`)
      .run(id, contractId, name, createdBy, createdAt)
    for (const roundId of roundIds) {
      db.prepare(`INSERT INTO report_batch_rounds(batch_id,round_id,attached_by,attached_at) VALUES (?,?,?,?)`)
        .run(id, roundId, createdBy, createdAt)
    }
    return getReportBatch(db, id)!
  })
}

function resolveScope(db: DB, scope: ArchiveScope): { contractId: string; reportBatchId: string | null; rounds: any[] } {
  if (scope?.reportBatchId) {
    const batch = getReportBatch(db, required(scope.reportBatchId, '报告批次'))
    if (!batch) throw new Error('报告批次不存在')
    if (scope.contractId && scope.contractId !== batch.contract_id) throw new Error('报告批次与合同不匹配')
    const rounds = db.prepare(`SELECT r.* FROM report_batch_rounds b JOIN rounds r ON r.id=b.round_id
      WHERE b.batch_id=? ORDER BY r.round_no,r.id`).all(batch.id) as any[]
    return { contractId: batch.contract_id, reportBatchId: batch.id, rounds }
  }
  const contractId = required(scope?.contractId, '合同')
  if (!db.prepare(`SELECT 1 FROM contracts WHERE id=?`).get(contractId)) throw new Error('合同不存在')
  const rounds = db.prepare(`SELECT * FROM rounds WHERE contract_id=? AND status<>'cancelled' ORDER BY round_no,id`).all(contractId) as any[]
  return { contractId, reportBatchId: null, rounds }
}

function workflowEvidence(db: DB, subjectType: string, subjectId: string): WorkflowEvidence | null {
  const row = db.prepare(`SELECT w.id,w.subject_type,w.subject_id,w.status,w.current_revision,
      r.snapshot_json,r.snapshot_sha256,r.submitted_by,r.submitted_at
    FROM workflow_instances w LEFT JOIN workflow_revisions r
      ON r.instance_id=w.id AND r.revision=w.current_revision
    WHERE w.subject_type=? AND w.subject_id=?`).get(subjectType, subjectId) as any
  if (!row || row.status !== 'approved' || !row.snapshot_json || !isSha256(row.snapshot_sha256)) return null
  if (sha256(String(row.snapshot_json)) !== row.snapshot_sha256) return null
  return { ...row, current_revision: Number(row.current_revision) }
}

function pushIssue(issues: ArchiveIssue[], issue: ArchiveIssue) {
  if (!issues.some(existing => existing.code === issue.code && existing.roundId === issue.roundId && existing.entityId === issue.entityId)) issues.push(issue)
}

export function archiveReadiness(db: DB, scope: ArchiveScope): ArchiveReadiness {
  const resolved = resolveScope(db, scope)
  const issues: ArchiveIssue[] = []
  const contract = db.prepare(`SELECT tech_review_result,tech_approved_at FROM contracts WHERE id=?`).get(resolved.contractId) as any
  if (contract?.tech_review_result !== 'approve' || !contract?.tech_approved_at) {
    pushIssue(issues, { code: 'CONTRACT_REVIEW_NOT_APPROVED', message: '技术合同评审尚未批准', entityId: resolved.contractId })
  }
  const scheme = db.prepare(`SELECT id,status FROM schemes WHERE contract_id=? ORDER BY created_at DESC LIMIT 1`).get(resolved.contractId) as any
  if (!scheme || scheme.status !== 'approved') {
    pushIssue(issues, { code: 'SCHEME_NOT_APPROVED', message: '监测方案尚未批准', entityId: scheme?.id ?? resolved.contractId })
  }
  if (!resolved.rounds.length) pushIssue(issues, { code: 'NO_EXPECTED_ROUNDS', message: '没有可归档的监测期次', entityId: resolved.contractId })

  if (resolved.rounds.some(round => round.status !== 'cancelled')) {
    for (const assignmentScope of ['sampling', 'quality', 'laboratory']) {
      const assignment = db.prepare(`SELECT reviewer_username,approver_username FROM project_stage_assignments
        WHERE contract_id=? AND scope=? AND active=1`).get(resolved.contractId, assignmentScope) as any
      if (!assignment || !String(assignment.reviewer_username || '').trim() || !String(assignment.approver_username || '').trim() ||
          assignment.reviewer_username === assignment.approver_username) {
        pushIssue(issues, {
          code: 'ASSIGNMENT_NOT_ACTIVE', message: `${assignmentScope} 专业缺少当前有效复核/审核指派`, entityId: assignmentScope,
        })
      }
    }
  }

  for (const round of resolved.rounds) {
    const roundId = String(round.id)
    if (round.status === 'cancelled') {
      const cancellations = db.prepare(`SELECT id,detail FROM audit_log
        WHERE record_id=? AND action='round_cancel' ORDER BY id`).all(roundId) as any[]
      const hasReason = cancellations.some(entry => String(parseJson<any>(entry.detail, {})?.reason ?? '').trim())
      if (!hasReason) pushIssue(issues, {
        code: 'CANCELLATION_EVIDENCE_INVALID', message: '已取消期次缺少不可变终止原因或终止留痕', roundId, entityId: roundId,
      })
      continue
    }
    if (round.status !== 'done') pushIssue(issues, { code: 'ROUND_NOT_COMPLETE', message: '监测期次尚未完成', roundId, entityId: roundId })
    if (!workflowEvidence(db, 'round_sampling', roundId)) {
      pushIssue(issues, { code: 'SAMPLING_NOT_APPROVED', message: '采样工作流尚未批准或版本哈希无效', roundId, entityId: roundId })
    }
    const handover = db.prepare(`SELECT 1 FROM handover_sheets WHERE round_id=? AND status='confirmed' LIMIT 1`).get(roundId)
    if (!handover) pushIssue(issues, { code: 'HANDOVER_NOT_CONFIRMED', message: '样品交接尚未确认', roundId, entityId: roundId })
    const plan = db.prepare(`SELECT subject_id FROM quality_plans WHERE round_id=?`).get(roundId) as any
    if (!plan || !workflowEvidence(db, 'quality_plan', roundId)) {
      pushIssue(issues, { code: 'QUALITY_PLAN_NOT_APPROVED', message: '质量安排尚未批准或版本哈希无效', roundId, entityId: roundId })
    }
    const samples = db.prepare(`SELECT * FROM samples WHERE round_id=? AND contract_id=? AND status<>'rejected' ORDER BY id`)
      .all(roundId, resolved.contractId) as any[]
    const ordinarySamples = samples.filter(sample => !sample.qc_type)
    if (!ordinarySamples.length) pushIssue(issues, { code: 'ROUND_SAMPLES_MISSING', message: '监测期次没有可报告样品', roundId, entityId: roundId })
    for (const sample of samples) {
      const records = db.prepare(`SELECT id,analyte FROM records WHERE sample_id=? ORDER BY id`).all(sample.id) as any[]
      if (!sample.qc_type) {
        const expectedFromTasks = (db.prepare(`SELECT analyte FROM test_tasks WHERE sample_id=? ORDER BY id`).all(sample.id) as any[]).map(row => String(row.analyte))
        const expected = expectedFromTasks.length ? expectedFromTasks : parseJson<any[]>(sample.items, []).map(String)
        for (const analyte of expected) {
          if (!records.some(record => String(record.analyte) === analyte)) {
            pushIssue(issues, { code: 'LAB_RECORD_MISSING', message: `检测项目 ${analyte} 尚无实验室记录`, roundId, entityId: `${sample.id}:${analyte}` })
          }
        }
      }
      for (const record of records) {
        if (!workflowEvidence(db, 'lab_record', record.id)) {
          pushIssue(issues, { code: 'LAB_RECORD_NOT_APPROVED', message: '实验室记录尚未批准或版本哈希无效', roundId, entityId: String(record.id) })
        }
      }
    }
  }
  const attachmentScope = archiveAttachmentScope(db, resolved.rounds)
  const attachments = db.prepare(`SELECT id,entity_type,entity_id,content_hash FROM attachments WHERE deleted_at IS NULL ORDER BY rowid`).all() as any[]
  for (const attachment of attachments) {
    if (attachmentScope.includes(attachment) && !isSha256(attachment.content_hash)) {
      const entityId = String(attachment.entity_id)
      const roundId = resolved.rounds.find(round => entityId === String(round.id) || entityId.startsWith(`${round.id}::`))?.id
      pushIssue(issues, { code: 'ATTACHMENT_HASH_INVALID', message: '附件缺少可验证内容哈希', ...(roundId ? { roundId: String(roundId) } : {}), entityId: String(attachment.id) })
    }
  }
  return {
    ready: issues.length === 0,
    contractId: resolved.contractId,
    reportBatchId: resolved.reportBatchId,
    roundIds: resolved.rounds
      .filter(round => resolved.reportBatchId || round.status !== 'cancelled')
      .map(round => String(round.id)),
    issues,
  }
}

function ordinaryItem(entityType: string, entityId: string | number, label: string, snapshot: unknown): ItemDraft {
  return {
    entity_type: entityType,
    entity_id: String(entityId),
    workflow_instance_id: null,
    revision: null,
    content_hash: snapshotHash(snapshot),
    label,
    metadata: { snapshot } as Record<string, unknown>,
  }
}
function approvedWorkflowItem(db: DB, subjectType: string, subjectId: string, entityType: string, label: string): ItemDraft | null {
  const evidence = workflowEvidence(db, subjectType, subjectId)
  if (!evidence) return null
  const decisions = db.prepare(`SELECT revision,level,decision,comment,decided_by,decided_at FROM workflow_decisions
    WHERE instance_id=? AND revision=? ORDER BY id`).all(evidence.id, evidence.current_revision) as any[]
  return {
    entity_type: entityType,
    entity_id: evidence.subject_id,
    workflow_instance_id: evidence.id,
    revision: evidence.current_revision,
    content_hash: evidence.snapshot_sha256,
    label,
    metadata: {
      snapshot: parseJson(evidence.snapshot_json, {}), submittedBy: evidence.submitted_by,
      submittedAt: evidence.submitted_at, decisions,
    },
  }
}

function collectArchiveItems(db: DB, readiness: ArchiveReadiness): ItemDraft[] {
  const items: ItemDraft[] = []
  const contract = db.prepare(`SELECT * FROM contracts WHERE id=?`).get(readiness.contractId) as any
  if (contract) {
    items.push(ordinaryItem('contract', contract.id, `委托合同 ${contract.id}`, contract))
    items.push(ordinaryItem('contract_review', contract.id, `技术合同评审 ${contract.id}`, {
      reviewInfo: parseJson(contract.review_info, null), acceptedAt: contract.accepted_at, acceptedBy: contract.accepted_by,
      result: contract.tech_review_result, approvedBy: contract.tech_approved_by, approvedAt: contract.tech_approved_at,
      note: contract.tech_approve_note,
    }))
  }
  const scheme = db.prepare(`SELECT * FROM schemes WHERE contract_id=? ORDER BY created_at DESC LIMIT 1`).get(readiness.contractId) as any
  if (scheme) items.push(ordinaryItem('scheme', scheme.id, `已批准监测方案 ${scheme.id}`, scheme))
  const assignments = db.prepare(`SELECT * FROM project_stage_assignments WHERE contract_id=? ORDER BY id`).all(readiness.contractId) as any[]
  for (const assignment of assignments) {
    items.push(ordinaryItem('assignment', assignment.id, `${assignment.scope} 专业复核/审核指派`, assignment))
  }
  if (readiness.reportBatchId) {
    const batch = getReportBatch(db, readiness.reportBatchId)
    if (batch) items.push(ordinaryItem('report_batch', batch.id, `报告批次 ${batch.name}`, batch))
  }

  const auditEntityIds = new Set<string>([readiness.contractId])
  if (scheme) auditEntityIds.add(String(scheme.id))
  const scopedRounds: any[] = []
  for (const roundId of readiness.roundIds) {
    const round = db.prepare(`SELECT * FROM rounds WHERE id=?`).get(roundId) as any
    if (!round) continue
    scopedRounds.push(round)
    items.push(ordinaryItem('round', round.id, `监测期次 ${round.id}`, round))
    auditEntityIds.add(roundId)
    const sampling = approvedWorkflowItem(db, 'round_sampling', roundId, 'sampling_workflow', `采样批准版本 ${roundId}`)
    if (sampling) { items.push(sampling); auditEntityIds.add(sampling.workflow_instance_id!) }
    const sheets = db.prepare(`SELECT * FROM handover_sheets WHERE round_id=? AND contract_id=? ORDER BY created_at,id`)
      .all(roundId, readiness.contractId) as any[]
    for (const sheet of sheets) {
      items.push(ordinaryItem('handover_sheet', sheet.id, `样品交接单 ${sheet.id}`, sheet))
      auditEntityIds.add(String(sheet.id))
    }
    const samples = db.prepare(`SELECT * FROM samples WHERE round_id=? AND contract_id=? ORDER BY id`)
      .all(roundId, readiness.contractId) as any[]
    for (const sample of samples) {
      auditEntityIds.add(String(sample.id))
      const handovers = db.prepare(`SELECT * FROM sample_handovers WHERE sample_id=? ORDER BY id`).all(sample.id) as any[]
      for (const handover of handovers) {
        items.push(ordinaryItem('sample_handover', handover.id, `样品交接 ${sample.id}`, handover))
        auditEntityIds.add(String(handover.id))
      }
    }
    const quality = approvedWorkflowItem(db, 'quality_plan', roundId, 'quality_plan_workflow', `质量安排批准版本 ${roundId}`)
    if (quality) { items.push(quality); auditEntityIds.add(quality.workflow_instance_id!) }
    const records = db.prepare(`SELECT r.* FROM records r JOIN samples s ON s.id=r.sample_id
      WHERE s.round_id=? AND s.contract_id=? ORDER BY r.id`).all(roundId, readiness.contractId) as any[]
    for (const record of records) {
      auditEntityIds.add(String(record.id))
      const laboratory = approvedWorkflowItem(db, 'lab_record', record.id, 'lab_record_workflow', `实验室记录批准版本 ${record.id}`)
      if (laboratory) { items.push(laboratory); auditEntityIds.add(laboratory.workflow_instance_id!) }
    }
  }

  const attachmentScope = archiveAttachmentScope(db, scopedRounds)
  const attachments = db.prepare(`SELECT * FROM attachments WHERE deleted_at IS NULL ORDER BY at,id`).all() as any[]
  for (const attachment of attachments) {
    if (!attachmentScope.includes(attachment)) continue
    if (!isSha256(attachment.content_hash)) continue
    items.push({
      entity_type: 'attachment', entity_id: String(attachment.id), workflow_instance_id: null, revision: null,
      content_hash: attachment.content_hash, label: attachment.orig_name,
      metadata: { snapshot: attachment },
    })
  }
  const audits = db.prepare(`SELECT * FROM audit_log ORDER BY id`).all() as any[]
  for (const audit of audits) {
    if (auditEntityIds.has(String(audit.record_id))) items.push(ordinaryItem('audit_entry', audit.id, `${audit.action} · ${audit.record_id}`, audit))
  }
  return items
}

function packageFromRow(db: DB, row: any): ArchivePackage {
  const itemRows = db.prepare(`SELECT * FROM archive_items WHERE archive_package_id=? ORDER BY item_order`).all(row.id) as any[]
  const items = itemRows.map(item => {
    const { metadata_json, ...rest } = item
    return { ...rest, revision: item.revision === null ? null : Number(item.revision), metadata: parseJson(metadata_json, {}) }
  }) as ArchiveItem[]
  const { readiness_json, ...packageRow } = row
  return {
    ...packageRow,
    version: Number(row.version),
    status: row.status as ArchiveStatus,
    readiness: parseJson(readiness_json, {} as ArchiveReadiness),
    items,
  }
}

export function getArchivePackage(db: DB, id: string): ArchivePackage | null {
  const row = db.prepare(`SELECT * FROM archive_packages WHERE id=?`).get(id) as any
  return row ? packageFromRow(db, row) : null
}

export function listArchivePackages(db: DB, filter: { contractId?: string; status?: ArchiveStatus } = {}): ArchivePackage[] {
  const clauses: string[] = []
  const values: string[] = []
  if (filter.contractId) { clauses.push('contract_id=?'); values.push(filter.contractId) }
  if (filter.status) {
    if (!['draft', 'ready', 'confirmed', 'invalidated'].includes(filter.status)) throw new Error('不支持的归档状态')
    clauses.push('status=?'); values.push(filter.status)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT * FROM archive_packages ${where} ORDER BY created_at DESC,version DESC`).all(...values) as any[]
  return rows.map(row => packageFromRow(db, row))
}

export function buildArchivePackage(db: DB, scope: ArchiveScope, actor: Pick<User, 'username' | 'name' | 'roles'>): ArchivePackage {
  const createdBy = required(actor?.username, '归档构建人账号')
  const readiness = archiveReadiness(db, scope)
  const drafts = collectArchiveItems(db, readiness)
  const manifest = drafts.map((item, index) => manifestEntry({ ...item, item_order: index + 1 }))
  const manifestHash = snapshotHash(manifest)
  const id = randomUUID(), createdAt = now(), status: ArchiveStatus = readiness.ready ? 'ready' : 'draft'
  return transaction(db, () => {
    const versionRow = readiness.reportBatchId
      ? db.prepare(`SELECT COALESCE(MAX(version),0)+1 version FROM archive_packages WHERE report_batch_id=?`).get(readiness.reportBatchId) as any
      : db.prepare(`SELECT COALESCE(MAX(version),0)+1 version FROM archive_packages WHERE contract_id=? AND report_batch_id IS NULL`).get(readiness.contractId) as any
    const version = Number(versionRow.version)
    db.prepare(`INSERT INTO archive_packages
      (id,contract_id,report_batch_id,version,status,manifest_sha256,readiness_json,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, readiness.contractId, readiness.reportBatchId, version, status, manifestHash, stableJson(readiness), createdBy, createdAt)
    drafts.forEach((item, index) => db.prepare(`INSERT INTO archive_items
      (archive_package_id,item_order,entity_type,entity_id,workflow_instance_id,revision,content_hash,label,metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      id, index + 1, item.entity_type, item.entity_id, item.workflow_instance_id, item.revision,
      item.content_hash, item.label, stableJson(item.metadata),
    ))
    return getArchivePackage(db, id)!
  })
}

export function confirmArchivePackage(db: DB, packageId: string, actor: Pick<User, 'username' | 'name' | 'roles'>): ArchivePackage {
  if (!actor?.roles?.includes('archivist')) throw new Error('只有归档员可以确认归档版本')
  const id = required(packageId, '归档版本')
  const current = getArchivePackage(db, id)
  if (!current) throw new Error('归档版本不存在')
  if (!isSha256(current.manifest_sha256) || persistedManifestHash(db, id) !== current.manifest_sha256) {
    throw new Error('归档清单哈希与持久化条目不匹配，疑似篡改')
  }
  if (current.status === 'confirmed') return current
  if (current.status === 'invalidated') throw new Error('归档版本已失效，不能确认')
  if (current.status !== 'ready') throw new Error('归档尚未齐备，不能确认')
  const confirmedAt = now()
  const result = db.prepare(`UPDATE archive_packages SET status='confirmed',confirmed_by=?,confirmed_at=?
    WHERE id=? AND status='ready'`).run(actor.username, confirmedAt, id)
  if (result.changes !== 1) throw new Error('归档版本状态冲突')
  return getArchivePackage(db, id)!
}

export function assertConfirmedArchiveForReport(
  db: DB,
  packageId: string,
  expected: { contractId?: string | null; roundId?: string | null; roundIds?: string[]; recordIds?: string[] } = {},
): ArchivePackage {
  const archive = getArchivePackage(db, required(packageId, '归档版本'))
  if (!archive) throw new Error('归档版本不存在')
  if (archive.status === 'invalidated') throw new Error('归档版本已失效，不能生成或推进报告')
  if (archive.status !== 'confirmed') throw new Error('报告只能使用归档员已确认的归档版本')
  const hasContractExpectation = Object.prototype.hasOwnProperty.call(expected, 'contractId')
  const hasRoundExpectation = Object.prototype.hasOwnProperty.call(expected, 'roundId')
  const hasRoundsExpectation = Object.prototype.hasOwnProperty.call(expected, 'roundIds')
  if (!hasContractExpectation || (!hasRoundExpectation && !hasRoundsExpectation)) {
    throw new Error('报告归档验证范围必须同时提供合同、期次和实验室记录')
  }
  if (hasContractExpectation && !expected.contractId) throw new Error('自送样或无项目样品不能绑定项目归档版本')
  if (hasRoundExpectation && !expected.roundId) throw new Error('没有监测期次的样品不能绑定项目归档版本')
  if (hasRoundsExpectation && (!Array.isArray(expected.roundIds) || !expected.roundIds.length)) {
    throw new Error('合同或批次报告必须绑定非空期次范围')
  }
  if ((hasContractExpectation || hasRoundExpectation) && (!Array.isArray(expected.recordIds) || !expected.recordIds.length)) {
    throw new Error('报告归档校验必须提供非空的实验室记录范围')
  }
  if (!isSha256(archive.manifest_sha256) || persistedManifestHash(db, archive.id) !== archive.manifest_sha256) {
    throw new Error('归档清单哈希与持久化条目不匹配，不能用于报告')
  }
  if (expected.contractId) {
    if (archive.contract_id !== expected.contractId) throw new Error('归档版本不属于当前合同')
    const contractItem = archive.items.find(item => item.entity_type === 'contract' && item.entity_id === expected.contractId)
    if (!contractItem) throw new Error('归档清单缺少当前合同证据')
  }
  if (expected.roundId) {
    const round = db.prepare(`SELECT contract_id FROM rounds WHERE id=?`).get(expected.roundId) as { contract_id: string } | undefined
    if (!round) throw new Error('当前监测期次不存在')
    if (expected.contractId && round.contract_id !== expected.contractId) throw new Error('当前监测期次不属于当前合同')
    const roundItem = archive.items.find(item => item.entity_type === 'round' && item.entity_id === expected.roundId)
    if (!roundItem) throw new Error('归档清单不包含当前监测期次')
  }
  if (expected.roundIds) {
    const requested = [...new Set(expected.roundIds)].sort()
    const archived = [...new Set(archive.readiness.roundIds ?? [])].sort()
    if (requested.length !== archived.length || requested.some((id, index) => id !== archived[index])) {
      throw new Error('归档版本期次范围与合同总报告或报告批次不一致')
    }
    for (const roundId of requested) {
      const round = db.prepare(`SELECT contract_id FROM rounds WHERE id=?`).get(roundId) as { contract_id: string } | undefined
      if (!round || round.contract_id !== expected.contractId) throw new Error(`监测期次 ${roundId} 不属于当前合同`)
      if (!archive.items.some(item => item.entity_type === 'round' && item.entity_id === roundId)) {
        throw new Error(`归档清单不包含监测期次 ${roundId}`)
      }
    }
  }
  for (const recordId of [...new Set(expected.recordIds ?? [])]) {
    const record = db.prepare(`SELECT r.id,s.contract_id,s.round_id FROM records r JOIN samples s ON s.id=r.sample_id WHERE r.id=?`).get(recordId) as any
    if (!record) throw new Error(`实验室记录 ${recordId} 不存在`)
    if (!record.contract_id || !record.round_id) throw new Error(`实验室记录 ${recordId} 不属于可归档的项目期次`)
    if (expected.contractId && record.contract_id !== expected.contractId) throw new Error(`实验室记录 ${recordId} 不属于当前合同`)
    if (expected.roundId && record.round_id !== expected.roundId) throw new Error(`实验室记录 ${recordId} 不属于当前监测期次`)
    const evidence = workflowEvidence(db, 'lab_record', recordId)
    if (!evidence) throw new Error(`实验室记录 ${recordId} 当前没有有效的批准工作流版本`)
    const exactItem = archive.items.find(item => item.entity_type === 'lab_record_workflow' && item.entity_id === recordId &&
      item.workflow_instance_id === evidence.id && item.revision === evidence.current_revision && item.content_hash === evidence.snapshot_sha256)
    if (!exactItem) throw new Error(`归档清单缺少实验室记录 ${recordId} 的精确批准版本条目`)
  }
  return archive
}

export function invalidateAffectedArchives(
  db: DB,
  workflowInstanceId: string,
  revision: number,
  reason: string,
  actor?: Pick<User, 'username' | 'name'>,
): { invalidatedArchiveIds: string[]; blockedReportIds: string[]; reissueRequiredReportIds: string[] } {
  const instanceId = required(workflowInstanceId, '工作流实例')
  if (!Number.isInteger(revision) || revision < 1) throw new Error('工作流版本不合法')
  const invalidationReason = required(reason, '归档失效原因')
  const archiveRows = db.prepare(`SELECT DISTINCT p.id FROM archive_packages p JOIN archive_items i ON i.archive_package_id=p.id
    WHERE i.workflow_instance_id=? AND i.revision=? AND p.status<>'invalidated' ORDER BY p.created_at,p.id`).all(instanceId, revision) as { id: string }[]
  const invalidatedArchiveIds = archiveRows.map(row => row.id)
  if (!invalidatedArchiveIds.length) return { invalidatedArchiveIds: [], blockedReportIds: [], reissueRequiredReportIds: [] }
  const blockedReportIds: string[] = [], reissueRequiredReportIds: string[] = [], invalidatedAt = now()
  return transaction(db, () => {
    for (const archiveId of invalidatedArchiveIds) {
      db.prepare(`UPDATE archive_packages SET status='invalidated',invalidated_by=?,invalidated_at=?,invalidation_reason=?
        WHERE id=? AND status<>'invalidated'`).run(actor?.username ?? null, invalidatedAt, invalidationReason, archiveId)
      const reports = db.prepare(`SELECT id,status FROM reports WHERE archive_package_id=? ORDER BY id`).all(archiveId) as any[]
      for (const report of reports) {
        if (report.status === 'issued') {
          db.prepare(`UPDATE reports SET archive_requires_reissue=1,archive_block_reason=? WHERE id=?`)
            .run(invalidationReason, report.id)
          reissueRequiredReportIds.push(String(report.id))
        } else if (report.status === 'draft' || report.status === 'checked' || report.status === 'reviewed') {
          db.prepare(`UPDATE reports SET archive_blocked_at=?,archive_block_reason=? WHERE id=?`)
            .run(invalidatedAt, invalidationReason, report.id)
          blockedReportIds.push(String(report.id))
        }
      }
    }
    return { invalidatedArchiveIds, blockedReportIds, reissueRequiredReportIds }
  })
}
