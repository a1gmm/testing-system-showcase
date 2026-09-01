import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../src/db.ts'

test('AI-0003 migration creates the complete durable boundary with database-enforced idempotency', () => {
  const db = openDb(':memory:')
  try {
    const tables = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ai_%'`).all() as any[])
      .map(row => String(row.name)))
    assert.deepEqual([...tables].sort(), [
      'ai_artifacts',
      'ai_external_call_attempts',
      'ai_external_call_reservations',
      'ai_external_call_resolutions',
      'ai_job_attempts',
      'ai_jobs',
      'ai_outbox',
      'ai_outbox_events',
      'ai_proposals',
      'ai_risk_events',
      'ai_runs',
    ])

    const jobIndexes = db.prepare(`PRAGMA index_list(ai_jobs)`).all() as any[]
    const idempotency = jobIndexes.find(index => Number(index.unique) === 1 && String(index.name).includes('idempotency'))
    assert.ok(idempotency, 'ai_jobs must enforce scoped idempotency with a unique database index')
    const columns = (db.prepare(`PRAGMA index_info(${idempotency.name})`).all() as any[]).map(row => String(row.name))
    assert.deepEqual(columns, ['tenant_id', 'scope_kind', 'scope_id', 'idempotency_key', 'target_version'])
  } finally {
    db.close()
  }
})

test('scoped creation is idempotent, conflicting bytes fail closed, and a claimed checkpoint survives restart', async () => {
  const module = await import('../src/ai/durable-store.ts').catch(() => ({} as any)) as any
  const root = mkdtempSync(join(tmpdir(), 'ai-durable-job-'))
  const dbPath = join(root, 'data.db')
  let now = '2026-09-01T06:20:00.000Z'
  const controls = { enabled: true, killSwitchActive: false, capabilityPolicyEpoch: 3, killSwitchEpoch: 7 }
  const input = {
    runId: 'run_fixture_0001', tenantId: 'tenant-fixture', scopeKind: 'standard_library', scopeId: 'standards-fixture',
    jobType: 'standards.evidence.v1', idempotencyKey: 'standard-change-0001', targetVersion: 'templates-v1',
    request: { eventId: 'event-0001', targetVersion: 'templates-v1' }, inputSnapshotId: 'snapshot-fixture-v1',
    capabilityPolicyEpoch: 3, killSwitchEpoch: 7, maxAttempts: 3, expiresAt: '2026-09-01T08:20:00.000Z', controls,
  }

  try {
    const firstDb = openDb(dbPath)
    const firstStore = module.createAiDurableStore?.(firstDb, { now: () => now })
    const created = firstStore?.createJob(input)
    assert.equal(created?.replayed, false)
    assert.equal(created?.job.state, 'queued')
    assert.match(created?.job.id, /^job_[0-9a-f]{24}$/)

    const replay = firstStore.createJob(input)
    assert.equal(replay.replayed, true)
    assert.equal(replay.job.id, created.job.id)
    assert.equal((firstDb.prepare(`SELECT COUNT(*) AS n FROM ai_jobs`).get() as any).n, 1)
    assert.throws(
      () => firstStore.createJob({ ...input, runId: 'run_fixture_drifted' }),
      (error: any) => error?.code === 'AI_IDEMPOTENCY_CONFLICT',
    )
    assert.equal((firstDb.prepare(`SELECT COUNT(*) AS n FROM ai_runs`).get() as any).n, 1, 'conflicting replay must not leak an orphan run')
    assert.throws(
      () => firstStore.createJob({
        ...input, tenantId: 'tenant-cross-scope', scopeId: 'standards-cross-scope', idempotencyKey: 'cross-scope-attempt',
      }),
      (error: any) => error?.code === 'AI_SCOPE_DENIED',
    )
    assert.equal((firstDb.prepare(`SELECT COUNT(*) AS n FROM ai_jobs`).get() as any).n, 1, 'a run id cannot be rebound across tenant or scope')
    assert.throws(
      () => firstStore.createJob({ ...input, request: { eventId: 'different-event', targetVersion: 'templates-v1' } }),
      (error: any) => error?.code === 'AI_IDEMPOTENCY_CONFLICT',
    )
    assert.throws(
      () => firstStore.createJob({ ...input, idempotencyKey: 'disabled', controls: { ...controls, enabled: false } }),
      (error: any) => error?.code === 'AI_CAPABILITY_DISABLED',
    )
    assert.throws(
      () => firstStore.createJob({ ...input, idempotencyKey: 'kill-switch', controls: { ...controls, killSwitchActive: true } }),
      (error: any) => error?.code === 'AI_KILL_SWITCH_ACTIVE',
    )

    const claimed = firstStore.claimNextJob({
      workerId: 'worker-a', leaseMs: 30_000,
      controls,
    })
    assert.equal(claimed.state, 'running')
    assert.equal(claimed.attempt, 1)
    assert.equal(claimed.leaseOwner, 'worker-a')
    assert.equal(firstStore.claimNextJob({ workerId: 'worker-b', leaseMs: 30_000, controls }), null)

    now = '2026-09-01T06:20:10.000Z'
    const checkpointed = firstStore.checkpoint({
      jobId: claimed.id, workerId: 'worker-a', attempt: 1, expectedStateVersion: claimed.stateVersion,
      value: { completedStep: 'evidence' }, leaseMs: 30_000, controls,
    })
    assert.deepEqual(checkpointed.checkpoint, { completedStep: 'evidence' })
    assert.throws(
      () => firstStore.checkpoint({
        jobId: claimed.id, workerId: 'worker-stale', attempt: 1, expectedStateVersion: checkpointed.stateVersion,
        value: { completedStep: 'must-not-write' }, leaseMs: 30_000, controls,
      }),
      (error: any) => error?.code === 'AI_LEASE_LOST',
    )
    now = '2026-09-01T06:20:40.000Z'
    assert.throws(
      () => firstStore.checkpoint({
        jobId: claimed.id, workerId: 'worker-a', attempt: 1, expectedStateVersion: checkpointed.stateVersion,
        value: { completedStep: 'must-not-write-at-expiry' }, leaseMs: 30_000, controls,
      }),
      (error: any) => error?.code === 'AI_LEASE_LOST',
      'a lease is no longer owned at the exact expiry instant',
    )
    firstDb.close()

    now = '2026-09-01T06:20:41.000Z'
    const restartedDb = openDb(dbPath)
    const restartedStore = module.createAiDurableStore(restartedDb, { now: () => now })
    assert.deepEqual(restartedStore.getJob(claimed.id).checkpoint, { completedStep: 'evidence' })
    assert.deepEqual(restartedStore.recoverExpiredLeases(), { requeued: 1, reconciling: 0 })
    const recovered = restartedStore.getJob(claimed.id)
    assert.equal(recovered.state, 'queued')
    assert.equal(recovered.leaseOwner, null)
    assert.equal((restartedDb.prepare(`SELECT outcome FROM ai_job_attempts WHERE job_id=? AND attempt=1`).get(claimed.id) as any).outcome, 'abandoned')
    restartedDb.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('valid RFC 3339 input times are normalized before lexical SQLite scheduling comparisons', async () => {
  const { createAiDurableStore } = await import('../src/ai/durable-store.ts')
  const db = openDb(':memory:')
  const controls = { enabled: true, killSwitchActive: false, capabilityPolicyEpoch: 3, killSwitchEpoch: 7 }
  const store = createAiDurableStore(db, { now: () => '2026-09-01T06:20:00Z' })
  try {
    const created = store.createJob({
      runId: 'run_time_normalization', tenantId: 'tenant-fixture', scopeKind: 'standard_library', scopeId: 'standards-fixture',
      jobType: 'standards.evidence.v1', idempotencyKey: 'time-normalization', targetVersion: 'templates-v1',
      request: { eventId: 'event-time-normalization' }, inputSnapshotId: 'snapshot-time-normalization',
      capabilityPolicyEpoch: 3, killSwitchEpoch: 7, maxAttempts: 3,
      notBefore: '2026-09-01T07:20:00+01:00', expiresAt: '2026-09-01T10:20:00+01:00', controls,
    })
    assert.equal(created.job.notBefore, '2026-09-01T06:20:00.000Z')
    assert.equal(created.job.expiresAt, '2026-09-01T09:20:00.000Z')
    assert.equal(created.job.createdAt, '2026-09-01T06:20:00.000Z')
    assert.equal(store.claimNextJob({ workerId: 'worker-time-normalization', leaseMs: 30_000, controls }).id, created.job.id)
    assert.throws(
      () => store.createJob({
        runId: 'run_loose_time', tenantId: 'tenant-fixture', scopeKind: 'standard_library', scopeId: 'standards-fixture',
        jobType: 'standards.evidence.v1', idempotencyKey: 'loose-time', targetVersion: 'templates-v1',
        request: { eventId: 'event-loose-time' }, inputSnapshotId: 'snapshot-loose-time',
        capabilityPolicyEpoch: 3, killSwitchEpoch: 7, maxAttempts: 3,
        expiresAt: 'September 1, 2026 09:20 UTC', controls,
      }),
      (error: any) => error?.code === 'AI_INPUT_INVALID',
      'loose implementation-defined dates are not an accepted scheduling contract',
    )
  } finally {
    db.close()
  }
})

test('cancellation revokes a reserved call but preserves a sent call for reconciliation', async () => {
  const { createAiDurableStore } = await import('../src/ai/durable-store.ts')
  const db = openDb(':memory:')
  let now = '2026-09-01T06:30:00.000Z'
  const controls = { enabled: true, killSwitchActive: false, capabilityPolicyEpoch: 3, killSwitchEpoch: 7 }
  const store = createAiDurableStore(db, { now: () => now })
  const create = (suffix: string) => store.createJob({
    runId: `run_cancel_${suffix}`, tenantId: 'tenant-fixture', scopeKind: 'standard_library', scopeId: 'standards-fixture',
    jobType: 'standards.evidence.v1', idempotencyKey: `cancel-${suffix}`, targetVersion: 'templates-v1',
    request: { eventId: `event-${suffix}` }, inputSnapshotId: `snapshot-${suffix}`,
    capabilityPolicyEpoch: 3, killSwitchEpoch: 7, maxAttempts: 3, expiresAt: '2026-09-01T08:30:00.000Z', controls,
  }).job

  try {
    const beforeSendJob = create('before-send')
    const beforeSendClaim = store.claimNextJob({ workerId: 'worker-a', leaseMs: 60_000, controls })
    assert.equal(beforeSendClaim.id, beforeSendJob.id)
    const reserved = store.reserveExternalCall?.({
      jobId: beforeSendJob.id, workerId: 'worker-a', attempt: 1, expectedStateVersion: beforeSendClaim.stateVersion,
      logicalCallId: 'logical-before-send', downstreamKey: 'provider-key-before-send', request: { promptHash: 'a'.repeat(64) },
      permissionProjectionHash: 'b'.repeat(64), leaseMs: 30_000, maxAttempts: 2, controls,
    })
    assert.equal(reserved?.state, 'reserved')
    const cancelled = store.cancelJob({ jobId: beforeSendJob.id, expectedStateVersion: beforeSendClaim.stateVersion, reason: 'user_cancelled' })
    assert.equal(cancelled.state, 'cancelled')
    assert.equal((db.prepare(`SELECT state FROM ai_external_call_reservations WHERE id=?`).get(reserved.id) as any).state, 'revoked')

    now = '2026-09-01T06:31:00.000Z'
    const afterSendJob = create('after-send')
    const afterSendClaim = store.claimNextJob({ workerId: 'worker-b', leaseMs: 60_000, controls })
    assert.equal(afterSendClaim.id, afterSendJob.id)
    const secondReservation = store.reserveExternalCall({
      jobId: afterSendJob.id, workerId: 'worker-b', attempt: 1, expectedStateVersion: afterSendClaim.stateVersion,
      logicalCallId: 'logical-after-send', downstreamKey: 'provider-key-after-send', request: { promptHash: 'c'.repeat(64) },
      permissionProjectionHash: 'd'.repeat(64), leaseMs: 30_000, maxAttempts: 2, controls,
    })
    const sent = store.markExternalCallSent({
      reservationId: secondReservation.id, jobId: afterSendJob.id, workerId: 'worker-b', attempt: 1, controls,
    })
    assert.equal(sent.state, 'sent')
    const reconciling = store.cancelJob({ jobId: afterSendJob.id, expectedStateVersion: afterSendClaim.stateVersion, reason: 'user_cancelled' })
    assert.equal(reconciling.state, 'reconciling')
    assert.equal(reconciling.terminalIntent, 'cancelled')
    assert.equal((db.prepare(`SELECT state FROM ai_external_call_reservations WHERE id=?`).get(secondReservation.id) as any).state, 'reconciling')
    assert.throws(
      () => store.checkpoint({
        jobId: afterSendJob.id, workerId: 'worker-b', attempt: 1, expectedStateVersion: reconciling.stateVersion,
        value: { unsafe: 'late result' }, leaseMs: 30_000, controls,
      }),
      (error: any) => error?.code === 'AI_LEASE_LOST',
    )
    const unknown = store.resolveExternalCall?.({
      reservationId: secondReservation.id, resolution: 'outcome_unprovable', evidenceHash: 'e'.repeat(64),
      actor: 'reconciler', controls,
    })
    assert.equal(unknown?.reservation.state, 'unknown_outcome')
    assert.equal(unknown?.job.state, 'unknown_outcome')
    assert.equal(unknown?.job.terminalIntent, 'cancelled')
    assert.throws(
      () => store.resolveExternalCall({
        reservationId: secondReservation.id, resolution: 'invented_resolution' as any, evidenceHash: 'e'.repeat(64),
        actor: 'reconciler', controls,
      }),
      (error: any) => error?.code === 'AI_INPUT_INVALID',
    )
    assert.equal(store.getJob(afterSendJob.id).state, 'unknown_outcome')
    const lateReceipt = store.resolveExternalCall({
      reservationId: secondReservation.id, resolution: 'confirmed_executed', evidenceHash: 'f'.repeat(64),
      actor: 'quality-owner', controls, receiptHash: '1'.repeat(64), responseHash: '2'.repeat(64),
    })
    assert.equal(lateReceipt.reservation.state, 'resolved_finished')
    assert.equal(lateReceipt.job.state, 'cancelled')
    assert.equal((db.prepare(`SELECT conclusion FROM ai_external_call_resolutions WHERE reservation_id=?`).get(secondReservation.id) as any).conclusion, 'confirmed_executed')
  } finally {
    db.close()
  }
})

test('a worker can atomically claim the exact job it was asked to run without stealing an older queued job', async () => {
  const { createAiDurableStore } = await import('../src/ai/durable-store.ts')
  const db = openDb(':memory:')
  const now = '2026-09-01T06:35:00.000Z'
  const controls = { enabled: true, killSwitchActive: false, capabilityPolicyEpoch: 3, killSwitchEpoch: 7 }
  const store = createAiDurableStore(db, { now: () => now })
  const create = (suffix: string) => store.createJob({
    runId: `run_exact_${suffix}`, tenantId: 'tenant-fixture', scopeKind: 'standard_library', scopeId: 'standards-fixture',
    jobType: 'standards.evidence.v1', idempotencyKey: `exact-${suffix}`, targetVersion: 'templates-v1',
    request: { eventId: `event-${suffix}` }, inputSnapshotId: `snapshot-${suffix}`,
    capabilityPolicyEpoch: 3, killSwitchEpoch: 7, maxAttempts: 3, expiresAt: '2026-09-01T08:35:00.000Z', controls,
  }).job
  try {
    const older = create('older')
    const requested = create('requested')
    const claimed = store.claimJob?.({ jobId: requested.id, workerId: 'worker-exact', leaseMs: 30_000, controls })
    assert.equal(claimed?.id, requested.id)
    assert.equal(claimed?.state, 'running')
    assert.equal(store.getJob(older.id).state, 'queued')
    assert.throws(
      () => store.claimJob({ jobId: requested.id, workerId: 'worker-stale', leaseMs: 30_000, controls }),
      (error: any) => error?.code === 'AI_LEASE_LOST',
    )
  } finally {
    db.close()
  }
})

test('a completed job keeps a cancellable pending outbox and the dispatch cutover records immediate delivery', async () => {
  const { createAiDurableStore } = await import('../src/ai/durable-store.ts')
  const db = openDb(':memory:')
  let now = '2026-09-01T06:40:00.000Z'
  const controls = { enabled: true, killSwitchActive: false, capabilityPolicyEpoch: 3, killSwitchEpoch: 7 }
  const store = createAiDurableStore(db, { now: () => now })
  const makeCompletedOutbox = (suffix: string) => {
    const job = store.createJob({
      runId: `run_outbox_${suffix}`, tenantId: 'tenant-fixture', scopeKind: 'standard_library', scopeId: 'standards-fixture',
      jobType: 'standards.template-impact.v1', idempotencyKey: `outbox-${suffix}`, targetVersion: 'templates-v1',
      request: { eventId: `event-${suffix}` }, inputSnapshotId: `snapshot-${suffix}`,
      capabilityPolicyEpoch: 3, killSwitchEpoch: 7, maxAttempts: 3, expiresAt: '2026-09-01T08:40:00.000Z', controls,
    }).job
    const claimed = store.claimNextJob({ workerId: `worker-${suffix}`, leaseMs: 60_000, controls })
    const completed = store.completeJobWithOutbox?.({
      jobId: job.id, workerId: `worker-${suffix}`, attempt: 1, expectedStateVersion: claimed.stateVersion,
      checkpoint: { completedStep: 'proposal' }, controls,
      proposal: {
        id: `proposal-${suffix}`, revisionId: `revision-${suffix}`, type: 'business_draft', state: 'approved',
        contentHash: 'a'.repeat(64), targetVersion: 'templates-v1', approvalSetHash: 'b'.repeat(64),
      },
      outbox: {
        id: `outbox-${suffix}`, deduplicationKey: `apply-${suffix}`, downstreamKey: `downstream-${suffix}`,
        request: { proposalId: `proposal-${suffix}`, revisionId: `revision-${suffix}` }, maxAttempts: 2,
      },
    })
    assert.equal(completed?.job.state, 'completed')
    assert.equal(completed?.outbox.state, 'pending')
    return completed
  }

  try {
    const cancellable = makeCompletedOutbox('cancel')
    const revoked = store.revokePendingOutbox({
      outboxId: cancellable.outbox.id, expectedStateVersion: cancellable.outbox.stateVersion,
      reason: 'approval_revoked', actor: 'quality-owner',
    })
    assert.equal(revoked.state, 'revoked')
    assert.equal((db.prepare(`SELECT state FROM ai_proposals WHERE id=?`).get(cancellable.proposal.id) as any).state, 'withdrawn')
    assert.equal(store.getJob(cancellable.job.id).state, 'completed')

    now = '2026-09-01T06:41:00.000Z'
    const deliverable = makeCompletedOutbox('deliver')
    const dispatching = store.claimNextOutbox({ workerId: 'dispatcher-a', leaseMs: 30_000, controls })
    assert.equal(dispatching.id, deliverable.outbox.id)
    assert.equal(dispatching.state, 'dispatching')
    assert.equal(dispatching.attempt, 1)
    const delivered = store.markOutboxDelivered({
      outboxId: dispatching.id, workerId: 'dispatcher-a', attempt: 1,
      receiptHash: 'c'.repeat(64), responseHash: 'd'.repeat(64),
    })
    assert.equal(delivered.state, 'delivered')
    assert.equal(delivered.receiptHash, 'c'.repeat(64))
    assert.deepEqual(
      (db.prepare(`SELECT from_state,to_state,event_type FROM ai_outbox_events WHERE outbox_id=? ORDER BY id`).all(dispatching.id) as any[])
        .map(row => [row.from_state, row.to_state, row.event_type]),
      [[null, 'pending', 'created'], ['pending', 'dispatching', 'dispatch_claimed'], ['dispatching', 'delivered', 'dispatch_succeeded']],
    )
  } finally {
    db.close()
  }
})

test('a run is not marked completed when any sibling job ended unsuccessfully', async () => {
  const { createAiDurableStore } = await import('../src/ai/durable-store.ts')
  const db = openDb(':memory:')
  const now = '2026-09-01T06:50:00.000Z'
  const controls = { enabled: true, killSwitchActive: false, capabilityPolicyEpoch: 3, killSwitchEpoch: 7 }
  const store = createAiDurableStore(db, { now: () => now })
  const runEnvelope = { purpose: 'shared-run-fixture' }
  const create = (suffix: string) => store.createJob({
    runId: 'run_with_failed_sibling', runEnvelope, tenantId: 'tenant-fixture', scopeKind: 'standard_library', scopeId: 'standards-fixture',
    jobType: 'standards.template-impact.v1', idempotencyKey: `run-sibling-${suffix}`, targetVersion: 'templates-v1',
    request: { eventId: `event-${suffix}` }, inputSnapshotId: `snapshot-${suffix}`,
    capabilityPolicyEpoch: 3, killSwitchEpoch: 7, maxAttempts: 3, expiresAt: '2026-09-01T08:50:00.000Z', controls,
  }).job
  try {
    const successful = create('successful')
    const failed = create('failed')
    db.prepare(`UPDATE ai_jobs SET state='failed',error_code='AI_TEST_FAILURE' WHERE id=?`).run(failed.id)
    const claimed = store.claimJob({ jobId: successful.id, workerId: 'worker-successful', leaseMs: 60_000, controls })
    store.completeJobWithOutbox({
      jobId: successful.id, workerId: 'worker-successful', attempt: 1, expectedStateVersion: claimed.stateVersion,
      checkpoint: { completedStep: 'proposal' }, controls,
      proposal: {
        id: 'proposal-successful-sibling', revisionId: 'revision-successful-sibling', type: 'business_draft', state: 'approved',
        contentHash: 'a'.repeat(64), targetVersion: 'templates-v1', approvalSetHash: 'b'.repeat(64),
      },
      outbox: {
        id: 'outbox-successful-sibling', deduplicationKey: 'apply-successful-sibling', downstreamKey: 'downstream-successful-sibling',
        request: { proposalId: 'proposal-successful-sibling' }, maxAttempts: 2,
      },
    })
    assert.equal((db.prepare(`SELECT state FROM ai_runs WHERE id=?`).get('run_with_failed_sibling') as any).state, 'failed')
  } finally {
    db.close()
  }
})

test('outbox uncertainty uses the original downstream key, bounds retries, and resolves unknown outcomes with evidence', async () => {
  const { createAiDurableStore } = await import('../src/ai/durable-store.ts')
  const db = openDb(':memory:')
  let clock = 0
  const now = () => new Date(Date.parse('2026-09-01T07:00:00.000Z') + clock++ * 1_000).toISOString()
  const controls = { enabled: true, killSwitchActive: false, capabilityPolicyEpoch: 3, killSwitchEpoch: 7 }
  const store = createAiDurableStore(db, { now })
  const createOutbox = (suffix: string, maxAttempts = 2) => {
    const job = store.createJob({
      runId: `run_uncertain_${suffix}`, tenantId: 'tenant-fixture', scopeKind: 'standard_library', scopeId: 'standards-fixture',
      jobType: 'standards.template-impact.v1', idempotencyKey: `uncertain-${suffix}`, targetVersion: 'templates-v1',
      request: { eventId: `event-${suffix}` }, inputSnapshotId: `snapshot-${suffix}`,
      capabilityPolicyEpoch: 3, killSwitchEpoch: 7, maxAttempts: 3, expiresAt: '2026-09-01T10:00:00.000Z', controls,
    }).job
    const worker = `worker-${suffix}`
    const claimed = store.claimNextJob({ workerId: worker, leaseMs: 60_000, controls })
    return store.completeJobWithOutbox({
      jobId: job.id, workerId: worker, attempt: 1, expectedStateVersion: claimed.stateVersion,
      checkpoint: { completedStep: 'proposal' }, controls,
      proposal: {
        id: `proposal-${suffix}`, revisionId: `revision-${suffix}`, type: 'business_draft', state: 'approved',
        contentHash: 'a'.repeat(64), targetVersion: 'templates-v1', approvalSetHash: 'b'.repeat(64),
      },
      outbox: {
        id: `outbox-${suffix}`, deduplicationKey: `apply-${suffix}`, downstreamKey: `stable-key-${suffix}`,
        request: { proposalId: `proposal-${suffix}` }, maxAttempts,
      },
    }).outbox
  }
  const dispatchAndLose = (outboxId: string, dispatcher: string) => {
    const dispatching = store.claimNextOutbox({ workerId: dispatcher, leaseMs: 30_000, controls })
    assert.equal(dispatching.id, outboxId)
    return store.markOutboxUncertain?.({
      outboxId, workerId: dispatcher, attempt: dispatching.attempt, errorCode: 'AI_PROVIDER_TIMEOUT',
    })
  }

  try {
    const bounded = createOutbox('bounded', 2)
    const firstLoss = dispatchAndLose(bounded.id, 'dispatcher-bounded-1')
    assert.equal(firstLoss?.state, 'reconciling')
    const safeRetry = store.resolveOutbox({
      outboxId: bounded.id, resolution: 'retry_proven_safe', evidenceHash: 'c'.repeat(64),
      actor: 'reconciler', controls,
    })
    assert.equal(safeRetry.state, 'pending')
    assert.equal(safeRetry.downstreamKey, bounded.downstreamKey)
    const secondLoss = dispatchAndLose(bounded.id, 'dispatcher-bounded-2')
    assert.equal(secondLoss.state, 'reconciling')
    const exhausted = store.resolveOutbox({
      outboxId: bounded.id, resolution: 'retry_proven_safe', evidenceHash: 'd'.repeat(64),
      actor: 'reconciler', controls,
    })
    assert.equal(exhausted.state, 'dead_letter')
    assert.equal(exhausted.lastErrorCode, 'AI_OUTBOX_DEAD_LETTER')

    const late = createOutbox('late')
    dispatchAndLose(late.id, 'dispatcher-late')
    assert.equal(store.resolveOutbox({
      outboxId: late.id, resolution: 'outcome_unprovable', evidenceHash: 'e'.repeat(64), actor: 'reconciler', controls,
    }).state, 'unknown_outcome')
    const lateDelivered = store.resolveOutbox({
      outboxId: late.id, resolution: 'late_receipt_delivered', evidenceHash: 'f'.repeat(64), actor: 'quality-owner', controls,
      receiptHash: '1'.repeat(64), responseHash: '2'.repeat(64),
    })
    assert.equal(lateDelivered.state, 'delivered')

    const unsent = createOutbox('unsent')
    dispatchAndLose(unsent.id, 'dispatcher-unsent')
    store.resolveOutbox({
      outboxId: unsent.id, resolution: 'outcome_unprovable', evidenceHash: '3'.repeat(64), actor: 'reconciler', controls,
    })
    const retryFromUnknown = store.resolveOutbox({
      outboxId: unsent.id, resolution: 'confirmed_unsent', evidenceHash: '4'.repeat(64), actor: 'quality-owner', controls,
    })
    assert.equal(retryFromUnknown.state, 'pending')
    assert.equal(retryFromUnknown.downstreamKey, unsent.downstreamKey)
    store.revokePendingOutbox({
      outboxId: unsent.id, expectedStateVersion: retryFromUnknown.stateVersion,
      reason: 'test_cleanup_after_unsent_proof', actor: 'quality-owner',
    })

    const abandoned = createOutbox('abandoned')
    dispatchAndLose(abandoned.id, 'dispatcher-abandoned')
    store.resolveOutbox({
      outboxId: abandoned.id, resolution: 'outcome_unprovable', evidenceHash: '5'.repeat(64), actor: 'reconciler', controls,
    })
    assert.throws(
      () => store.resolveOutbox({
        outboxId: abandoned.id, resolution: 'invented_resolution' as any, evidenceHash: '6'.repeat(64), actor: 'quality-owner', controls,
      }),
      (error: any) => error?.code === 'AI_INPUT_INVALID',
    )
    assert.equal(store.getOutbox(abandoned.id).state, 'unknown_outcome')
    assert.equal(store.resolveOutbox({
      outboxId: abandoned.id, resolution: 'closed_unknown', evidenceHash: '6'.repeat(64), actor: 'quality-owner', controls,
    }).state, 'resolved_abandoned')

    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ai_outbox_events WHERE outbox_id=?`).get(late.id) as any).n, 5)
  } finally {
    db.close()
  }
})

test('an expired dispatch lease enters reconciliation instead of silently retrying a possibly-sent effect', async () => {
  const { createAiDurableStore } = await import('../src/ai/durable-store.ts')
  const db = openDb(':memory:')
  let now = '2026-09-01T07:20:00.000Z'
  const controls = { enabled: true, killSwitchActive: false, capabilityPolicyEpoch: 3, killSwitchEpoch: 7 }
  const store = createAiDurableStore(db, { now: () => now })
  try {
    const job = store.createJob({
      runId: 'run_dispatch_crash', tenantId: 'tenant-fixture', scopeKind: 'standard_library', scopeId: 'standards-fixture',
      jobType: 'standards.template-impact.v1', idempotencyKey: 'dispatch-crash', targetVersion: 'templates-v1',
      request: { eventId: 'event-dispatch-crash' }, inputSnapshotId: 'snapshot-dispatch-crash',
      capabilityPolicyEpoch: 3, killSwitchEpoch: 7, maxAttempts: 3, expiresAt: '2026-09-01T10:20:00.000Z', controls,
    }).job
    const claimed = store.claimNextJob({ workerId: 'worker-dispatch-crash', leaseMs: 60_000, controls })
    const completed = store.completeJobWithOutbox({
      jobId: job.id, workerId: 'worker-dispatch-crash', attempt: 1, expectedStateVersion: claimed.stateVersion,
      checkpoint: { completedStep: 'proposal' }, controls,
      proposal: {
        id: 'proposal-dispatch-crash', revisionId: 'revision-dispatch-crash', type: 'business_draft', state: 'approved',
        contentHash: 'a'.repeat(64), targetVersion: 'templates-v1', approvalSetHash: 'b'.repeat(64),
      },
      outbox: {
        id: 'outbox-dispatch-crash', deduplicationKey: 'apply-dispatch-crash', downstreamKey: 'stable-dispatch-key',
        request: { proposalId: 'proposal-dispatch-crash' }, maxAttempts: 2,
      },
    })
    const dispatching = store.claimNextOutbox({ workerId: 'dispatcher-that-crashes', leaseMs: 30_000, controls })
    assert.equal(dispatching.id, completed.outbox.id)

    now = '2026-09-01T07:20:31.000Z'
    assert.deepEqual(store.recoverExpiredOutboxLeases?.(), { reconciling: 1 })
    const recovered = store.getOutbox(dispatching.id)
    assert.equal(recovered.state, 'reconciling')
    assert.equal(recovered.downstreamKey, 'stable-dispatch-key')
    assert.equal(recovered.dispatchOwner, null)
    assert.equal(recovered.lastErrorCode, 'AI_OUTBOX_DISPATCH_LEASE_LOST')
    assert.equal(store.claimNextOutbox({ workerId: 'unsafe-automatic-retry', leaseMs: 30_000, controls }), null)
  } finally {
    db.close()
  }
})

test('the AI connection waits at most the bounded busy timeout and reports AI_DB_BUSY without taking the core write lock', async () => {
  const { createAiDurableStore } = await import('../src/ai/durable-store.ts')
  const root = mkdtempSync(join(tmpdir(), 'ai-durable-busy-'))
  const dbPath = join(root, 'data.db')
  const coreDb = openDb(dbPath)
  const aiDb = openDb(dbPath)
  const store = createAiDurableStore(aiDb, { now: () => '2026-09-01T07:30:00.000Z' })
  try {
    assert.equal(Number((aiDb.prepare(`PRAGMA busy_timeout`).get() as any).timeout), 250)
    coreDb.exec('BEGIN IMMEDIATE')
    const started = Date.now()
    assert.throws(
      () => store.createJob({
        runId: 'run_busy', tenantId: 'tenant-fixture', scopeKind: 'standard_library', scopeId: 'standards-fixture',
        jobType: 'standards.evidence.v1', idempotencyKey: 'busy', targetVersion: 'templates-v1', request: { eventId: 'busy' },
        inputSnapshotId: 'snapshot-busy', capabilityPolicyEpoch: 3, killSwitchEpoch: 7, maxAttempts: 2,
        expiresAt: '2026-09-01T09:30:00.000Z',
        controls: { enabled: true, killSwitchActive: false, capabilityPolicyEpoch: 3, killSwitchEpoch: 7 },
      }),
      (error: any) => error?.code === 'AI_DB_BUSY',
    )
    assert.ok(Date.now() - started < 1_000, 'AI lock wait must remain bounded well below the core request timeout')
    coreDb.exec('ROLLBACK')
    assert.equal((coreDb.prepare(`SELECT COUNT(*) AS n FROM ai_jobs`).get() as any).n, 0)
  } finally {
    try { coreDb.exec('ROLLBACK') } catch {}
    aiDb.close()
    coreDb.close()
    rmSync(root, { recursive: true, force: true })
  }
})
