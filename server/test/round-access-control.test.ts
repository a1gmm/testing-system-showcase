import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { openDb } from '../src/db.ts'
import {
  addAttachment, assignRound, cancelRound, confirmRoundField, createContract, createUser, getAttachment, getRound,
  getRoundDetail, getRoundSheet, listAllRounds, listAttachments, listRoundSheets, sampleRound, saveRoundField,
  saveRoundSheet, terminateContract, updateUser,
} from '../src/handlers.ts'

function freshDb() { return openDb(':memory:') }

function makeRound(db: any, id = 'ROUND-ACL-1') {
  const contract = createContract(db, {
    client: '对象级授权客户',
    project: '移动采样',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-01',
    plan: [{ matrix: '废水', items: ['COD'], qty: 1, cycleMonths: 0 }],
  }, 2026)
  db.prepare(`INSERT INTO rounds (id, contract_id, round_no, due_date, items, status, created_at)
    VALUES (?, ?, 1, '2026-08-01', '[]', 'pending', '2026-08-01T00:00:00.000Z')`).run(id, contract.id)
  return id
}

function user(username: string, name: string, roles: string[]) {
  return { username, name, roles, status: 'active', created_at: '2026-08-01T00:00:00.000Z', must_change_pw: false }
}

test('派工持久化不可变用户 ID；同名与改名都不改变归属', () => {
  const db = freshDb()
  const roundId = makeRound(db)
  createUser(db, { username: 'sampler-a', name: '同名采样员', roles: ['sampler'], password: 'secret1' })
  createUser(db, { username: 'sampler-b', name: '同名采样员', roles: ['sampler'], password: 'secret2' })

  const assigned = assignRound(db, roundId, ['sampler-a']) as any
  assert.deepEqual(assigned.sampler_ids, ['sampler-a'])
  assert.equal(assigned.sampler, '同名采样员')

  updateUser(db, 'sampler-a', { name: '改名后的采样员' })
  const renamed = getRound(db, roundId) as any
  assert.deepEqual(renamed.sampler_ids, ['sampler-a'])
  assert.equal(renamed.sampler, '改名后的采样员')
})

test('期次任务列表和详情按角色、对象存在及当前 ID 派工过滤，阻断同名 IDOR', () => {
  const db = freshDb()
  const roundA = makeRound(db, 'ROUND-ACL-A')
  const roundB = makeRound(db, 'ROUND-ACL-B')
  createUser(db, { username: 'sampler-a', name: '同名采样员', roles: ['sampler'], password: 'secret1' })
  createUser(db, { username: 'sampler-b', name: '同名采样员', roles: ['sampler'], password: 'secret2' })
  assignRound(db, roundA, ['sampler-a'])
  assignRound(db, roundB, ['sampler-b'])

  const samplerA = user('sampler-a', '同名采样员', ['sampler'])
  assert.deepEqual((listAllRounds(db, undefined, samplerA) as any[]).map(r => r.id), [roundA])
  assert.equal((getRoundDetail(db, roundA, samplerA) as any).round.id, roundA)
  assert.throws(
    () => getRoundDetail(db, roundB, samplerA),
    (e: any) => e.httpCode === 403 && e.errorCode === 'ROUND_FORBIDDEN',
  )
  assert.throws(
    () => getRoundDetail(db, 'ROUND-NOT-FOUND', samplerA),
    (e: any) => e.httpCode === 404 && e.errorCode === 'ROUND_NOT_FOUND',
  )

  const supervisor = user('qc-user', '质控', ['qc'])
  assert.deepEqual((listAllRounds(db, undefined, supervisor) as any[]).map(r => r.id), [roundA, roundB])
})

test('现场字段、表单、附件与确认都按当前派工 ID 做对象级读写授权', () => {
  const db = freshDb()
  const roundId = makeRound(db)
  createUser(db, { username: 'sampler-a', name: '同名采样员', roles: ['sampler'], password: 'secret1' })
  createUser(db, { username: 'sampler-b', name: '同名采样员', roles: ['sampler'], password: 'secret2' })
  assignRound(db, roundId, ['sampler-a'])
  const samplerA = user('sampler-a', '同名采样员', ['sampler'])
  const samplerB = user('sampler-b', '同名采样员', ['sampler'])

  assert.throws(
    () => saveRoundField(db, roundId, { weather: '伪造' }, samplerB, { supervisor: false }),
    (e: any) => e.httpCode === 403 && e.errorCode === 'ROUND_FORBIDDEN',
  )
  assert.throws(
    () => saveRoundSheet(db, roundId, 'HJ-TC-136', { rows: [{ value: '伪造' }] }, samplerB, undefined, { supervisor: false }),
    (e: any) => e.httpCode === 403 && e.errorCode === 'ROUND_FORBIDDEN',
  )

  saveRoundField(db, roundId, { weather: '晴', confirms: { 'sampler-b': 'fake' }, confirmations: { 'sampler-b': { at: 'fake' } } }, samplerA, { supervisor: false })
  saveRoundSheet(db, roundId, 'HJ-TC-136', { rows: [{ value: '真实' }] }, samplerA, undefined, { supervisor: false })
  assert.equal(listRoundSheets(db, roundId, samplerA).length, 1)
  assert.equal(getRoundSheet(db, roundId, 'HJ-TC-136', samplerA)!.data.rows[0].value, '真实')
  assert.throws(() => listRoundSheets(db, roundId, samplerB), (e: any) => e.errorCode === 'ROUND_FORBIDDEN')
  assert.throws(() => getRoundSheet(db, roundId, 'HJ-TC-136', samplerB), (e: any) => e.errorCode === 'ROUND_FORBIDDEN')

  assert.throws(() => confirmRoundField(db, roundId, samplerB), (e: any) => e.errorCode === 'ROUND_FORBIDDEN')
  const confirmed = confirmRoundField(db, roundId, samplerA) as any
  assert.deepEqual(Object.keys(confirmed.field_info.confirmations), ['sampler-a'])
  assert.equal(confirmed.field_info.confirms['同名采样员'], confirmed.field_info.confirmations['sampler-a'].at)

  assert.throws(
    () => addAttachment(db, { entityType: 'round', entityId: roundId, origName: '伪造.jpg', storedName: 'fake.jpg' }, samplerB),
    (e: any) => e.errorCode === 'ROUND_FORBIDDEN',
  )
  const attachment = addAttachment(db, { entityType: 'round', entityId: roundId, origName: '现场.jpg', storedName: 'real.jpg' }, samplerA)
  assert.equal(listAttachments(db, 'round', roundId, samplerA).length, 1)
  assert.equal(getAttachment(db, attachment.id, samplerA)!.id, attachment.id)
  assert.throws(() => listAttachments(db, 'round', roundId, samplerB), (e: any) => e.errorCode === 'ROUND_FORBIDDEN')
  assert.throws(() => getAttachment(db, attachment.id, samplerB), (e: any) => e.errorCode === 'ROUND_FORBIDDEN')
})

test('同名采样员确认投影不折叠，并且必须逐个 ID 确认后才能收样入库', () => {
  const db = freshDb()
  const roundId = makeRound(db, 'ROUND-SAME-NAME-CONFIRM')
  createUser(db, { username: 'same-a', name: '同名采样员', roles: ['sampler'], password: 'secret1' })
  createUser(db, { username: 'same-b', name: '同名采样员', roles: ['sampler'], password: 'secret2' })
  assignRound(db, roundId, ['same-a', 'same-b'])

  assert.deepEqual((getRound(db, roundId) as any).field_info.confirmation_users, [
    { user_id: 'same-a', name: '同名采样员', confirmed_at: null },
    { user_id: 'same-b', name: '同名采样员', confirmed_at: null },
  ])

  confirmRoundField(db, roundId, user('same-a', '同名采样员', ['sampler']))
  const storedAfterFirst = JSON.parse((db.prepare(`SELECT field_info FROM rounds WHERE id=?`).get(roundId) as any).field_info)
  assert.equal(storedAfterFirst.confirmation_users, undefined, '读取投影不得持久化进 field_info')
  const afterFirst = getRound(db, roundId) as any
  assert.deepEqual(afterFirst.field_info.confirmation_users, [
    { user_id: 'same-a', name: '同名采样员', confirmed_at: afterFirst.field_info.confirmations['same-a'].at },
    { user_id: 'same-b', name: '同名采样员', confirmed_at: null },
  ])
  assert.throws(
    () => sampleRound(db, roundId, user('same-a', '同名采样员', ['sampler'])),
    /同名采样员（same-b）/,
  )

  confirmRoundField(db, roundId, user('same-b', '同名采样员', ['sampler']))
  const afterSecond = getRound(db, roundId) as any
  assert.equal(afterSecond.field_info.confirmation_users.length, 2)
  assert.ok(afterSecond.field_info.confirmation_users.every((x: any) => x.confirmed_at))
  assert.doesNotThrow(() => sampleRound(db, roundId, user('same-b', '同名采样员', ['sampler'])))
})

test('改派和撤销立即收回旧采样员访问，并使旧确认失效', () => {
  const db = freshDb()
  const roundId = makeRound(db)
  createUser(db, { username: 'sampler-a', name: '甲采样', roles: ['sampler'], password: 'secret1' })
  createUser(db, { username: 'sampler-b', name: '乙采样', roles: ['sampler'], password: 'secret2' })
  const samplerA = user('sampler-a', '甲采样', ['sampler'])
  const samplerB = user('sampler-b', '乙采样', ['sampler'])
  assignRound(db, roundId, ['sampler-a'])
  confirmRoundField(db, roundId, samplerA)

  const reassigned = assignRound(db, roundId, ['sampler-b']) as any
  assert.deepEqual(reassigned.sampler_ids, ['sampler-b'])
  assert.deepEqual(reassigned.field_info?.confirmations ?? {}, {}, '改派后旧人员确认不能继续满足新派工')
  assert.throws(() => getRoundDetail(db, roundId, samplerA), (e: any) => e.errorCode === 'ROUND_FORBIDDEN')
  assert.equal((getRoundDetail(db, roundId, samplerB) as any).round.id, roundId)

  cancelRound(db, roundId, '客户撤销采样', user('qc-user', '质控', ['qc']))
  assert.equal((getRound(db, roundId) as any).assignment_status, 'revoked')
  assert.throws(() => getRoundDetail(db, roundId, samplerB), (e: any) => e.errorCode === 'ROUND_FORBIDDEN')
  assert.equal((getRoundDetail(db, roundId, user('qc-user', '质控', ['qc'])) as any).round.id, roundId)
})

test('合同终止批量取消期次时同步撤销派工访问', () => {
  const db = freshDb()
  const roundId = makeRound(db)
  createUser(db, { username: 'sampler-a', name: '甲采样', roles: ['sampler'], password: 'secret1' })
  const samplerA = user('sampler-a', '甲采样', ['sampler'])
  assignRound(db, roundId, ['sampler-a'])
  const contractId = (getRound(db, roundId) as any).contract_id

  terminateContract(db, contractId, '客户终止合同', user('registrar-user', '登记', ['registrar']))

  assert.equal((getRound(db, roundId) as any).assignment_status, 'revoked')
  assert.throws(() => getRoundDetail(db, roundId, samplerA), (e: any) => e.errorCode === 'ROUND_FORBIDDEN')
})

test('历史姓名派工迁移唯一命中并留审计，重名行隔离，重复启动保持幂等', () => {
  const dir = mkdtempSync(join(tmpdir(), 'round-assignment-migration-'))
  const path = join(dir, 'legacy.db')
  try {
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE users (
        username TEXT PRIMARY KEY, name TEXT NOT NULL, roles TEXT NOT NULL DEFAULT '[]',
        pass_salt TEXT NOT NULL, pass_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL
      );
      CREATE TABLE rounds (
        id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, round_no INTEGER NOT NULL, due_date TEXT NOT NULL,
        items TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, plan_id TEXT, sampler TEXT, plan_date TEXT,
        sampled_at TEXT, field_info TEXT, fail_reason TEXT, orig_due_date TEXT, created_at TEXT NOT NULL
      );
      INSERT INTO users VALUES
        ('legacy-one', '唯一姓名', '["sampler"]', 's', 'h', 'active', '2026-01-01'),
        ('duplicate-a', '重复姓名', '["sampler"]', 's', 'h', 'active', '2026-01-01'),
        ('duplicate-b', '重复姓名', '["sampler"]', 's', 'h', 'active', '2026-01-01');
      INSERT INTO rounds (id, contract_id, round_no, due_date, status, sampler, created_at) VALUES
        ('LEGACY-EMPTY', 'C1', 0, '2025-12-31', 'pending', NULL, '2026-01-01'),
        ('LEGACY-UNIQUE', 'C1', 1, '2026-01-01', 'pending', '唯一姓名', '2026-01-01'),
        ('LEGACY-DUPLICATE', 'C1', 2, '2026-01-02', 'pending', '重复姓名', '2026-01-01');
    `)
    legacy.close()

    let db = openDb(path)
    assert.deepEqual((getRound(db, 'LEGACY-UNIQUE') as any).sampler_ids, ['legacy-one'])
    assert.equal((getRound(db, 'LEGACY-UNIQUE') as any).assignment_status, 'active')
    assert.deepEqual((getRound(db, 'LEGACY-DUPLICATE') as any).sampler_ids, [])
    assert.equal((getRound(db, 'LEGACY-DUPLICATE') as any).assignment_status, 'quarantined')
    assert.deepEqual(
      (db.prepare(`SELECT round_id, status FROM round_assignment_migrations ORDER BY round_id`).all() as any[]).map(r => ({ ...r })),
      [
        { round_id: 'LEGACY-DUPLICATE', status: 'quarantined' },
        { round_id: 'LEGACY-EMPTY', status: 'unassigned' },
        { round_id: 'LEGACY-UNIQUE', status: 'migrated' },
      ],
    )
    db.close()

    db = openDb(path)
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM round_assignment_migrations`).get() as any).n, 3)
    assert.equal((getRound(db, 'LEGACY-DUPLICATE') as any).assignment_status, 'quarantined')
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('真实 HTTP API 对任务详情、表单、附件和确认执行同一对象授权并返回稳定错误码', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'round-access-http-'))
  const dbPath = join(dir, 'api.db')
  const uploadDir = join(dir, 'uploads')
  const port = 41000 + Math.floor(Math.random() * 1000)
  let child: ReturnType<typeof spawn> | undefined
  try {
    const db = openDb(dbPath)
    const roundA = makeRound(db, 'ROUND-HTTP-A')
    const roundB = makeRound(db, 'ROUND-HTTP-B')
    const roundC = makeRound(db, 'ROUND-HTTP-C')
    createUser(db, { username: 'http-a', name: 'HTTP同名', roles: ['sampler'], password: 'secret1' })
    createUser(db, { username: 'http-b', name: 'HTTP同名', roles: ['sampler'], password: 'secret2' })
    createUser(db, { username: 'http-qc', name: 'HTTP质控', roles: ['qc'], password: 'secret3' })
    createUser(db, { username: 'http-registrar', name: 'HTTP登记', roles: ['registrar'], password: 'secret4' })
    createUser(db, { username: 'http-reviewer', name: 'HTTP复核', roles: ['reviewer'], password: 'secret5' })
    createUser(db, { username: 'http-approver', name: 'HTTP审核', roles: ['approver'], password: 'secret6' })
    createUser(db, { username: 'http-signer', name: 'HTTP签发', roles: ['signer'], password: 'secret7' })
    createUser(db, { username: 'http-unrelated', name: 'HTTP无关', roles: ['tester'], password: 'secret8' })
    db.prepare(`UPDATE users SET must_change_pw=0 WHERE username LIKE 'http-%'`).run()
    assignRound(db, roundA, ['http-a'])
    assignRound(db, roundB, ['http-b'])
    assignRound(db, roundC, ['http-b'])
    const contractC = (getRound(db, roundC) as any).contract_id
    db.prepare(`INSERT INTO reports (id, round_id, contract_id, client, title, conclusion, data, status, created_at)
      VALUES ('REPORT-ROUND-A', ?, (SELECT contract_id FROM rounds WHERE id=?), '客户', '报告A', '', '[]', 'draft', '2026-08-01T00:00:00.000Z')`).run(roundA, roundA)
    db.close()

    child = spawn(process.execPath, ['src/server.ts'], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, PORT: String(port), DB_PATH: dbPath, UPLOAD_DIR: uploadDir },
      stdio: 'ignore',
    })
    const base = `http://127.0.0.1:${port}`
    let loginResponse: Response | undefined
    for (let i = 0; i < 30; i++) {
      try {
        loginResponse = await fetch(base + '/api/login', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'http-a', password: 'secret1' }),
        })
        if (loginResponse.ok) break
      } catch { /* server still starting */ }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.ok(loginResponse?.ok, '测试服务器应启动并允许登录')
    const tokenA = (await loginResponse!.json() as any).token
    const loginB = await fetch(base + '/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'http-b', password: 'secret2' }),
    })
    const tokenB = (await loginB.json() as any).token
    const loginQc = await fetch(base + '/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'http-qc', password: 'secret3' }),
    })
    const tokenQc = (await loginQc.json() as any).token
    const loginRegistrar = await fetch(base + '/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'http-registrar', password: 'secret4' }),
    })
    const tokenRegistrar = (await loginRegistrar.json() as any).token
    const reportRoleTokens = Object.fromEntries(await Promise.all([
      ['reviewer', 'http-reviewer', 'secret5'],
      ['approver', 'http-approver', 'secret6'],
      ['signer', 'http-signer', 'secret7'],
      ['unrelated', 'http-unrelated', 'secret8'],
    ].map(async ([key, username, password]) => {
      const response = await fetch(base + '/api/login', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
      })
      return [key, (await response.json() as any).token]
    }))) as Record<string, string>
    const auth = (token: string) => ({ authorization: `Bearer ${token}` })

    const rounds = await fetch(base + '/api/rounds', { headers: auth(tokenA) })
    assert.deepEqual((await rounds.json() as any[]).map(r => r.id), [roundA])

    const forbiddenDetail = await fetch(base + `/api/rounds/${roundB}/detail`, { headers: auth(tokenA) })
    assert.equal(forbiddenDetail.status, 403)
    assert.equal((await forbiddenDetail.json() as any).error_code, 'ROUND_FORBIDDEN')

    const forgedField = await fetch(base + `/api/rounds/${roundA}/field`, {
      method: 'POST', headers: { ...auth(tokenB), 'content-type': 'application/json' }, body: JSON.stringify({ weather: '伪造' }),
    })
    assert.equal(forgedField.status, 403)
    assert.equal((await forgedField.json() as any).error_code, 'ROUND_FORBIDDEN')

    const saveSheet = await fetch(base + `/api/rounds/${roundA}/sheets/HJ-TC-136`, {
      method: 'POST', headers: { ...auth(tokenA), 'content-type': 'application/json' }, body: JSON.stringify({ rows: [{ value: '真实' }] }),
    })
    assert.equal(saveSheet.status, 200)
    const forgedSheetRead = await fetch(base + `/api/rounds/${roundA}/sheets/HJ-TC-136`, { headers: auth(tokenB) })
    assert.equal(forgedSheetRead.status, 403)

    const confirm = await fetch(base + `/api/rounds/${roundA}/confirm-field`, { method: 'POST', headers: auth(tokenA) })
    assert.equal(confirm.status, 200)

    const upload = await fetch(base + `/api/attachments/round/${roundA}?name=site.jpg`, {
      method: 'POST', headers: auth(tokenA), body: Buffer.from('photo'),
    })
    assert.equal(upload.status, 200)
    const attachmentId = (await upload.json() as any).id
    const forgedAttachmentList = await fetch(base + `/api/attachments/round/${roundA}`, { headers: auth(tokenB) })
    assert.equal(forgedAttachmentList.status, 403)
    const forgedAttachmentFile = await fetch(base + `/api/attachments/file/${attachmentId}`, { headers: auth(tokenB) })
    assert.equal(forgedAttachmentFile.status, 403)

    const ownAttachmentFile = await fetch(base + `/api/attachments/file/${attachmentId}`, { headers: auth(tokenA) })
    assert.equal(ownAttachmentFile.status, 200)
    assert.equal(Buffer.from(await ownAttachmentFile.arrayBuffer()).toString(), 'photo')
    const forgedDelete = await fetch(base + `/api/attachments/${attachmentId}/delete`, { method: 'POST', headers: auth(tokenB) })
    assert.equal(forgedDelete.status, 403)

    const reportReadResponses = await Promise.all([
      fetch(base + '/api/reports/REPORT-ROUND-A', { headers: auth(reportRoleTokens.unrelated) }),
      fetch(base + '/api/reports/REPORT-NOT-FOUND', { headers: auth(reportRoleTokens.unrelated) }),
      fetch(base + '/api/reports/REPORT-ROUND-A/archive-index', { headers: auth(reportRoleTokens.unrelated) }),
      fetch(base + '/api/reports/REPORT-NOT-FOUND/archive-index', { headers: auth(reportRoleTokens.unrelated) }),
      fetch(base + '/api/reports/REPORT-ROUND-A', { headers: auth(reportRoleTokens.reviewer) }),
      fetch(base + '/api/reports/REPORT-NOT-FOUND', { headers: auth(reportRoleTokens.reviewer) }),
      fetch(base + '/api/reports/REPORT-ROUND-A/archive-index', { headers: auth(reportRoleTokens.reviewer) }),
      fetch(base + '/api/reports/REPORT-NOT-FOUND/archive-index', { headers: auth(reportRoleTokens.reviewer) }),
    ])
    assert.deepEqual(reportReadResponses.map(r => r.status), [403, 403, 403, 403, 200, 404, 200, 404],
      '无报告读取权时 detail/archive 不得泄露 ID 是否存在；合法角色才区分 200/404')
    const archiveRoleResponses = await Promise.all([
      fetch(base + '/api/reports/REPORT-ROUND-A/archive-index', { headers: auth(tokenA) }),
      fetch(base + '/api/reports/REPORT-ROUND-A/archive-index', { headers: auth(reportRoleTokens.approver) }),
      fetch(base + '/api/reports/REPORT-ROUND-A/archive-index', { headers: auth(reportRoleTokens.signer) }),
    ])
    assert.deepEqual(archiveRoleResponses.map(r => r.status), [403, 200, 200])

    const roleDeniedQc = await fetch(base + `/api/rounds/${roundA}/qc`, {
      method: 'POST', headers: { ...auth(tokenA), 'content-type': 'application/json' },
      body: JSON.stringify({ qcType: '平行样', v1: 1, v2: 1 }),
    })
    assert.equal(roleDeniedQc.status, 403)
    const orphanQc = await fetch(base + '/api/rounds/ROUND-NOT-FOUND/qc', {
      method: 'POST', headers: { ...auth(tokenQc), 'content-type': 'application/json' },
      body: JSON.stringify({ qcType: '平行样', v1: 1, v2: 1 }),
    })
    assert.equal(orphanQc.status, 404)
    assert.equal((await orphanQc.json() as any).error_code, 'ROUND_NOT_FOUND')
    const afterOrphan = openDb(dbPath)
    assert.equal((afterOrphan.prepare(`SELECT COUNT(*) AS n FROM qc_records WHERE round_id='ROUND-NOT-FOUND'`).get() as any).n, 0)
    afterOrphan.close()
    const validQc = await fetch(base + `/api/rounds/${roundA}/qc`, {
      method: 'POST', headers: { ...auth(tokenQc), 'content-type': 'application/json' },
      body: JSON.stringify({ qcType: '平行样', v1: 1, v2: 1 }),
    })
    assert.equal(validQc.status, 200)

    const reassign = await fetch(base + `/api/rounds/${roundA}/assign`, {
      method: 'POST', headers: { ...auth(tokenQc), 'content-type': 'application/json' },
      body: JSON.stringify({ samplerIds: ['http-b'] }),
    })
    assert.equal(reassign.status, 200)
    for (const [method, url, body] of [
      ['POST', `/api/attachments/round/${roundA}?name=late.jpg`, Buffer.from('late')],
      ['GET', `/api/attachments/round/${roundA}`, undefined],
      ['GET', `/api/attachments/file/${attachmentId}`, undefined],
      ['POST', `/api/attachments/${attachmentId}/delete`, undefined],
    ] as const) {
      const response = await fetch(base + url, { method, headers: auth(tokenA), body })
      assert.equal(response.status, 403, `改派后旧采样员 ${method} ${url} 应被拒绝`)
    }
    const newAssigneeDownload = await fetch(base + `/api/attachments/file/${attachmentId}`, { headers: auth(tokenB) })
    assert.equal(newAssigneeDownload.status, 200)
    assert.equal(Buffer.from(await newAssigneeDownload.arrayBuffer()).toString(), 'photo')
    const newAssigneeUpload = await fetch(base + `/api/attachments/round/${roundA}?name=new-owner.jpg`, {
      method: 'POST', headers: auth(tokenB), body: Buffer.from('new-owner'),
    })
    assert.equal(newAssigneeUpload.status, 200)
    const newAttachmentId = (await newAssigneeUpload.json() as any).id
    const newAssigneeList = await fetch(base + `/api/attachments/round/${roundA}`, { headers: auth(tokenB) })
    assert.equal((await newAssigneeList.json() as any[]).length, 2)
    const newAssigneeDelete = await fetch(base + `/api/attachments/${newAttachmentId}/delete`, { method: 'POST', headers: auth(tokenB) })
    assert.equal(newAssigneeDelete.status, 200)

    const cancel = await fetch(base + `/api/rounds/${roundA}/cancel`, {
      method: 'POST', headers: { ...auth(tokenQc), 'content-type': 'application/json' }, body: JSON.stringify({ reason: '撤销' }),
    })
    assert.equal(cancel.status, 200)
    for (const [method, url, body] of [
      ['POST', `/api/attachments/round/${roundA}?name=cancelled.jpg`, Buffer.from('late')],
      ['GET', `/api/attachments/round/${roundA}`, undefined],
      ['GET', `/api/attachments/file/${attachmentId}`, undefined],
      ['POST', `/api/attachments/${attachmentId}/delete`, undefined],
    ] as const) {
      const response = await fetch(base + url, { method, headers: auth(tokenB), body })
      assert.equal(response.status, 403, `撤销后采样员 ${method} ${url} 应被拒绝`)
    }

    const contractAttachment = await fetch(base + `/api/attachments/round/${roundC}?name=contract.jpg`, {
      method: 'POST', headers: auth(tokenB), body: Buffer.from('contract-photo'),
    })
    assert.equal(contractAttachment.status, 200)
    const contractAttachmentId = (await contractAttachment.json() as any).id
    const terminate = await fetch(base + `/api/contracts/${contractC}/terminate`, {
      method: 'POST', headers: { ...auth(tokenRegistrar), 'content-type': 'application/json' }, body: JSON.stringify({ reason: '合同终止' }),
    })
    assert.equal(terminate.status, 200)
    for (const [method, url, body] of [
      ['POST', `/api/attachments/round/${roundC}?name=terminated.jpg`, Buffer.from('late')],
      ['GET', `/api/attachments/round/${roundC}`, undefined],
      ['GET', `/api/attachments/file/${contractAttachmentId}`, undefined],
      ['POST', `/api/attachments/${contractAttachmentId}/delete`, undefined],
    ] as const) {
      const response = await fetch(base + url, { method, headers: auth(tokenB), body })
      assert.equal(response.status, 403, `合同终止后采样员 ${method} ${url} 应被拒绝`)
    }
  } finally {
    child?.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})
