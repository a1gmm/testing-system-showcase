import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { openDb } from '../src/db.ts'
import { createAiDurableStore } from '../src/ai/durable-store.ts'

test('AI artifacts use a server-chosen uploads path and bind bytes, size, and hash in SQLite', async () => {
  const module = await import('../src/ai/artifact-store.ts').catch(() => ({} as any)) as any
  const root = mkdtempSync(join(tmpdir(), 'ai-artifact-store-'))
  const uploads = join(root, 'uploads')
  const db = openDb(join(root, 'data.db'))
  const store = createAiDurableStore(db, { now: () => '2026-09-01T08:00:00.000Z' })
  const controls = { enabled: true, killSwitchActive: false, capabilityPolicyEpoch: 3, killSwitchEpoch: 7 }
  try {
    const job = store.createJob({
      runId: 'run_artifact_fixture', tenantId: 'tenant-fixture', scopeKind: 'standard_library', scopeId: 'standards-fixture',
      jobType: 'standards.evidence.v1', idempotencyKey: 'artifact-fixture', targetVersion: 'templates-v1',
      request: { eventId: 'artifact-event' }, inputSnapshotId: 'snapshot-artifact',
      capabilityPolicyEpoch: 3, killSwitchEpoch: 7, maxAttempts: 2, expiresAt: '2026-09-01T10:00:00.000Z', controls,
    }).job
    const bytes = Buffer.from('synthetic AI artifact bytes')
    const written = module.storeAiArtifact?.({
      db, uploadRoot: uploads, runId: job.runId, jobId: job.id, kind: 'evidence_packet', bytes,
      now: '2026-09-01T08:00:01.000Z',
    })
    assert.equal(written?.replayed, false)
    assert.match(written?.artifact.id, /^art_[0-9a-f]{24}$/)
    assert.match(written?.artifact.relativePath, /^ai-artifacts\/run_artifact_fixture\/art_[0-9a-f]{24}\.bin$/)
    const absolute = resolve(uploads, written.artifact.relativePath)
    assert.ok(absolute.startsWith(`${resolve(uploads)}/ai-artifacts/`))
    assert.deepEqual(readFileSync(absolute), bytes)
    const row = db.prepare(`SELECT relative_path,content_hash,size,status FROM ai_artifacts WHERE id=?`).get(written.artifact.id) as any
    assert.deepEqual({ ...row }, {
      relative_path: written.artifact.relativePath,
      content_hash: written.artifact.contentHash,
      size: bytes.length,
      status: 'active',
    })
    const replay = module.storeAiArtifact({
      db, uploadRoot: uploads, runId: job.runId, jobId: job.id, kind: 'evidence_packet', bytes,
      now: '2026-09-01T08:00:02.000Z',
    })
    assert.equal(replay.replayed, true)
    assert.equal(replay.artifact.id, written.artifact.id)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('AI artifact storage never overwrites a conflicting crash residue at the server-chosen target', async () => {
  const { storeAiArtifact } = await import('../src/ai/artifact-store.ts')
  const root = mkdtempSync(join(tmpdir(), 'ai-artifact-residue-'))
  const uploads = join(root, 'uploads')
  const db = openDb(join(root, 'data.db'))
  const controls = { enabled: true, killSwitchActive: false, capabilityPolicyEpoch: 3, killSwitchEpoch: 7 }
  try {
    const job = createAiDurableStore(db, { now: () => '2026-09-01T08:03:00.000Z' }).createJob({
      runId: 'run_artifact_residue', tenantId: 'tenant-fixture', scopeKind: 'standard_library', scopeId: 'standards-fixture',
      jobType: 'standards.evidence.v1', idempotencyKey: 'artifact-residue', targetVersion: 'templates-v1',
      request: { eventId: 'artifact-residue-event' }, inputSnapshotId: 'snapshot-artifact-residue',
      capabilityPolicyEpoch: 3, killSwitchEpoch: 7, maxAttempts: 2, expiresAt: '2026-09-01T10:03:00.000Z', controls,
    }).job
    const bytes = Buffer.from('expected immutable artifact bytes')
    const first = storeAiArtifact({
      db, uploadRoot: uploads, runId: job.runId, jobId: job.id, kind: 'evidence_packet', bytes,
      now: '2026-09-01T08:03:01.000Z',
    })
    const target = resolve(uploads, first.artifact.relativePath)
    db.prepare(`DELETE FROM ai_artifacts WHERE id=?`).run(first.artifact.id)
    const conflictingResidue = Buffer.from('conflicting bytes left by another process')
    writeFileSync(target, conflictingResidue)

    assert.throws(
      () => storeAiArtifact({
        db, uploadRoot: uploads, runId: job.runId, jobId: job.id, kind: 'evidence_packet', bytes,
        now: '2026-09-01T08:03:02.000Z',
      }),
      (error: any) => error?.code === 'AI_STORAGE_CORRUPT',
    )
    assert.deepEqual(readFileSync(target), conflictingResidue, 'a losing writer must not overwrite or delete the existing target')
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ai_artifacts WHERE id=?`).get(first.artifact.id) as any).n, 0)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('AI artifact storage rejects a symlink anywhere below the configured uploads root', async () => {
  const { storeAiArtifact } = await import('../src/ai/artifact-store.ts')
  const root = mkdtempSync(join(tmpdir(), 'ai-artifact-symlink-'))
  const uploads = join(root, 'uploads')
  const outside = join(root, 'outside')
  mkdirSync(uploads, { recursive: true })
  mkdirSync(outside, { recursive: true })
  symlinkSync(outside, join(uploads, 'ai-artifacts'))
  const db = openDb(join(root, 'data.db'))
  const controls = { enabled: true, killSwitchActive: false, capabilityPolicyEpoch: 3, killSwitchEpoch: 7 }
  try {
    const job = createAiDurableStore(db, { now: () => '2026-09-01T08:05:00.000Z' }).createJob({
      runId: 'run_artifact_symlink', tenantId: 'tenant-fixture', scopeKind: 'standard_library', scopeId: 'standards-fixture',
      jobType: 'standards.evidence.v1', idempotencyKey: 'artifact-symlink', targetVersion: 'templates-v1',
      request: { eventId: 'artifact-symlink-event' }, inputSnapshotId: 'snapshot-artifact-symlink',
      capabilityPolicyEpoch: 3, killSwitchEpoch: 7, maxAttempts: 2, expiresAt: '2026-09-01T10:05:00.000Z', controls,
    }).job
    assert.throws(
      () => storeAiArtifact({
        db, uploadRoot: uploads, runId: job.runId, jobId: job.id, kind: 'evidence_packet',
        bytes: Buffer.from('must stay inside uploads'), now: '2026-09-01T08:05:01.000Z',
      }),
      (error: any) => error?.code === 'AI_STORAGE_CORRUPT',
    )
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
