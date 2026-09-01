import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { AiDurableError } from './durable-store.ts'
import { hashCanonical, stableId } from './phase0/index.ts'

function fail(code: string, message = code): never {
  throw new AiDurableError(code, message)
}

function assertId(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value !== value.normalize('NFC')) fail('AI_INPUT_INVALID')
}

function assertRegularDirectory(path: string) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('AI_STORAGE_CORRUPT')
}

function hashBytes(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}

function fsyncDirectory(path: string) {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function assertStoredBytes(path: string, expectedSize: number, expectedHash: string) {
  if (!existsSync(path)) fail('AI_STORAGE_CORRUPT')
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) fail('AI_STORAGE_CORRUPT')
  const actual = readFileSync(path)
  if (actual.length !== expectedSize || hashBytes(actual) !== expectedHash) fail('AI_STORAGE_CORRUPT')
}

function artifactView(row: any) {
  return {
    id: row.id,
    runId: row.run_id,
    jobId: row.job_id,
    kind: row.kind,
    relativePath: row.relative_path,
    contentHash: row.content_hash,
    size: Number(row.size),
    status: row.status,
    createdAt: row.created_at,
  }
}

export function storeAiArtifact(input: {
  db: DatabaseSync,
  uploadRoot: string,
  runId: string,
  jobId: string,
  kind: string,
  bytes: Buffer,
  now: string,
}) {
  assertId(input.runId)
  assertId(input.jobId)
  assertId(input.kind)
  if (!Buffer.isBuffer(input.bytes)) fail('AI_INPUT_INVALID')
  if (!Number.isFinite(Date.parse(input.now))) fail('AI_INPUT_INVALID')
  const parent = input.db.prepare(`SELECT j.run_id FROM ai_jobs j JOIN ai_runs r ON r.id=j.run_id WHERE j.id=? AND r.id=?`).get(
    input.jobId, input.runId,
  ) as any
  if (!parent) fail('AI_SCOPE_DENIED')

  const contentHash = hashBytes(input.bytes)
  const artifactId = stableId('art', hashCanonical({ runId: input.runId, jobId: input.jobId, kind: input.kind, contentHash }))
  const relativePath = `ai-artifacts/${input.runId}/${artifactId}.bin`
  const root = resolve(input.uploadRoot)
  assertRegularDirectory(root)
  const aiRoot = resolve(root, 'ai-artifacts')
  if (!aiRoot.startsWith(`${root}${sep}`)) fail('AI_STORAGE_CORRUPT')
  assertRegularDirectory(aiRoot)
  const directory = resolve(aiRoot, input.runId)
  if (!directory.startsWith(`${root}${sep}`)) fail('AI_STORAGE_CORRUPT')
  assertRegularDirectory(directory)
  const target = resolve(root, relativePath)
  if (!target.startsWith(`${directory}${sep}`)) fail('AI_STORAGE_CORRUPT')

  const existing = input.db.prepare(`SELECT * FROM ai_artifacts WHERE id=?`).get(artifactId) as any
  if (existing) {
    if (existing.run_id !== input.runId || existing.job_id !== input.jobId || existing.kind !== input.kind ||
      existing.relative_path !== relativePath || existing.content_hash !== contentHash || Number(existing.size) !== input.bytes.length ||
      existing.status !== 'active') fail('AI_STORAGE_CORRUPT')
    assertStoredBytes(target, input.bytes.length, contentHash)
    return { artifact: artifactView(existing), replayed: true }
  }

  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`
  let descriptor: number | null = null
  let installed = false
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, input.bytes)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    try {
      linkSync(temporary, target)
      installed = true
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
      assertStoredBytes(target, input.bytes.length, contentHash)
    }
    unlinkSync(temporary)
    fsyncDirectory(directory)

    input.db.exec('BEGIN IMMEDIATE')
    try {
      input.db.prepare(`INSERT INTO ai_artifacts
        (id,run_id,job_id,kind,relative_path,content_hash,size,status,created_at)
        VALUES(?,?,?,?,?,?,?,'active',?)`).run(
        artifactId, input.runId, input.jobId, input.kind, relativePath, contentHash, input.bytes.length, input.now,
      )
      input.db.exec('COMMIT')
    } catch (error) {
      try { input.db.exec('ROLLBACK') } catch {}
      const concurrent = input.db.prepare(`SELECT * FROM ai_artifacts WHERE id=?`).get(artifactId) as any
      if (/UNIQUE constraint/i.test(String((error as any)?.message || error)) && concurrent &&
        concurrent.run_id === input.runId && concurrent.job_id === input.jobId && concurrent.kind === input.kind &&
        concurrent.relative_path === relativePath && concurrent.content_hash === contentHash &&
        Number(concurrent.size) === input.bytes.length && concurrent.status === 'active') {
        assertStoredBytes(target, input.bytes.length, contentHash)
        return { artifact: artifactView(concurrent), replayed: true }
      }
      throw error
    }
    return {
      artifact: artifactView(input.db.prepare(`SELECT * FROM ai_artifacts WHERE id=?`).get(artifactId)),
      replayed: false,
    }
  } catch (error) {
    if (descriptor !== null) try { closeSync(descriptor) } catch {}
    try { if (existsSync(temporary)) unlinkSync(temporary) } catch {}
    try {
      if (installed && existsSync(target)) {
        unlinkSync(target)
        fsyncDirectory(directory)
      }
    } catch {}
    if (error instanceof AiDurableError) throw error
    throw new AiDurableError('AI_STORAGE_CORRUPT', 'AI artifact persistence failed', { cause: error })
  }
}
