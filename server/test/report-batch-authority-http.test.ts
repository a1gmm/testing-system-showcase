import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { createContract, createUser } from '../src/handlers.ts'
import { createReportBatch } from '../src/archivePackages.ts'
import { loginToTestServer } from './support/http-test-server.ts'

test('only a planner can create a report batch or choose its rounds through the service and HTTP API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'report-batch-authority-'))
  const dbPath = join(dir, 'test.db')
  const db = openDb(dbPath)
  const contract = createContract(db, { client: '批次权限客户' }, 2026)
  db.prepare(`INSERT INTO rounds(id,contract_id,round_no,due_date,status,items,sampler_ids,assignment_status,created_at)
    VALUES ('ROUND-BATCH-AUTH',?,1,'2026-08-22','pending','[]','[]','unassigned','2026-08-22T00:00:00.000Z')`).run(contract.id)
  const roles = ['planner', 'report_editor', 'archivist', 'tech', 'signer'] as const
  for (const role of roles) createUser(db, { username: `batch-${role}`, name: role, roles: [role], password: 'secret1' })
  assert.throws(() => createReportBatch(db, {
    contractId: contract.id, name: '越权批次', roundIds: ['ROUND-BATCH-AUTH'],
  }, { username: 'batch-report_editor', name: 'report_editor', roles: ['report_editor'] } as any), /计划员/)
  db.prepare(`UPDATE users SET must_change_pw=0`).run()
  db.close()

  const port = 24_000 + Math.floor(Math.random() * 10_000)
  const base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['src/server.ts'], {
    cwd: join(import.meta.dirname, '..'), env: { ...process.env, PORT: String(port), DB_PATH: dbPath }, stdio: 'ignore',
  })
  const login = (username: string) => loginToTestServer(base, username, 'secret1')
  const create = (token: string, name: string) => fetch(base + '/api/report-batches', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ contractId: contract.id, name, roundIds: ['ROUND-BATCH-AUTH'] }),
  })

  try {
    for (const role of ['report_editor', 'archivist', 'tech'] as const) {
      assert.equal((await create(await login(`batch-${role}`), `${role} 越权批次`)).status, 403, role)
    }
    const response = await create(await login('batch-planner'), '计划员预设批次')
    assert.equal(response.status, 200)
    const batch = await response.json() as any
    assert.equal(batch.created_by, 'batch-planner')
    assert.deepEqual(batch.round_ids, ['ROUND-BATCH-AUTH'])
    const signerToken = await login('batch-signer')
    assert.equal((await fetch(base + '/api/report-batches', { headers: { authorization: `Bearer ${signerToken}` } })).status, 200)
    assert.equal((await fetch(base + '/api/archive-packages', { headers: { authorization: `Bearer ${signerToken}` } })).status, 200)
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('exit', resolve))
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
