import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { createContract, createUser, type User } from '../src/handlers.ts'
import { setUserQualifications } from '../src/qualifications.ts'

test('项目审核候选接口按合同、专业、层级和日期过滤且只向计划员或管理员开放', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-candidates-http-'))
  const dbPath = join(dir, 'test.db')
  const db = openDb(dbPath)
  const admin: User = { username: 'admin-candidate', name: '管理员', roles: ['admin'], status: 'active', created_at: '', must_change_pw: false }
  createUser(db, { username: admin.username, name: admin.name, roles: admin.roles, password: 'secret1' })
  createUser(db, { username: 'planner-candidate', name: '计划员', roles: ['planner'], password: 'secret1' })
  createUser(db, { username: 'analyst-candidate', name: '分析员', roles: ['analyst'], password: 'secret1' })
  for (const [username, name] of [['review-ok', '有效复核人'], ['review-expired', '过期复核人'], ['approve-ok', '有效审核人']] as const) {
    createUser(db, { username, name, roles: ['analyst'], password: 'secret1' })
  }
  setUserQualifications(db, 'review-ok', [{ code: 'sampling_review', validFrom: '2026-01-01', validUntil: '2026-12-31' }], admin)
  setUserQualifications(db, 'review-expired', [{ code: 'sampling_review', validUntil: '2026-08-21' }], admin)
  setUserQualifications(db, 'approve-ok', [{ code: 'sampling_approve', validFrom: '2026-08-22' }], admin)
  const contract = createContract(db, { client: '甲厂' }, 2026)
  db.prepare(`UPDATE users SET must_change_pw=0`).run()
  db.close()

  const port = 24_000 + Math.floor(Math.random() * 10_000)
  const base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['src/server.ts'], {
    cwd: join(import.meta.dirname, '..'), env: { ...process.env, PORT: String(port), DB_PATH: dbPath }, stdio: 'ignore',
  })

  async function login(username: string) {
    let response: Response | undefined
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        response = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'secret1' }) })
        if (response.ok) break
      } catch { /* server is still starting */ }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(response?.status, 200)
    return String((await response!.json() as any).token)
  }
  const request = (token: string, suffix = `/${contract.id}/workflow-candidates?scope=sampling&level=review&at=2026-08-22`) => fetch(
    base + '/api/contracts' + suffix, { headers: { authorization: `Bearer ${token}` } },
  )

  try {
    const plannerToken = await login('planner-candidate')
    const analystToken = await login('analyst-candidate')
    const adminToken = await login('admin-candidate')

    assert.equal((await request(analystToken)).status, 403)
    const response = await request(plannerToken)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), [{ username: 'review-ok', name: '有效复核人' }])
    assert.deepEqual(await request(adminToken, `/${contract.id}/workflow-candidates?scope=sampling&level=approve&at=2026-08-22`).then(r => r.json()), [
      { username: 'approve-ok', name: '有效审核人' },
    ])
    assert.equal((await request(plannerToken, `/${contract.id}/workflow-candidates?scope=finance&level=review&at=2026-08-22`)).status, 400)
    assert.equal((await request(plannerToken, `/${contract.id}/workflow-candidates?scope=sampling&level=sign&at=2026-08-22`)).status, 400)
    assert.equal((await request(plannerToken, `/${contract.id}/workflow-candidates?scope=sampling&level=review&at=2026-02-31`)).status, 400)
    assert.equal((await request(plannerToken, `/missing/workflow-candidates?scope=sampling&level=review&at=2026-08-22`)).status, 404)
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('exit', resolve))
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
