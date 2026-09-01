import type { DatabaseSync } from 'node:sqlite'

import { AiDurableError, createAiDurableStore } from './durable-store.ts'
import { createOfflineStandardChangeTracer, hashCanonical, stableId } from './phase0/index.ts'

type PersistedTracerInput = {
  db: DatabaseSync
  input: Record<string, any>
  workerId: string
  now?: () => string
}

const LEASE_MS = 60_000

function controlsFor(input: Record<string, any>) {
  return {
    enabled: input.capabilityEnabled,
    killSwitchActive: input.killSwitchActive,
    capabilityPolicyEpoch: input.currentCapabilityPolicyEpoch,
    killSwitchEpoch: input.currentKillSwitchEpoch,
  }
}

function persistedResult(job: any) {
  if (job?.checkpoint?.kind !== 'standard_change_tracer_result_v1' || !job.checkpoint.result) {
    return null
  }
  return structuredClone(job.checkpoint.result)
}

function noOutboxRunState(state: string) {
  return new Set(['awaiting_human', 'no_change', 'rejected', 'superseded', 'apply_failed', 'policy_stopped', 'failed']).has(state)
}

export function runPersistedStandardChangeTracer({ db, input, workerId, now = () => new Date().toISOString() }: PersistedTracerInput) {
  const store = createAiDurableStore(db, { now })
  const runId = stableId('run', hashCanonical(input.envelope))
  const snapshotId = stableId('snp', hashCanonical(input.targetSnapshot))
  const controls = controlsFor(input)
  const created = store.createJob({
    runId,
    runEnvelope: input.envelope,
    tenantId: input.envelope.tenantId,
    scopeKind: input.envelope.scope.kind,
    scopeId: input.envelope.scope.scopeId,
    jobType: 'standard-change-tracer.v1',
    idempotencyKey: input.envelope.idempotencyKey,
    targetVersion: input.envelope.targetVersion,
    request: input,
    inputSnapshotId: snapshotId,
    capabilityPolicyEpoch: input.envelope.capabilityPolicyEpoch,
    killSwitchEpoch: input.envelope.killSwitchEpoch,
    controls,
    maxAttempts: 3,
    expiresAt: new Date(Date.parse(now()) + 60 * 60_000).toISOString(),
  })

  if (created.replayed) {
    const result = persistedResult(created.job)
    if (!result) {
      const errorCode = created.job?.checkpoint?.kind === 'standard_change_tracer_error_v1'
        ? created.job.checkpoint.errorCode : 'AI_JOB_IN_PROGRESS'
      throw new AiDurableError(typeof errorCode === 'string' && errorCode ? errorCode : 'AI_STORAGE_CORRUPT')
    }
    const outbox = db.prepare(`SELECT id FROM ai_outbox WHERE job_id=?`).get(created.job.id) as any
    return { replayed: true, result, job: created.job, outbox: outbox ? store.getOutbox(outbox.id) : null }
  }

  const claimed = store.claimJob({ jobId: created.job.id, workerId, leaseMs: LEASE_MS, controls })
  const started = store.checkpoint({
    jobId: claimed.id,
    workerId,
    attempt: claimed.attempt,
    expectedStateVersion: claimed.stateVersion,
    value: { kind: 'standard_change_tracer_started_v1', inputSnapshotId: snapshotId },
    leaseMs: LEASE_MS,
    controls,
  })
  let result
  try {
    result = createOfflineStandardChangeTracer().run(input)
  } catch (error: any) {
    const errorCode = typeof error?.code === 'string' && error.code ? error.code : 'AI_JOB_STALE'
    store.finishJobWithoutOutbox({
      jobId: started.id, workerId, attempt: started.attempt, expectedStateVersion: started.stateVersion,
      checkpoint: { kind: 'standard_change_tracer_error_v1', errorCode }, runState: 'failed', errorCode, controls,
    })
    throw error
  }
  if (result.state !== 'completed') {
    if (!noOutboxRunState(result.state)) throw new AiDurableError('AI_JOB_STALE')
    const job = store.finishJobWithoutOutbox({
      jobId: started.id, workerId, attempt: started.attempt, expectedStateVersion: started.stateVersion,
      checkpoint: { kind: 'standard_change_tracer_result_v1', result }, runState: result.state,
      errorCode: result.errorCode ?? null, controls,
    })
    return { replayed: false, result, job, outbox: null }
  }
  if (!result.proposal || !result.decision || !result.fakeApplyResult) {
    throw new AiDurableError('AI_STORAGE_CORRUPT')
  }

  const approvalSetHash = hashCanonical(result.decision)
  const outboxKey = `fake-apply:${result.proposal.revisionId}`
  const completed = store.completeJobWithOutbox({
    jobId: started.id,
    workerId,
    attempt: started.attempt,
    expectedStateVersion: started.stateVersion,
    checkpoint: { kind: 'standard_change_tracer_result_v1', result },
    controls,
    proposal: {
      id: result.proposal.id,
      revisionId: result.proposal.revisionId,
      type: 'repository_patch_artifact',
      state: 'approved',
      contentHash: result.proposal.contentHash,
      targetVersion: input.envelope.targetVersion,
      approvalSetHash,
    },
    outbox: {
      id: stableId('out', hashCanonical({ jobId: started.id, proposalRevisionId: result.proposal.revisionId })),
      deduplicationKey: outboxKey,
      downstreamKey: outboxKey,
      request: { fakeApplyResult: result.fakeApplyResult },
      maxAttempts: 3,
    },
  })
  return { replayed: false, result, ...completed }
}
