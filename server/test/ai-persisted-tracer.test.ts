import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../src/db.ts'
import { hashText } from '../src/ai/phase0/index.ts'

function tracerInput() {
  const sourceContent = 'fixture basis locator: HJ 000-2026 replaces HJ 000-2020'
  const excerpt = 'HJ 000-2026 replaces HJ 000-2020'
  const contentSha256 = hashText(sourceContent)
  const excerptSha256 = hashText(excerpt)
  return {
    envelope: {
      schemaVersion: 1,
      tenantId: 'tenant-synthetic-01',
      actor: { kind: 'service_principal', principalId: 'standards-fixture-runner', registrationVersion: 'registration-fixture-v1' },
      scope: {
        kind: 'standard_library', tenantId: 'tenant-synthetic-01', scopeId: 'standards-fixture-v1',
        repositoryId: 'repository-synthetic-01', sourceIds: ['mee-example'], targetTemplateIds: ['template-synthetic-01'],
      },
      purpose: 'offline_contract_test', dataClassification: 'S1', policyVersion: 'policy-offline-v1',
      workflowVersion: 'standard-change-tracer-v1',
      capabilityPackVersions: ['standards.evidence.v1', 'standards.independent-review.v1', 'standards.template-impact.v1'],
      promptVersion: 'prompt-fixture-v1', modelVersion: 'fake-provider-v1',
      toolVersions: ['advisory.check.v1', 'evidence.fixture.read.v1', 'fake.apply.v1', 'proposal.create.v1', 'proposal.machine_verify.v1', 'target.fixture.read.v1'],
      budget: { maxSteps: 8, maxToolCalls: 6, maxEvidenceItems: 20, maxInputBytes: 65536 },
      idempotencyKey: 'fixture-persisted-v1', targetVersion: 'templates-fixture-v1', killSwitchEpoch: 1, capabilityPolicyEpoch: 1,
    },
    event: {
      schemaVersion: 1, tenantId: 'tenant-synthetic-01', scopeId: 'standards-fixture-v1', eventKind: 'replacement',
      standardCode: 'HJ 000-2026', oldVersion: 'HJ 000-2020', newVersion: 'HJ 000-2026',
      detectedBy: 'deterministic-standard-diff-v1', detectedAt: '2026-08-30T00:00:00Z', sourceSnapshotIds: ['source-snapshot-001'],
      sourceRefs: [{ sourceId: 'mee-example', sourceUrl: 'https://www.mee.gov.cn/ywgz/fgbz/bz/', fetchedAt: '2026-08-30T00:00:00Z', contentSha256, status: 'current_fixture' }],
      changeHints: ['replacement'], targetSnapshotVersion: 'templates-fixture-v1',
    },
    sources: [{
      sourceId: 'mee-example', sourceUrl: 'https://www.mee.gov.cn/ywgz/fgbz/bz/', sourceTitle: 'MEE synthetic standards fixture',
      authorityKind: 'official_public_fixture', retrievedAt: '2026-08-30T00:00:00Z', content: sourceContent, contentSha256,
      locator: 'fixture basis locator', excerpt, excerptSha256, parserVersion: 'parser-fixture-v1', verificationState: 'fixture_pinned', status: 'current_fixture',
    }],
    targetSnapshot: {
      schemaVersion: 1, tenantId: 'tenant-synthetic-01', scopeId: 'standards-fixture-v1', repositoryId: 'repository-synthetic-01',
      snapshotVersion: 'templates-fixture-v1', templateIds: ['template-synthetic-01'],
      fields: [{ templateId: 'template-synthetic-01', fieldId: 'basis', value: 'HJ 000-2020' }],
    },
    proposedChanges: [{
      changeId: 'change-001', templateId: 'template-synthetic-01', fieldId: 'basis', before: 'HJ 000-2020',
      after: 'HJ 000-2026', reason: 'synthetic replacement fixture', riskClass: 'critical_basis',
    }],
    approval: {
      actor: { kind: 'human', userId: 'technical-owner-synthetic', roles: ['technical_owner'], qualificationSnapshotId: 'qualification-synthetic-01' },
      decision: 'approve', reason: 'synthetic approval fixture', decidedAt: '2026-08-30T00:10:00Z', expiresAt: '2026-08-30T01:10:00Z',
      qualificationSnapshot: {
        snapshotId: 'qualification-synthetic-01', userId: 'technical-owner-synthetic', role: 'technical_owner', scopeId: 'standards-fixture-v1',
        validFrom: '2026-08-29T00:00:00Z', validUntil: '2026-08-31T00:00:00Z', revokedAt: null,
      },
    },
    advisoryMode: 'advisory_clear', currentKillSwitchEpoch: 1, currentCapabilityPolicyEpoch: 1,
    capabilityEnabled: true, killSwitchActive: false, evalCaseId: 'T01',
  }
}

function noChangeTracerInput() {
  const input = tracerInput()
  input.envelope.idempotencyKey = 'fixture-persisted-no-change-v1'
  input.event.eventKind = 'no_material_change'
  input.event.oldVersion = null as any
  input.event.newVersion = null as any
  input.event.changeHints = []
  input.proposedChanges = []
  input.approval = null as any
  input.evalCaseId = 'T02'
  return input
}

test('the offline standard tracer persists one job, checkpoint, proposal, and outbox and replays after process restart', async () => {
  const module = await import('../src/ai/persisted-tracer.ts').catch(() => ({} as any)) as any
  const root = mkdtempSync(join(tmpdir(), 'ai-persisted-tracer-'))
  const dbPath = join(root, 'data.db')
  try {
    const firstDb = openDb(dbPath)
    const first = module.runPersistedStandardChangeTracer?.({
      db: firstDb, input: tracerInput(), workerId: 'offline-worker-1', now: () => '2026-09-01T08:30:00.000Z',
    })
    assert.equal(first?.replayed, false)
    assert.equal(first?.result.state, 'completed')
    assert.equal(first?.result.metrics.networkCalls, 0)
    assert.equal(first?.result.metrics.modelCalls, 0)
    assert.equal(first?.job.state, 'completed')
    assert.equal(first?.outbox.state, 'pending')
    assert.equal((firstDb.prepare(`SELECT COUNT(*) AS n FROM ai_jobs`).get() as any).n, 1)
    assert.equal((firstDb.prepare(`SELECT COUNT(*) AS n FROM ai_outbox`).get() as any).n, 1)
    const persistedRun = firstDb.prepare(`SELECT request_hash,state,completed_at FROM ai_runs`).get() as any
    assert.equal(persistedRun.request_hash, first.result.run.requestHash)
    assert.equal(persistedRun.state, 'completed')
    assert.equal(persistedRun.completed_at, '2026-09-01T08:30:00.000Z')
    firstDb.close()

    const restartedDb = openDb(dbPath)
    const replay = module.runPersistedStandardChangeTracer({
      db: restartedDb, input: tracerInput(), workerId: 'offline-worker-after-restart', now: () => '2026-09-01T08:31:00.000Z',
    })
    assert.equal(replay.replayed, true)
    assert.deepEqual(replay.result, first.result)
    assert.equal((restartedDb.prepare(`SELECT COUNT(*) AS n FROM ai_job_attempts`).get() as any).n, 1)
    assert.equal((restartedDb.prepare(`SELECT COUNT(*) AS n FROM ai_outbox`).get() as any).n, 1)
    restartedDb.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a no-change terminal tracer result is durable and replays without creating a proposal or outbox', async () => {
  const { runPersistedStandardChangeTracer } = await import('../src/ai/persisted-tracer.ts')
  const root = mkdtempSync(join(tmpdir(), 'ai-persisted-no-change-'))
  const dbPath = join(root, 'data.db')
  try {
    const firstDb = openDb(dbPath)
    const first = runPersistedStandardChangeTracer({
      db: firstDb, input: noChangeTracerInput(), workerId: 'offline-worker-no-change', now: () => '2026-09-01T08:35:00.000Z',
    })
    assert.equal(first.result.state, 'no_change')
    assert.equal(first.job.state, 'completed')
    assert.equal(first.outbox, null)
    assert.equal((firstDb.prepare(`SELECT state FROM ai_runs`).get() as any).state, 'no_change')
    assert.equal((firstDb.prepare(`SELECT COUNT(*) AS n FROM ai_proposals`).get() as any).n, 0)
    assert.equal((firstDb.prepare(`SELECT COUNT(*) AS n FROM ai_outbox`).get() as any).n, 0)
    firstDb.close()

    const restartedDb = openDb(dbPath)
    const replay = runPersistedStandardChangeTracer({
      db: restartedDb, input: noChangeTracerInput(), workerId: 'offline-worker-no-change-restart', now: () => '2026-09-01T08:36:00.000Z',
    })
    assert.equal(replay.replayed, true)
    assert.deepEqual(replay.result, first.result)
    assert.equal(replay.outbox, null)
    assert.equal((restartedDb.prepare(`SELECT COUNT(*) AS n FROM ai_job_attempts`).get() as any).n, 1)
    restartedDb.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a deterministic tracer validation failure is persisted and replayed with the same stable error', async () => {
  const { runPersistedStandardChangeTracer } = await import('../src/ai/persisted-tracer.ts')
  const db = openDb(':memory:')
  const invalid = { ...tracerInput(), unexpectedField: true }
  try {
    assert.throws(
      () => runPersistedStandardChangeTracer({
        db, input: invalid, workerId: 'offline-worker-invalid', now: () => '2026-09-01T08:40:00.000Z',
      }),
      (error: any) => error?.code === 'AI_INPUT_INVALID',
    )
    assert.equal((db.prepare(`SELECT state FROM ai_jobs`).get() as any).state, 'failed')
    assert.throws(
      () => runPersistedStandardChangeTracer({
        db, input: invalid, workerId: 'offline-worker-invalid-replay', now: () => '2026-09-01T08:41:00.000Z',
      }),
      (error: any) => error?.code === 'AI_INPUT_INVALID',
    )
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ai_job_attempts`).get() as any).n, 1)
  } finally {
    db.close()
  }
})
