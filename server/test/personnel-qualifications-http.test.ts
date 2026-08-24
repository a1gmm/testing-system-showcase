import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { createUser } from '../src/handlers.ts'

test('人员专业资格 HTTP 接口仅管理员可用并复用日期、代码校验', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'personnel-qualifications-http-'))
  const dbPath = join(dir, 'test.db')
  const db = openDb(dbPath)
  createUser(db, { username: 'admin-http', name: '管理员', roles: ['admin'], password: 'secret1' })
  createUser(db, { username: 'planner-http', name: '计划员', roles: ['planner'], password: 'secret1' })
  createUser(db, { username: 'worker-http', name: '多岗人员', roles: ['sampler', 'analyst'], password: 'secret1' })
  db.prepare(`UPDATE users SET must_change_pw=0`).run()
  db.close()

  const port = 24_000 + Math.floor(Math.random() * 10_000)
  const base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['src/server.ts'], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath },
    stdio: 'ignore',
  })

  async function login(username: string) {
    let response: Response | undefined
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        response = await fetch(base + '/api/login', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username, password: 'secret1' }),
        })
        if (response.ok) break
      } catch { /* server is still starting */ }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(response?.status, 200)
    return String((await response!.json() as any).token)
  }
  const request = (token: string, method: 'GET' | 'POST', body?: unknown) => fetch(
    base + '/api/users/worker-http/qualifications',
    {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  )
  const personnelRequest = (token: string, body: unknown) => fetch(
    base + '/api/users/worker-http/personnel',
    {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  const getWorker = async (token: string) => {
    const response = await fetch(base + '/api/users', { headers: { authorization: `Bearer ${token}` } })
    assert.equal(response.status, 200)
    return (await response.json() as any[]).find(user => user.username === 'worker-http')
  }
  const getAudit = async (token: string) => {
    const response = await fetch(base + '/api/audit/worker-http', { headers: { authorization: `Bearer ${token}` } })
    assert.equal(response.status, 200)
    return await response.json() as any[]
  }

  try {
    const adminToken = await login('admin-http')
    const plannerToken = await login('planner-http')

    assert.equal((await fetch(base + '/api/users/worker-http/qualifications')).status, 401)
    assert.equal((await request(plannerToken, 'GET')).status, 403)
    assert.equal((await request(plannerToken, 'POST', { qualifications: ['sampling_review'] })).status, 403)
    assert.equal((await fetch(base + '/api/users/worker-http/personnel', { method: 'POST' })).status, 401)
    assert.equal((await personnelRequest(plannerToken, {
      name: '越权修改', roles: ['planner'], qualifications: [],
    })).status, 403)

    const invalidCode = await request(adminToken, 'POST', { qualifications: ['sampling_sign'] })
    assert.equal(invalidCode.status, 400)
    assert.deepEqual(await invalidCode.json(), {
      error: '不支持的专业审核资格', error_code: 'QUALIFICATION_CODE_INVALID',
    })

    const invalidDate = await request(adminToken, 'POST', {
      qualifications: [{ code: 'sampling_review', validFrom: '2026-12-31', validUntil: '2026-01-01' }],
    })
    assert.equal(invalidDate.status, 400)
    assert.deepEqual(await invalidDate.json(), {
      error: '资格失效日期不能早于生效日期', error_code: 'QUALIFICATION_DATE_INVALID',
    })

    const invalidPayloads: [unknown, string][] = [
      [{ qualifications: [null] }, 'QUALIFICATION_ITEM_INVALID'],
      [{ qualifications: [{ code: 7 }] }, 'QUALIFICATION_CODE_INVALID'],
      [{ qualifications: [{ code: 'sampling_review', status: 3 }] }, 'QUALIFICATION_STATUS_INVALID'],
      [{ qualifications: [{ code: 'sampling_review', validFrom: 20260101 }] }, 'QUALIFICATION_DATE_INVALID'],
      [{ qualifications: [{ code: 'sampling_review', validFrom: '2026-02-31' }] }, 'QUALIFICATION_DATE_INVALID'],
      [{ qualifications: [{ code: 'sampling_review' }, { code: 'sampling_review' }] }, 'QUALIFICATION_DUPLICATE'],
      [{ qualifications: [{ code: 'sampling_review', unexpected: true }] }, 'QUALIFICATION_ITEM_INVALID'],
    ]
    for (const [payload, errorCode] of invalidPayloads) {
      const response = await request(adminToken, 'POST', payload)
      assert.equal(response.status, 400, `${errorCode} must be a client error`)
      assert.equal((await response.json() as any).error_code, errorCode)
    }

    const saved = await request(adminToken, 'POST', {
      qualifications: [
        { code: 'sampling_review', validFrom: '2026-01-01', validUntil: '2026-12-31', status: 'active' },
        { code: 'report_approve', validFrom: null, validUntil: null, status: 'active' },
      ],
    })
    assert.equal(saved.status, 200)
    assert.deepEqual((await saved.json() as any[]).map(item => item.code), ['report_approve', 'sampling_review'])

    const listed = await request(adminToken, 'GET')
    assert.equal(listed.status, 200)
    const rows = await listed.json() as any[]
    assert.equal(rows[1].valid_from, '2026-01-01')
    assert.equal(rows[1].valid_until, '2026-12-31')

    const worker = await getWorker(adminToken)
    assert.deepEqual(worker.roles, ['sampler', 'analyst'])
    assert.equal('qualifications' in worker, false)

    const combined = await personnelRequest(adminToken, {
      name: '多岗人员', roles: ['sampler', 'analyst'], qualifications: [
        { code: 'sampling_review', validFrom: '2026-01-01', validUntil: '2026-12-31', status: 'active' },
        { code: 'report_approve', validFrom: null, validUntil: null, status: 'active' },
      ],
    })
    assert.equal(combined.status, 200)

    const beforeInvalidAudit = await getAudit(adminToken)
    const invalidCombined = await personnelRequest(adminToken, {
      name: '不应保存', roles: ['report_editor'],
      qualifications: [{ code: 'sampling_review', validFrom: '2026-02-31', status: 'active' }],
    })
    assert.equal(invalidCombined.status, 400)
    assert.equal((await invalidCombined.json() as any).error_code, 'QUALIFICATION_DATE_INVALID')
    assert.equal((await getWorker(adminToken)).name, '多岗人员')
    assert.deepEqual((await getWorker(adminToken)).roles, ['sampler', 'analyst'])
    assert.equal((await getAudit(adminToken)).length, beforeInvalidAudit.length)

    const triggerDb = openDb(dbPath)
    triggerDb.exec(`CREATE TRIGGER fail_atomic_qualification BEFORE INSERT ON user_qualifications
      WHEN NEW.code='quality_review' BEGIN SELECT RAISE(ABORT,'forced qualification failure'); END`)
    triggerDb.close()
    const beforeFailureAudit = await getAudit(adminToken)
    const failedAtomic = await personnelRequest(adminToken, {
      name: '也不应保存', roles: ['report_editor'], qualifications: [
        { code: 'sampling_review', validFrom: '2026-01-01', validUntil: '2026-12-31', status: 'active' },
        { code: 'quality_review', validFrom: null, validUntil: null, status: 'active' },
      ],
    })
    assert.equal(failedAtomic.status, 400)
    assert.equal((await getWorker(adminToken)).name, '多岗人员')
    assert.deepEqual((await getWorker(adminToken)).roles, ['sampler', 'analyst'])
    assert.deepEqual((await request(adminToken, 'GET').then(response => response.json()) as any[]).map(item => item.code), [
      'report_approve', 'sampling_review',
    ])
    assert.equal((await getAudit(adminToken)).length, beforeFailureAudit.length)
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('exit', resolve))
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
