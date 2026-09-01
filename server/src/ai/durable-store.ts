import type { DatabaseSync } from 'node:sqlite'

import { canonicalize, hashCanonical, stableId } from './phase0/index.ts'

type Clock = () => string

type Controls = {
  enabled: boolean
  killSwitchActive: boolean
  capabilityPolicyEpoch: number
  killSwitchEpoch: number
}

type StoreOptions = {
  now?: Clock
}

export class AiDurableError extends Error {
  readonly code: string

  constructor(code: string, message = code, options: ErrorOptions = {}) {
    super(message, options)
    this.name = 'AiDurableError'
    this.code = code
  }
}

function fail(code: string, message?: string): never {
  throw new AiDurableError(code, message)
}

function assertText(value: unknown) {
  if (typeof value !== 'string' || !value || value !== value.normalize('NFC') || value.includes('\0')) fail('AI_INPUT_INVALID')
}

function assertEpoch(value: unknown) {
  if (!Number.isInteger(value) || Number(value) < 0) fail('AI_INPUT_INVALID')
}

function assertTime(value: unknown) {
  assertText(value)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value as string)) fail('AI_INPUT_INVALID')
  const parsed = Date.parse(value as string)
  if (!Number.isFinite(parsed)) fail('AI_INPUT_INVALID')
  return new Date(parsed).toISOString()
}

function plusMs(iso: string, milliseconds: number) {
  if (!Number.isInteger(milliseconds) || milliseconds <= 0) fail('AI_INPUT_INVALID')
  return new Date(Date.parse(iso) + milliseconds).toISOString()
}

function parseJson(value: unknown) {
  if (typeof value !== 'string') return null
  try { return JSON.parse(value) } catch { fail('AI_STORAGE_CORRUPT') }
}

function mapJob(row: any) {
  if (!row) return null
  return {
    id: row.id,
    runId: row.run_id,
    tenantId: row.tenant_id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    jobType: row.job_type,
    state: row.state,
    stateVersion: Number(row.state_version),
    leaseOwner: row.lease_owner ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null,
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    idempotencyKey: row.idempotency_key,
    targetVersion: row.target_version,
    requestHash: row.request_hash,
    inputSnapshotId: row.input_snapshot_id,
    capabilityPolicyEpoch: Number(row.capability_policy_epoch),
    killSwitchEpoch: Number(row.kill_switch_epoch),
    checkpoint: parseJson(row.checkpoint_json),
    terminalIntent: row.terminal_intent ?? null,
    notBefore: row.not_before,
    expiresAt: row.expires_at,
    errorCode: row.error_code ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapReservation(row: any) {
  if (!row) return null
  return {
    id: row.id,
    tenantId: row.tenant_id,
    runId: row.run_id,
    jobId: row.job_id,
    logicalCallId: row.logical_call_id,
    downstreamKey: row.downstream_key,
    requestHash: row.request_hash,
    permissionProjectionHash: row.permission_projection_hash,
    capabilityPolicyEpoch: Number(row.capability_policy_epoch),
    killSwitchEpoch: Number(row.kill_switch_epoch),
    state: row.state,
    owner: row.owner,
    leaseExpiresAt: row.lease_expires_at,
    expiresAt: row.expires_at,
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    providerRequestId: row.provider_request_id ?? null,
    receiptHash: row.receipt_hash ?? null,
    responseHash: row.response_hash ?? null,
  }
}

function mapProposal(row: any) {
  if (!row) return null
  return {
    id: row.id,
    runId: row.run_id,
    jobId: row.job_id,
    revisionId: row.revision_id,
    type: row.proposal_type,
    state: row.state,
    contentHash: row.content_hash,
    targetVersion: row.target_version,
    approvalSetHash: row.approval_set_hash ?? null,
  }
}

function mapOutbox(row: any) {
  if (!row) return null
  return {
    id: row.id,
    tenantId: row.tenant_id,
    scopeId: row.scope_id,
    jobId: row.job_id,
    proposalId: row.proposal_id,
    state: row.state,
    stateVersion: Number(row.state_version),
    deduplicationKey: row.deduplication_key,
    downstreamKey: row.downstream_key,
    requestHash: row.request_hash,
    approvalSetHash: row.approval_set_hash,
    capabilityPolicyEpoch: Number(row.capability_policy_epoch),
    killSwitchEpoch: Number(row.kill_switch_epoch),
    dispatchOwner: row.dispatch_owner ?? null,
    dispatchLeaseExpiresAt: row.dispatch_lease_expires_at ?? null,
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    notBefore: row.not_before,
    receiptHash: row.receipt_hash ?? null,
    responseHash: row.response_hash ?? null,
    lastErrorCode: row.last_error_code ?? null,
  }
}

function assertHash(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail('AI_INPUT_INVALID')
}

function isBusy(error: unknown) {
  const message = String((error as any)?.message || error)
  return /database is locked|database is busy|SQLITE_BUSY/i.test(message)
}

function checkControls(job: any, controls: Controls) {
  if (!controls || typeof controls.enabled !== 'boolean' || typeof controls.killSwitchActive !== 'boolean') fail('AI_INPUT_INVALID')
  assertEpoch(controls.capabilityPolicyEpoch)
  assertEpoch(controls.killSwitchEpoch)
  if (!controls.enabled) fail('AI_CAPABILITY_DISABLED')
  if (controls.killSwitchActive || Number(job.kill_switch_epoch) !== controls.killSwitchEpoch) fail('AI_KILL_SWITCH_ACTIVE')
  if (Number(job.capability_policy_epoch) !== controls.capabilityPolicyEpoch) fail('AI_CAPABILITY_DISABLED')
}

function checkNewJobControls(input: any) {
  const controls = input?.controls as Controls | undefined
  if (!controls || typeof controls.enabled !== 'boolean' || typeof controls.killSwitchActive !== 'boolean') fail('AI_INPUT_INVALID')
  assertEpoch(controls.capabilityPolicyEpoch)
  assertEpoch(controls.killSwitchEpoch)
  if (!controls.enabled || controls.capabilityPolicyEpoch !== input.capabilityPolicyEpoch) fail('AI_CAPABILITY_DISABLED')
  if (controls.killSwitchActive || controls.killSwitchEpoch !== input.killSwitchEpoch) fail('AI_KILL_SWITCH_ACTIVE')
}

const EXTERNAL_CALL_RESOLUTIONS = new Set(['outcome_unprovable', 'confirmed_executed', 'confirmed_unsent', 'closed_unknown'])
const OUTBOX_RESOLUTIONS = new Set(['retry_proven_safe', 'outcome_unprovable', 'late_receipt_delivered', 'confirmed_unsent', 'closed_unknown'])
const NO_OUTBOX_RUN_DISPOSITIONS = new Map([
  ['awaiting_human', 'waiting_approval'],
  ['no_change', 'completed'],
  ['rejected', 'completed'],
  ['superseded', 'superseded'],
  ['apply_failed', 'failed'],
  ['policy_stopped', 'failed'],
  ['failed', 'failed'],
])

export class AiDurableStore {
  readonly db: DatabaseSync
  readonly now: Clock

  constructor(db: DatabaseSync, options: StoreOptions = {}) {
    this.db = db
    this.now = options.now ?? (() => new Date().toISOString())
    // AI uses a dedicated SQLite connection. Keep its lock wait below the
    // control-plane ceiling so AI backpressure never stretches core LIMS writes.
    this.db.exec('PRAGMA busy_timeout = 250')
  }

  private transaction<T>(operation: () => T): T {
    try {
      this.db.exec('BEGIN IMMEDIATE')
    } catch (error) {
      if (isBusy(error)) throw new AiDurableError('AI_DB_BUSY', 'AI SQLite write lock is busy', { cause: error })
      throw error
    }
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* retain the original failure */ }
      if (isBusy(error)) throw new AiDurableError('AI_DB_BUSY', 'AI SQLite write lock is busy', { cause: error })
      throw error
    }
  }

  getJob(id: string) {
    assertText(id)
    return mapJob(this.db.prepare(`SELECT * FROM ai_jobs WHERE id=?`).get(id))
  }

  getOutbox(id: string) {
    assertText(id)
    return mapOutbox(this.db.prepare(`SELECT * FROM ai_outbox WHERE id=?`).get(id))
  }

  private appendOutboxEvent(row: any, fromState: string | null, toState: string, eventType: string, actor: string, at: string, evidenceHash: string | null = null) {
    this.db.prepare(`INSERT INTO ai_outbox_events
      (outbox_id,attempt,from_state,to_state,event_type,request_hash,downstream_key,evidence_hash,actor,at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      row.id, row.attempt, fromState, toState, eventType, row.request_hash, row.downstream_key, evidenceHash, actor, at,
    )
  }

  createJob(input: any) {
    for (const key of ['runId', 'tenantId', 'scopeKind', 'scopeId', 'jobType', 'idempotencyKey', 'targetVersion', 'inputSnapshotId']) {
      assertText(input?.[key])
    }
    assertEpoch(input.capabilityPolicyEpoch)
    assertEpoch(input.killSwitchEpoch)
    checkNewJobControls(input)
    if (!Number.isInteger(input.maxAttempts) || input.maxAttempts <= 0) fail('AI_INPUT_INVALID')
    const expiresAt = assertTime(input.expiresAt)
    const now = assertTime(this.now())
    const notBefore = assertTime(input.notBefore ?? now)
    const priority = Number(input.priority ?? 0)
    if (!Number.isInteger(priority) || notBefore >= expiresAt) fail('AI_INPUT_INVALID')
    if (expiresAt <= now) fail('AI_JOB_STALE')
    const runEnvelope = input.runEnvelope ?? input.request
    const runRequestHash = hashCanonical(runEnvelope)
    const jobRequestHash = hashCanonical(input.request)
    const jobId = stableId('job', hashCanonical({
      tenantId: input.tenantId,
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      idempotencyKey: input.idempotencyKey,
      targetVersion: input.targetVersion,
    }))

    return this.transaction(() => {
      const run = this.db.prepare(`SELECT tenant_id,scope_kind,scope_id,request_hash FROM ai_runs WHERE id=?`).get(input.runId) as any
      if (run && (run.tenant_id !== input.tenantId || run.scope_kind !== input.scopeKind || run.scope_id !== input.scopeId)) {
        fail('AI_SCOPE_DENIED')
      }
      if (run && run.request_hash !== runRequestHash) fail('AI_IDEMPOTENCY_CONFLICT')
      if (!run) {
        this.db.prepare(`INSERT INTO ai_runs
          (id,tenant_id,scope_kind,scope_id,request_hash,envelope_json,state,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(
          input.runId, input.tenantId, input.scopeKind, input.scopeId, runRequestHash,
          canonicalize(runEnvelope), 'accepted', now, now,
        )
      }

      try {
        this.db.prepare(`INSERT INTO ai_jobs
          (id,run_id,tenant_id,scope_kind,scope_id,job_type,priority,state,state_version,attempt,max_attempts,
           idempotency_key,target_version,request_hash,input_snapshot_id,capability_policy_epoch,kill_switch_epoch,
           not_before,expires_at,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,'queued',0,0,?,?,?,?,?,?,?,?,?,?,?)`).run(
          jobId, input.runId, input.tenantId, input.scopeKind, input.scopeId, input.jobType, priority,
          input.maxAttempts, input.idempotencyKey, input.targetVersion, jobRequestHash, input.inputSnapshotId,
          input.capabilityPolicyEpoch, input.killSwitchEpoch, notBefore, expiresAt, now, now,
        )
      } catch (error) {
        const existing = this.db.prepare(`SELECT * FROM ai_jobs
          WHERE tenant_id=? AND scope_kind=? AND scope_id=? AND idempotency_key=? AND target_version=?`).get(
          input.tenantId, input.scopeKind, input.scopeId, input.idempotencyKey, input.targetVersion,
        ) as any
        if (!existing || existing.run_id !== input.runId || existing.job_type !== input.jobType ||
          existing.request_hash !== jobRequestHash || existing.input_snapshot_id !== input.inputSnapshotId ||
          Number(existing.capability_policy_epoch) !== input.capabilityPolicyEpoch || Number(existing.kill_switch_epoch) !== input.killSwitchEpoch) {
          if (/UNIQUE constraint/i.test(String((error as any)?.message || error))) fail('AI_IDEMPOTENCY_CONFLICT')
          throw error
        }
        return { job: mapJob(existing), replayed: true }
      }
      return { job: this.getJob(jobId), replayed: false }
    })
  }

  claimNextJob(input: { workerId: string, leaseMs: number, controls: Controls }) {
    assertText(input.workerId)
    const now = assertTime(this.now())
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM ai_jobs
        WHERE state='queued' AND not_before<=? AND expires_at>?
        ORDER BY priority DESC,created_at,id LIMIT 1`).get(now, now) as any
      if (!row) return null
      checkControls(row, input.controls)
      const leaseExpiresAt = plusMs(now, input.leaseMs)
      const nextAttempt = Number(row.attempt) + 1
      if (nextAttempt > Number(row.max_attempts)) fail('AI_JOB_STALE')
      const result = this.db.prepare(`UPDATE ai_jobs SET state='running',state_version=state_version+1,
        lease_owner=?,lease_expires_at=?,attempt=?,updated_at=? WHERE id=? AND state='queued' AND state_version=?`).run(
        input.workerId, leaseExpiresAt, nextAttempt, now, row.id, row.state_version,
      )
      if (Number(result.changes) !== 1) fail('AI_LEASE_LOST')
      this.db.prepare(`INSERT INTO ai_job_attempts(job_id,attempt,worker_id,started_at) VALUES(?,?,?,?)`)
        .run(row.id, nextAttempt, input.workerId, now)
      return this.getJob(row.id)
    })
  }

  claimJob(input: { jobId: string, workerId: string, leaseMs: number, controls: Controls }) {
    assertText(input.jobId)
    assertText(input.workerId)
    const now = assertTime(this.now())
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM ai_jobs WHERE id=?`).get(input.jobId) as any
      if (!row || row.state !== 'queued' || String(row.not_before) > now || String(row.expires_at) <= now) fail('AI_LEASE_LOST')
      checkControls(row, input.controls)
      const nextAttempt = Number(row.attempt) + 1
      if (nextAttempt > Number(row.max_attempts)) fail('AI_JOB_STALE')
      const changed = this.db.prepare(`UPDATE ai_jobs SET state='running',state_version=state_version+1,
        lease_owner=?,lease_expires_at=?,attempt=?,updated_at=? WHERE id=? AND state='queued' AND state_version=?`).run(
        input.workerId, plusMs(now, input.leaseMs), nextAttempt, now, row.id, row.state_version,
      )
      if (Number(changed.changes) !== 1) fail('AI_LEASE_LOST')
      this.db.prepare(`INSERT INTO ai_job_attempts(job_id,attempt,worker_id,started_at) VALUES(?,?,?,?)`)
        .run(row.id, nextAttempt, input.workerId, now)
      return this.getJob(row.id)
    })
  }

  checkpoint(input: {
    jobId: string, workerId: string, attempt: number, expectedStateVersion: number,
    value: unknown, leaseMs: number, controls: Controls,
  }) {
    assertText(input.jobId)
    assertText(input.workerId)
    const now = assertTime(this.now())
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM ai_jobs WHERE id=?`).get(input.jobId) as any
      if (!row || row.state !== 'running' || row.lease_owner !== input.workerId || Number(row.attempt) !== input.attempt ||
        Number(row.state_version) !== input.expectedStateVersion || String(row.lease_expires_at) <= now) fail('AI_LEASE_LOST')
      checkControls(row, input.controls)
      const checkpointJson = canonicalize(input.value)
      const result = this.db.prepare(`UPDATE ai_jobs SET checkpoint_json=?,lease_expires_at=?,state_version=state_version+1,updated_at=?
        WHERE id=? AND state='running' AND state_version=? AND lease_owner=? AND attempt=?`).run(
        checkpointJson, plusMs(now, input.leaseMs), now, input.jobId, input.expectedStateVersion, input.workerId, input.attempt,
      )
      if (Number(result.changes) !== 1) fail('AI_LEASE_LOST')
      return this.getJob(input.jobId)
    })
  }

  finishJobWithoutOutbox(input: {
    jobId: string, workerId: string, attempt: number, expectedStateVersion: number,
    checkpoint: unknown, runState: string, errorCode: string | null, controls: Controls,
  }) {
    assertText(input.jobId)
    assertText(input.workerId)
    assertText(input.runState)
    if (input.errorCode !== null) assertText(input.errorCode)
    const jobState = NO_OUTBOX_RUN_DISPOSITIONS.get(input.runState)
    if (!jobState) fail('AI_INPUT_INVALID')
    const now = assertTime(this.now())
    return this.transaction(() => {
      const job = this.db.prepare(`SELECT * FROM ai_jobs WHERE id=?`).get(input.jobId) as any
      if (!job || job.state !== 'running' || job.lease_owner !== input.workerId || Number(job.attempt) !== input.attempt ||
        Number(job.state_version) !== input.expectedStateVersion || String(job.lease_expires_at) <= now || job.terminal_intent !== null) {
        fail('AI_LEASE_LOST')
      }
      checkControls(job, input.controls)
      const changed = this.db.prepare(`UPDATE ai_jobs SET state=?,state_version=state_version+1,checkpoint_json=?,error_code=?,
        lease_owner=NULL,lease_expires_at=NULL,updated_at=?
        WHERE id=? AND state='running' AND state_version=? AND lease_owner=? AND attempt=?`).run(
        jobState, canonicalize(input.checkpoint), input.errorCode, now, job.id, input.expectedStateVersion, input.workerId, input.attempt,
      )
      if (Number(changed.changes) !== 1) fail('AI_LEASE_LOST')
      const terminal = jobState !== 'waiting_approval'
      this.db.prepare(`UPDATE ai_runs SET state=?,completed_at=?,updated_at=? WHERE id=?`).run(
        input.runState, terminal ? now : null, now, job.run_id,
      )
      this.db.prepare(`UPDATE ai_job_attempts SET finished_at=?,outcome=?,error_code=?,retryable=0
        WHERE job_id=? AND attempt=? AND finished_at IS NULL`).run(
        now, input.runState, input.errorCode, job.id, input.attempt,
      )
      return this.getJob(job.id)
    })
  }

  reserveExternalCall(input: {
    jobId: string, workerId: string, attempt: number, expectedStateVersion: number,
    logicalCallId: string, downstreamKey: string, request: unknown, permissionProjectionHash: string,
    leaseMs: number, maxAttempts: number, controls: Controls,
  }) {
    for (const key of ['jobId', 'workerId', 'logicalCallId', 'downstreamKey', 'permissionProjectionHash'] as const) assertText(input[key])
    if (!/^[0-9a-f]{64}$/.test(input.permissionProjectionHash)) fail('AI_INPUT_INVALID')
    if (!Number.isInteger(input.maxAttempts) || input.maxAttempts <= 0) fail('AI_INPUT_INVALID')
    const now = assertTime(this.now())
    const requestHash = hashCanonical(input.request)
    const reservationId = stableId('cal', hashCanonical({ jobId: input.jobId, logicalCallId: input.logicalCallId }))
    return this.transaction(() => {
      const job = this.db.prepare(`SELECT * FROM ai_jobs WHERE id=?`).get(input.jobId) as any
      if (!job || job.state !== 'running' || job.lease_owner !== input.workerId || Number(job.attempt) !== input.attempt ||
        Number(job.state_version) !== input.expectedStateVersion || String(job.lease_expires_at) <= now || job.terminal_intent !== null) {
        fail('AI_LEASE_LOST')
      }
      checkControls(job, input.controls)
      const leaseExpiresAt = plusMs(now, input.leaseMs)
      try {
        this.db.prepare(`INSERT INTO ai_external_call_reservations
          (id,tenant_id,run_id,job_id,logical_call_id,downstream_key,request_hash,permission_projection_hash,
           capability_policy_epoch,kill_switch_epoch,state,owner,lease_expires_at,expires_at,attempt,max_attempts,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,'reserved',?,?,?,?,?,?,?)`).run(
          reservationId, job.tenant_id, job.run_id, job.id, input.logicalCallId, input.downstreamKey, requestHash,
          input.permissionProjectionHash, job.capability_policy_epoch, job.kill_switch_epoch, input.workerId,
          leaseExpiresAt, leaseExpiresAt, input.attempt, input.maxAttempts, now, now,
        )
        this.db.prepare(`INSERT INTO ai_external_call_attempts
          (reservation_id,attempt,owner,request_hash,downstream_key,capability_policy_epoch,kill_switch_epoch,started_at)
          VALUES(?,?,?,?,?,?,?,?)`).run(
          reservationId, input.attempt, input.workerId, requestHash, input.downstreamKey,
          job.capability_policy_epoch, job.kill_switch_epoch, now,
        )
      } catch (error) {
        const existing = this.db.prepare(`SELECT * FROM ai_external_call_reservations
          WHERE tenant_id=? AND run_id=? AND job_id=? AND logical_call_id=?`).get(
          job.tenant_id, job.run_id, job.id, input.logicalCallId,
        ) as any
        if (!existing || existing.request_hash !== requestHash || existing.downstream_key !== input.downstreamKey ||
          existing.permission_projection_hash !== input.permissionProjectionHash) {
          if (/UNIQUE constraint/i.test(String((error as any)?.message || error))) fail('AI_IDEMPOTENCY_CONFLICT')
          throw error
        }
        return mapReservation(existing)
      }
      return mapReservation(this.db.prepare(`SELECT * FROM ai_external_call_reservations WHERE id=?`).get(reservationId))
    })
  }

  markExternalCallSent(input: {
    reservationId: string, jobId: string, workerId: string, attempt: number, controls: Controls,
  }) {
    for (const key of ['reservationId', 'jobId', 'workerId'] as const) assertText(input[key])
    const now = assertTime(this.now())
    return this.transaction(() => {
      const job = this.db.prepare(`SELECT * FROM ai_jobs WHERE id=?`).get(input.jobId) as any
      if (!job || job.state !== 'running' || job.lease_owner !== input.workerId || Number(job.attempt) !== input.attempt ||
        String(job.lease_expires_at) <= now || job.terminal_intent !== null) fail('AI_LEASE_LOST')
      checkControls(job, input.controls)
      const reservation = this.db.prepare(`SELECT * FROM ai_external_call_reservations WHERE id=? AND job_id=?`).get(
        input.reservationId, input.jobId,
      ) as any
      if (!reservation || reservation.state !== 'reserved' || reservation.owner !== input.workerId ||
        Number(reservation.attempt) !== input.attempt || String(reservation.lease_expires_at) <= now || String(reservation.expires_at) <= now ||
        Number(reservation.capability_policy_epoch) !== input.controls.capabilityPolicyEpoch ||
        Number(reservation.kill_switch_epoch) !== input.controls.killSwitchEpoch) fail('AI_LEASE_LOST')
      const changed = this.db.prepare(`UPDATE ai_external_call_reservations SET state='sent',updated_at=?
        WHERE id=? AND state='reserved' AND owner=? AND attempt=?`).run(now, reservation.id, input.workerId, input.attempt)
      if (Number(changed.changes) !== 1) fail('AI_LEASE_LOST')
      this.db.prepare(`UPDATE ai_external_call_attempts SET sent_at=?
        WHERE reservation_id=? AND attempt=? AND sent_at IS NULL`).run(now, reservation.id, input.attempt)
      return mapReservation(this.db.prepare(`SELECT * FROM ai_external_call_reservations WHERE id=?`).get(reservation.id))
    })
  }

  resolveExternalCall(input: {
    reservationId: string,
    resolution: 'outcome_unprovable' | 'confirmed_executed' | 'confirmed_unsent' | 'closed_unknown',
    evidenceHash: string,
    actor: string,
    controls: Controls,
    receiptHash?: string,
    responseHash?: string,
  }) {
    for (const key of ['reservationId', 'resolution', 'actor', 'evidenceHash'] as const) assertText(input[key])
    assertHash(input.evidenceHash)
    if (!EXTERNAL_CALL_RESOLUTIONS.has(input.resolution)) fail('AI_INPUT_INVALID')
    const now = assertTime(this.now())
    return this.transaction(() => {
      const reservation = this.db.prepare(`SELECT * FROM ai_external_call_reservations WHERE id=?`).get(input.reservationId) as any
      if (!reservation) fail('AI_JOB_STALE')
      const job = this.db.prepare(`SELECT * FROM ai_jobs WHERE id=?`).get(reservation.job_id) as any
      if (!job) fail('AI_STORAGE_CORRUPT')

      if (input.resolution === 'outcome_unprovable') {
        if (reservation.state !== 'reconciling' || !['reconciling', 'unknown_outcome'].includes(String(job.state))) fail('AI_JOB_STALE')
        const reservationChanged = this.db.prepare(`UPDATE ai_external_call_reservations SET state='unknown_outcome',updated_at=?
          WHERE id=? AND state='reconciling'`).run(now, reservation.id)
        const jobChanged = this.db.prepare(`UPDATE ai_jobs SET state='unknown_outcome',state_version=state_version+1,
          lease_owner=NULL,lease_expires_at=NULL,error_code='AI_EXTERNAL_CALL_UNKNOWN_OUTCOME',updated_at=?
          WHERE id=? AND state IN ('reconciling','unknown_outcome') AND state_version=?`).run(now, job.id, job.state_version)
        if (Number(reservationChanged.changes) !== 1 || Number(jobChanged.changes) !== 1) fail('AI_JOB_STALE')
        this.db.prepare(`INSERT INTO ai_risk_events(run_id,job_id,code,severity,detail_hash,created_at)
          VALUES(?,?,'AI_EXTERNAL_CALL_UNKNOWN_OUTCOME','P1',?,?)`).run(job.run_id, job.id, input.evidenceHash, now)
        return {
          reservation: mapReservation(this.db.prepare(`SELECT * FROM ai_external_call_reservations WHERE id=?`).get(reservation.id)),
          job: this.getJob(job.id),
        }
      }

      if (reservation.state !== 'unknown_outcome' || job.state !== 'unknown_outcome') fail('AI_JOB_STALE')
      let reservationState: string
      let jobState: string
      let conclusion: string
      let receiptHash: string | null = null
      let responseHash: string | null = null
      if (input.resolution === 'confirmed_executed') {
        assertHash(input.receiptHash)
        assertHash(input.responseHash)
        reservationState = 'resolved_finished'
        conclusion = 'confirmed_executed'
        receiptHash = input.receiptHash!
        responseHash = input.responseHash!
        jobState = job.terminal_intent === 'cancelled' ? 'cancelled'
          : job.terminal_intent === 'expired' ? 'expired'
            : job.terminal_intent === 'superseded' ? 'superseded'
              : job.terminal_intent === 'policy_stopped' ? 'failed' : 'queued'
      } else if (input.resolution === 'confirmed_unsent') {
        reservationState = 'resolved_unsent'
        conclusion = 'confirmed_unsent'
        if (job.terminal_intent === null) checkControls(job, input.controls)
        jobState = job.terminal_intent === 'cancelled' ? 'cancelled'
          : job.terminal_intent === 'expired' ? 'expired'
            : job.terminal_intent === 'superseded' ? 'superseded'
              : job.terminal_intent === 'policy_stopped' ? 'failed' : 'queued'
      } else {
        reservationState = 'resolved_abandoned'
        conclusion = 'closed_unknown'
        jobState = job.terminal_intent === 'cancelled' ? 'cancelled'
          : job.terminal_intent === 'expired' ? 'expired'
            : job.terminal_intent === 'superseded' ? 'superseded' : 'failed'
      }
      const reservationChanged = this.db.prepare(`UPDATE ai_external_call_reservations SET state=?,receipt_hash=?,response_hash=?,updated_at=?
        WHERE id=? AND state='unknown_outcome'`).run(reservationState, receiptHash, responseHash, now, reservation.id)
      const jobChanged = this.db.prepare(`UPDATE ai_jobs SET state=?,state_version=state_version+1,
        lease_owner=NULL,lease_expires_at=NULL,error_code=?,updated_at=? WHERE id=? AND state='unknown_outcome' AND state_version=?`).run(
        jobState, jobState === 'failed' ? 'AI_EXTERNAL_CALL_UNKNOWN_OUTCOME' : null, now, job.id, job.state_version,
      )
      if (Number(reservationChanged.changes) !== 1 || Number(jobChanged.changes) !== 1) fail('AI_JOB_STALE')
      this.db.prepare(`INSERT INTO ai_external_call_resolutions
        (reservation_id,attempt,conclusion,evidence_hash,receipt_hash,resolved_by,resolved_at,parent_job_disposition)
        VALUES(?,?,?,?,?,?,?,?)`).run(
        reservation.id, reservation.attempt, conclusion, input.evidenceHash, receiptHash, input.actor, now, jobState,
      )
      this.db.prepare(`UPDATE ai_external_call_attempts SET finished_at=?,response_hash=?,receipt_hash=?,
        outcome=?,error_code=? WHERE reservation_id=? AND attempt=? AND finished_at IS NULL`).run(
        now, responseHash, receiptHash, conclusion, conclusion === 'closed_unknown' ? 'AI_EXTERNAL_CALL_UNKNOWN_OUTCOME' : null,
        reservation.id, reservation.attempt,
      )
      if (conclusion === 'closed_unknown') {
        this.db.prepare(`INSERT INTO ai_risk_events(run_id,job_id,code,severity,detail_hash,created_at)
          VALUES(?,?,'AI_EXTERNAL_CALL_UNKNOWN_OUTCOME','P1',?,?)`).run(job.run_id, job.id, input.evidenceHash, now)
      }
      return {
        reservation: mapReservation(this.db.prepare(`SELECT * FROM ai_external_call_reservations WHERE id=?`).get(reservation.id)),
        job: this.getJob(job.id),
      }
    })
  }

  cancelJob(input: { jobId: string, expectedStateVersion: number, reason: string }) {
    assertText(input.jobId)
    assertText(input.reason)
    const now = assertTime(this.now())
    return this.transaction(() => {
      const job = this.db.prepare(`SELECT * FROM ai_jobs WHERE id=?`).get(input.jobId) as any
      if (!job || Number(job.state_version) !== input.expectedStateVersion ||
        ['completed', 'failed', 'cancelled', 'expired', 'superseded'].includes(String(job.state))) fail('AI_JOB_STALE')
      this.db.prepare(`UPDATE ai_external_call_reservations SET state='revoked',updated_at=?
        WHERE job_id=? AND state='reserved'`).run(now, job.id)
      this.db.prepare(`UPDATE ai_outbox SET state='revoked',state_version=state_version+1,updated_at=?
        WHERE job_id=? AND state='pending'`).run(now, job.id)
      const unresolved = this.db.prepare(`SELECT COUNT(*) AS n FROM ai_external_call_reservations
        WHERE job_id=? AND state IN ('sent','reconciling','unknown_outcome')`).get(job.id) as any
      const needsReconciliation = Number(unresolved.n) > 0
      if (needsReconciliation) {
        this.db.prepare(`UPDATE ai_external_call_reservations SET state='reconciling',updated_at=?
          WHERE job_id=? AND state='sent'`).run(now, job.id)
      }
      const changed = this.db.prepare(`UPDATE ai_jobs SET state=?,state_version=state_version+1,
        terminal_intent=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=?
        WHERE id=? AND state_version=?`).run(
        needsReconciliation ? 'reconciling' : 'cancelled', needsReconciliation ? 'cancelled' : null,
        now, job.id, input.expectedStateVersion,
      )
      if (Number(changed.changes) !== 1) fail('AI_JOB_STALE')
      if (!needsReconciliation && Number(job.attempt) > 0) {
        this.db.prepare(`UPDATE ai_job_attempts SET finished_at=?,outcome='cancelled',retryable=0
          WHERE job_id=? AND attempt=? AND finished_at IS NULL`).run(now, job.id, job.attempt)
      }
      return this.getJob(job.id)
    })
  }

  completeJobWithOutbox(input: {
    jobId: string, workerId: string, attempt: number, expectedStateVersion: number,
    checkpoint: unknown, controls: Controls,
    proposal: {
      id: string, revisionId: string, type: string, state: string, contentHash: string,
      targetVersion: string, approvalSetHash: string,
    },
    outbox: {
      id: string, deduplicationKey: string, downstreamKey: string, request: unknown,
      maxAttempts: number, notBefore?: string,
    },
  }) {
    for (const value of [input.jobId, input.workerId, input.proposal?.id, input.proposal?.revisionId, input.proposal?.type,
      input.proposal?.state, input.proposal?.targetVersion, input.outbox?.id, input.outbox?.deduplicationKey,
      input.outbox?.downstreamKey]) assertText(value)
    assertHash(input.proposal.contentHash)
    assertHash(input.proposal.approvalSetHash)
    if (input.proposal.state !== 'approved' || !['business_draft', 'advisory', 'repository_patch_artifact'].includes(input.proposal.type)) {
      fail('AI_APPROVAL_REQUIRED')
    }
    if (!Number.isInteger(input.outbox.maxAttempts) || input.outbox.maxAttempts <= 0) fail('AI_INPUT_INVALID')
    const now = assertTime(this.now())
    const notBefore = assertTime(input.outbox.notBefore ?? now)
    const requestHash = hashCanonical(input.outbox.request)
    return this.transaction(() => {
      const job = this.db.prepare(`SELECT * FROM ai_jobs WHERE id=?`).get(input.jobId) as any
      if (!job || job.state !== 'running' || job.lease_owner !== input.workerId || Number(job.attempt) !== input.attempt ||
        Number(job.state_version) !== input.expectedStateVersion || String(job.lease_expires_at) <= now || job.terminal_intent !== null ||
        job.target_version !== input.proposal.targetVersion) fail('AI_LEASE_LOST')
      checkControls(job, input.controls)
      this.db.prepare(`INSERT INTO ai_proposals
        (id,run_id,job_id,revision_id,proposal_type,state,content_hash,target_version,approval_set_hash,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        input.proposal.id, job.run_id, job.id, input.proposal.revisionId, input.proposal.type, input.proposal.state,
        input.proposal.contentHash, input.proposal.targetVersion, input.proposal.approvalSetHash, now, now,
      )
      this.db.prepare(`INSERT INTO ai_outbox
        (id,tenant_id,scope_id,job_id,proposal_id,state,state_version,deduplication_key,downstream_key,request_hash,
         approval_set_hash,capability_policy_epoch,kill_switch_epoch,attempt,max_attempts,not_before,created_at,updated_at)
        VALUES(?,?,?,?,?,'pending',0,?,?,?,?,?,?,0,?,?,?,?)`).run(
        input.outbox.id, job.tenant_id, job.scope_id, job.id, input.proposal.id,
        input.outbox.deduplicationKey, input.outbox.downstreamKey, requestHash, input.proposal.approvalSetHash,
        job.capability_policy_epoch, job.kill_switch_epoch, input.outbox.maxAttempts, notBefore, now, now,
      )
      const changed = this.db.prepare(`UPDATE ai_jobs SET state='completed',state_version=state_version+1,
        checkpoint_json=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=?
        WHERE id=? AND state='running' AND state_version=? AND lease_owner=? AND attempt=?`).run(
        canonicalize(input.checkpoint), now, job.id, input.expectedStateVersion, input.workerId, input.attempt,
      )
      if (Number(changed.changes) !== 1) fail('AI_LEASE_LOST')
      this.db.prepare(`UPDATE ai_runs SET state=(SELECT CASE
          WHEN EXISTS(SELECT 1 FROM ai_jobs WHERE run_id=? AND state='failed') THEN 'failed'
          WHEN EXISTS(SELECT 1 FROM ai_jobs WHERE run_id=? AND state='expired') THEN 'expired'
          WHEN EXISTS(SELECT 1 FROM ai_jobs WHERE run_id=? AND state='cancelled') THEN 'cancelled'
          WHEN EXISTS(SELECT 1 FROM ai_jobs WHERE run_id=? AND state='superseded') THEN 'superseded'
          ELSE 'completed' END),completed_at=?,updated_at=?
        WHERE id=? AND NOT EXISTS (
          SELECT 1 FROM ai_jobs WHERE run_id=? AND state NOT IN ('completed','failed','cancelled','expired','superseded')
        )`).run(job.run_id, job.run_id, job.run_id, job.run_id, now, now, job.run_id, job.run_id)
      this.db.prepare(`UPDATE ai_job_attempts SET finished_at=?,outcome='completed',retryable=0
        WHERE job_id=? AND attempt=? AND finished_at IS NULL`).run(now, job.id, input.attempt)
      const outboxRow = this.db.prepare(`SELECT * FROM ai_outbox WHERE id=?`).get(input.outbox.id) as any
      this.appendOutboxEvent(outboxRow, null, 'pending', 'created', input.workerId, now)
      return {
        job: this.getJob(job.id),
        proposal: mapProposal(this.db.prepare(`SELECT * FROM ai_proposals WHERE id=?`).get(input.proposal.id)),
        outbox: this.getOutbox(input.outbox.id),
      }
    })
  }

  revokePendingOutbox(input: { outboxId: string, expectedStateVersion: number, reason: string, actor: string }) {
    for (const key of ['outboxId', 'reason', 'actor'] as const) assertText(input[key])
    const now = assertTime(this.now())
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM ai_outbox WHERE id=?`).get(input.outboxId) as any
      if (!row || row.state !== 'pending' || Number(row.state_version) !== input.expectedStateVersion) fail('AI_JOB_STALE')
      const changed = this.db.prepare(`UPDATE ai_outbox SET state='revoked',state_version=state_version+1,last_error_code=?,updated_at=?
        WHERE id=? AND state='pending' AND state_version=?`).run(input.reason, now, row.id, input.expectedStateVersion)
      if (Number(changed.changes) !== 1) fail('AI_JOB_STALE')
      this.db.prepare(`UPDATE ai_proposals SET state='withdrawn',updated_at=? WHERE id=? AND state='approved'`).run(now, row.proposal_id)
      this.appendOutboxEvent(row, 'pending', 'revoked', 'revoked', input.actor, now)
      return this.getOutbox(row.id)
    })
  }

  claimNextOutbox(input: { workerId: string, leaseMs: number, controls: Controls }) {
    assertText(input.workerId)
    const now = assertTime(this.now())
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT o.* FROM ai_outbox o JOIN ai_proposals p ON p.id=o.proposal_id
        WHERE o.state='pending' AND o.not_before<=? AND o.attempt<o.max_attempts AND p.state='approved'
        ORDER BY o.created_at,o.id LIMIT 1`).get(now) as any
      if (!row) return null
      checkControls(row, input.controls)
      const attempt = Number(row.attempt) + 1
      const changed = this.db.prepare(`UPDATE ai_outbox SET state='dispatching',state_version=state_version+1,
        dispatch_owner=?,dispatch_lease_expires_at=?,attempt=?,updated_at=?
        WHERE id=? AND state='pending' AND state_version=?`).run(
        input.workerId, plusMs(now, input.leaseMs), attempt, now, row.id, row.state_version,
      )
      if (Number(changed.changes) !== 1) fail('AI_LEASE_LOST')
      const updated = this.db.prepare(`SELECT * FROM ai_outbox WHERE id=?`).get(row.id) as any
      this.appendOutboxEvent(updated, 'pending', 'dispatching', 'dispatch_claimed', input.workerId, now)
      return mapOutbox(updated)
    })
  }

  markOutboxDelivered(input: {
    outboxId: string, workerId: string, attempt: number, receiptHash: string, responseHash: string,
  }) {
    for (const key of ['outboxId', 'workerId', 'receiptHash', 'responseHash'] as const) assertText(input[key])
    assertHash(input.receiptHash)
    assertHash(input.responseHash)
    const now = assertTime(this.now())
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM ai_outbox WHERE id=?`).get(input.outboxId) as any
      if (!row || row.state !== 'dispatching' || row.dispatch_owner !== input.workerId || Number(row.attempt) !== input.attempt ||
        String(row.dispatch_lease_expires_at) <= now) fail('AI_LEASE_LOST')
      const changed = this.db.prepare(`UPDATE ai_outbox SET state='delivered',state_version=state_version+1,
        receipt_hash=?,response_hash=?,dispatch_owner=NULL,dispatch_lease_expires_at=NULL,updated_at=?
        WHERE id=? AND state='dispatching' AND state_version=? AND dispatch_owner=? AND attempt=?`).run(
        input.receiptHash, input.responseHash, now, row.id, row.state_version, input.workerId, input.attempt,
      )
      if (Number(changed.changes) !== 1) fail('AI_LEASE_LOST')
      this.appendOutboxEvent(row, 'dispatching', 'delivered', 'dispatch_succeeded', input.workerId, now, input.receiptHash)
      return this.getOutbox(row.id)
    })
  }

  markOutboxUncertain(input: { outboxId: string, workerId: string, attempt: number, errorCode: string }) {
    for (const key of ['outboxId', 'workerId', 'errorCode'] as const) assertText(input[key])
    const now = assertTime(this.now())
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM ai_outbox WHERE id=?`).get(input.outboxId) as any
      if (!row || row.state !== 'dispatching' || row.dispatch_owner !== input.workerId || Number(row.attempt) !== input.attempt ||
        String(row.dispatch_lease_expires_at) <= now) fail('AI_LEASE_LOST')
      const changed = this.db.prepare(`UPDATE ai_outbox SET state='reconciling',state_version=state_version+1,
        dispatch_owner=NULL,dispatch_lease_expires_at=NULL,last_error_code=?,updated_at=?
        WHERE id=? AND state='dispatching' AND state_version=? AND dispatch_owner=? AND attempt=?`).run(
        input.errorCode, now, row.id, row.state_version, input.workerId, input.attempt,
      )
      if (Number(changed.changes) !== 1) fail('AI_LEASE_LOST')
      this.appendOutboxEvent(row, 'dispatching', 'reconciling', 'dispatch_uncertain', input.workerId, now)
      return this.getOutbox(row.id)
    })
  }

  resolveOutbox(input: {
    outboxId: string,
    resolution: 'retry_proven_safe' | 'outcome_unprovable' | 'late_receipt_delivered' | 'confirmed_unsent' | 'closed_unknown',
    evidenceHash: string,
    actor: string,
    controls: Controls,
    receiptHash?: string,
    responseHash?: string,
  }) {
    for (const key of ['outboxId', 'resolution', 'actor', 'evidenceHash'] as const) assertText(input[key])
    assertHash(input.evidenceHash)
    if (!OUTBOX_RESOLUTIONS.has(input.resolution)) fail('AI_INPUT_INVALID')
    const now = assertTime(this.now())
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM ai_outbox WHERE id=?`).get(input.outboxId) as any
      if (!row) fail('AI_JOB_STALE')
      let toState: string
      let eventType = input.resolution
      let errorCode: string | null = null
      let receiptHash: string | null = row.receipt_hash ?? null
      let responseHash: string | null = row.response_hash ?? null

      if (input.resolution === 'retry_proven_safe') {
        if (row.state !== 'reconciling') fail('AI_JOB_STALE')
        if (Number(row.attempt) >= Number(row.max_attempts)) {
          toState = 'dead_letter'
          eventType = 'retry_exhausted'
          errorCode = 'AI_OUTBOX_DEAD_LETTER'
        } else {
          this.assertOutboxStillAuthorized(row, input.controls)
          toState = 'pending'
        }
      } else if (input.resolution === 'outcome_unprovable') {
        if (row.state !== 'reconciling') fail('AI_JOB_STALE')
        toState = 'unknown_outcome'
        errorCode = 'AI_OUTBOX_UNKNOWN_OUTCOME'
      } else if (input.resolution === 'late_receipt_delivered') {
        if (row.state !== 'unknown_outcome') fail('AI_JOB_STALE')
        assertHash(input.receiptHash)
        assertHash(input.responseHash)
        toState = 'delivered'
        receiptHash = input.receiptHash!
        responseHash = input.responseHash!
      } else if (input.resolution === 'confirmed_unsent') {
        if (row.state !== 'unknown_outcome') fail('AI_JOB_STALE')
        if (Number(row.attempt) >= Number(row.max_attempts)) {
          toState = 'dead_letter'
          eventType = 'confirmed_unsent_retry_exhausted'
          errorCode = 'AI_OUTBOX_DEAD_LETTER'
        } else {
          this.assertOutboxStillAuthorized(row, input.controls)
          toState = 'pending'
        }
      } else {
        if (row.state !== 'unknown_outcome') fail('AI_JOB_STALE')
        toState = 'resolved_abandoned'
        errorCode = 'AI_OUTBOX_UNKNOWN_OUTCOME'
      }

      const changed = this.db.prepare(`UPDATE ai_outbox SET state=?,state_version=state_version+1,
        dispatch_owner=NULL,dispatch_lease_expires_at=NULL,not_before=?,receipt_hash=?,response_hash=?,last_error_code=?,updated_at=?
        WHERE id=? AND state=? AND state_version=?`).run(
        toState, now, receiptHash, responseHash, errorCode, now, row.id, row.state, row.state_version,
      )
      if (Number(changed.changes) !== 1) fail('AI_JOB_STALE')
      this.appendOutboxEvent(row, row.state, toState, eventType, input.actor, now, input.evidenceHash)
      if (['dead_letter', 'unknown_outcome', 'resolved_abandoned'].includes(toState)) {
        this.db.prepare(`INSERT INTO ai_risk_events(run_id,job_id,code,severity,detail_hash,created_at)
          SELECT j.run_id,j.id,?,'P1',?,? FROM ai_jobs j WHERE j.id=?`).run(
          errorCode, input.evidenceHash, now, row.job_id,
        )
      }
      return this.getOutbox(row.id)
    })
  }

  private assertOutboxStillAuthorized(row: any, controls: Controls) {
    checkControls(row, controls)
    const proposal = this.db.prepare(`SELECT state,approval_set_hash FROM ai_proposals WHERE id=?`).get(row.proposal_id) as any
    if (!proposal || proposal.state !== 'approved' || proposal.approval_set_hash !== row.approval_set_hash) fail('AI_APPROVAL_REQUIRED')
  }

  recoverExpiredLeases() {
    const now = assertTime(this.now())
    return this.transaction(() => {
      let requeued = 0
      let reconciling = 0
      const jobs = this.db.prepare(`SELECT * FROM ai_jobs WHERE state='running' AND lease_expires_at<=? ORDER BY id`).all(now) as any[]
      for (const job of jobs) {
        const unresolved = this.db.prepare(`SELECT COUNT(*) AS n FROM ai_external_call_reservations
          WHERE job_id=? AND state IN ('sent','reconciling','unknown_outcome')`).get(job.id) as any
        const nextState = Number(unresolved.n) > 0 ? 'reconciling' : 'queued'
        const changed = this.db.prepare(`UPDATE ai_jobs SET state=?,state_version=state_version+1,lease_owner=NULL,
          lease_expires_at=NULL,updated_at=? WHERE id=? AND state='running' AND state_version=?`).run(
          nextState, now, job.id, job.state_version,
        )
        if (Number(changed.changes) !== 1) continue
        this.db.prepare(`UPDATE ai_job_attempts SET finished_at=?,outcome='abandoned',error_code='AI_LEASE_LOST',retryable=1
          WHERE job_id=? AND attempt=? AND finished_at IS NULL`).run(now, job.id, job.attempt)
        if (nextState === 'queued') requeued += 1
        else {
          reconciling += 1
          this.db.prepare(`UPDATE ai_external_call_reservations SET state='reconciling',updated_at=?
            WHERE job_id=? AND state='sent'`).run(now, job.id)
        }
      }
      return { requeued, reconciling }
    })
  }

  recoverExpiredOutboxLeases() {
    const now = assertTime(this.now())
    return this.transaction(() => {
      let reconciling = 0
      const rows = this.db.prepare(`SELECT * FROM ai_outbox
        WHERE state='dispatching' AND dispatch_lease_expires_at<=? ORDER BY id`).all(now) as any[]
      for (const row of rows) {
        const changed = this.db.prepare(`UPDATE ai_outbox SET state='reconciling',state_version=state_version+1,
          dispatch_owner=NULL,dispatch_lease_expires_at=NULL,last_error_code='AI_OUTBOX_DISPATCH_LEASE_LOST',updated_at=?
          WHERE id=? AND state='dispatching' AND state_version=?`).run(now, row.id, row.state_version)
        if (Number(changed.changes) !== 1) continue
        this.appendOutboxEvent(row, 'dispatching', 'reconciling', 'dispatch_lease_expired', 'system', now)
        reconciling += 1
      }
      return { reconciling }
    })
  }
}

export function createAiDurableStore(db: DatabaseSync, options: StoreOptions = {}) {
  return new AiDurableStore(db, options)
}
