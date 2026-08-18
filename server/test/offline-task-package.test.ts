import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { openDb } from '../src/db.ts'
import { assignRound, cancelRound, createContract, createUser, deviceBindingFingerprint, issueOfflineTaskPackage } from '../src/handlers.ts'

function setup() {
  const db = openDb(':memory:')
  const contract = createContract(db, {
    client: '离线采样客户', project: '现场任务', periodStart: '2026-08-16', periodEnd: '2026-08-16',
    plan: [{ matrix: '废水', items: ['COD'], qty: 2, cycleMonths: 0 }],
  }, 2026)
  db.prepare(`INSERT INTO rounds (id, contract_id, round_no, due_date, items, status, created_at)
    VALUES ('ROUND-OFFLINE', ?, 1, '2026-08-16', ?, 'pending', '2026-08-16T00:00:00.000Z')`)
    .run(contract.id, JSON.stringify([{ matrix: '废水', items: ['COD'], qty: 2 }]))
  createUser(db, { username: 'same-a', name: '同名采样员', roles: ['sampler'], password: 'secret1' })
  createUser(db, { username: 'same-b', name: '同名采样员', roles: ['sampler'], password: 'secret2' })
  assignRound(db, 'ROUND-OFFLINE', ['same-a'])
  return db
}

const actor = (username: string) => ({ username, name: '同名采样员', roles: ['sampler'], status: 'active', created_at: '', must_change_pw: false })
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
const bindingFingerprint = createHash('sha256').update(createPublicKey(keys.publicKey).export({ type: 'spki', format: 'der' })).digest('hex')
const allowed = {
  offlineWriteEnabled: true,
  sensitiveOfflinePackageEnabled: true,
  verifyManagedDevice: () => ({ deviceId: 'mdm-1', trustedUntil: '2026-08-17T08:00:00.000Z', attestationId: 'att-1', bindingPublicKeySpki: keys.publicKey, bindingFingerprint }),
  signedFormRuleApproved: true,
  now: () => new Date('2026-08-16T08:00:00.000Z'),
  signingPrivateKeyPem: keys.privateKey,
}

test('任务包默认门槛与逐请求设备证明均 fail closed', () => {
  const db = setup()
  assert.throws(() => issueOfflineTaskPackage(db, 'ROUND-OFFLINE', actor('same-a'), {} as any), (e: any) => e.errorCode === 'OFFLINE_GATE_CLOSED')
  assert.throws(() => issueOfflineTaskPackage(db, 'ROUND-OFFLINE', actor('same-a'), { ...allowed, verifyManagedDevice: () => null }), (e: any) => e.errorCode === 'MANAGED_DEVICE_REQUIRED')
  assert.throws(() => issueOfflineTaskPackage(db, 'ROUND-OFFLINE', actor('same-a'), { ...allowed, signingPrivateKeyPem: '' }), (e: any) => e.errorCode === 'OFFLINE_SIGNING_UNAVAILABLE')
  assert.throws(() => issueOfflineTaskPackage(db, 'ROUND-OFFLINE', actor('same-a'), { ...allowed, signedFormRuleApproved: false }), (e: any) => e.errorCode === 'FORM_RULE_NOT_APPROVED')
})

test('签发复用不可变 ID 对象授权，阻断同名、改派和撤销访问', () => {
  const db = setup()
  assert.throws(() => issueOfflineTaskPackage(db, 'ROUND-OFFLINE', actor('same-b'), allowed), (e: any) => e.errorCode === 'OFFLINE_ASSIGNEE_REQUIRED')
  assert.equal(issueOfflineTaskPackage(db, 'ROUND-OFFLINE', actor('same-a'), allowed).signedPayload.assigneeId, 'same-a')
  assert.throws(() => issueOfflineTaskPackage(db, 'ROUND-OFFLINE', { ...actor('manager'), roles: ['qc'] }, allowed), (e: any) => e.errorCode === 'OFFLINE_ASSIGNEE_REQUIRED')
  assignRound(db, 'ROUND-OFFLINE', ['same-b'])
  assert.throws(() => issueOfflineTaskPackage(db, 'ROUND-OFFLINE', actor('same-a'), allowed), (e: any) => e.errorCode === 'OFFLINE_ASSIGNEE_REQUIRED')
  cancelRound(db, 'ROUND-OFFLINE', '撤销', { ...actor('qc'), name: '质控', roles: ['qc'] })
  assert.throws(() => issueOfflineTaskPackage(db, 'ROUND-OFFLINE', actor('same-b'), allowed), (e: any) => e.errorCode === 'OFFLINE_ASSIGNEE_REQUIRED')
})

test('首表快照带完整稳定版本、样品槽位与可验证可信时间授权', () => {
  const db = setup()
  const first = issueOfflineTaskPackage(db, 'ROUND-OFFLINE', actor('same-a'), allowed)
  const second = issueOfflineTaskPackage(db, 'ROUND-OFFLINE', actor('same-a'), allowed)
  assert.equal(first.signedPayload.formCode, 'HJ-TC-136')
  assert.equal(first.signedPayload.ruleVersion, 'HJ-TC-136@provisional-v1')
  assert.match(first.signedPayload.taskVersion, /^ROUND-OFFLINE@/)
  assert.equal(first.signedPayload.sampleSlots.length,2)
  assert.ok(first.signedPayload.sampleSlots.every(x=>/^[0-9a-f-]{36}$/.test(x.sampleSlotId)&&x.qrPayload===`TC1:${x.temporaryId}`))
  assert.deepEqual(second.signedPayload.sampleSlots, first.signedPayload.sampleSlots)
  assert.equal(first.signedPayload.deviceBindingPublicKeySpki, keys.publicKey)
  assert.equal(first.signedPayload.deviceBindingFingerprint, bindingFingerprint)
  assert.deepEqual(first.signedPayload.authorization, {
    scope: 'field-draft-write', deviceId: 'mdm-1', attestationId: 'att-1', nonce: first.signedPayload.authorization.nonce,
    issuedAt: '2026-08-16T08:00:00.000Z', serverTime: '2026-08-16T08:00:00.000Z', expiresAt: '2026-08-17T08:00:00.000Z',
  })
  assert.match(first.signature, /^[A-Za-z0-9_-]+$/)
  assert.equal(verify('sha256', Buffer.from(JSON.stringify(first.signedPayload)), { key: keys.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(first.signature, 'base64url')), true)
  assert.equal(first.signedPayload.schemaVersion, 1)
  assert.deepEqual(first.signedPayload.formSchema.rowFields, ['sampleSlotId', 'sampleNo', 'point', 'time', 'item', 'volume', 'preserve', 'waterColor', 'smell', 'oil', 'floating', 'anomaly', 'note'])
  assert.deepEqual(first.signedPayload.formSchema.globalFields, ['org', 'orgSign', 'samplingDate'])
  assert.equal('formalNumber' in first.signedPayload.sampleSlots[0], false)
})

test('设备指纹按 SPKI DER 计算且不受 PEM 换行影响', () => {
  assert.equal(deviceBindingFingerprint(keys.publicKey), bindingFingerprint)
  assert.equal(deviceBindingFingerprint(keys.publicKey.replace(/\n/g, '\r\n')), bindingFingerprint)
})

test('相同基质的多条任务计划也生成全局唯一且重签稳定的 sampleSlotId', () => {
  const db = setup()
  db.prepare(`UPDATE rounds SET items=? WHERE id='ROUND-OFFLINE'`).run(JSON.stringify([
    { matrix: '废水', items: ['COD'], qty: 1 }, { matrix: '废水', items: ['氨氮'], qty: 1 },
  ]))
  const first = issueOfflineTaskPackage(db, 'ROUND-OFFLINE', actor('same-a'), allowed)
  const second = issueOfflineTaskPackage(db, 'ROUND-OFFLINE', actor('same-a'), allowed)
  assert.equal(new Set(first.signedPayload.sampleSlots.map(x => x.sampleSlotId)).size, 2)
  assert.deepEqual(second.signedPayload.sampleSlots.map(x => x.sampleSlotId), first.signedPayload.sampleSlots.map(x => x.sampleSlotId))
})

test('任务内容更新会产生新的 taskVersion 供本机草稿转只读冲突', () => {
  const db = setup()
  const before = issueOfflineTaskPackage(db, 'ROUND-OFFLINE', actor('same-a'), allowed)
  db.prepare(`UPDATE rounds SET items=? WHERE id='ROUND-OFFLINE'`).run(JSON.stringify([{ matrix: '废水', items: ['COD', '氨氮'], qty: 2 }]))
  const after = issueOfflineTaskPackage(db, 'ROUND-OFFLINE', actor('same-a'), allowed)
  assert.notEqual(after.signedPayload.taskVersion, before.signedPayload.taskVersion)
  assert.equal(after.signedPayload.taskVersionOrdinal, before.signedPayload.taskVersionOrdinal + 1)
  assert.equal(issueOfflineTaskPackage(db, 'ROUND-OFFLINE', actor('same-a'), allowed).signedPayload.taskVersionOrdinal, after.signedPayload.taskVersionOrdinal)
})

test('canonical P-256 签名覆盖完整包，篡改任一业务字段都验签失败', () => {
  const pkg = issueOfflineTaskPackage(setup(), 'ROUND-OFFLINE', actor('same-a'), allowed)
  for (const mutate of [
    (x: any) => { x.assigneeId = 'same-b' },
    (x: any) => { x.deviceId = 'mdm-2' },
    (x: any) => { x.deviceBindingFingerprint = '0'.repeat(64) },
    (x: any) => { x.ruleVersion = 'evil' },
    (x: any) => { x.sampleSlots[0].items = ['伪造'] },
    (x: any) => { x.authorization.expiresAt = '2099-01-01T00:00:00.000Z' },
  ]) {
    const changed = structuredClone(pkg.signedPayload)
    mutate(changed)
    assert.equal(verify('sha256', Buffer.from(JSON.stringify(changed)), { key: keys.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(pkg.signature, 'base64url')), false)
  }
})

test('真实 HTTP 响应禁止缓存，且客户端请求不能开启未安装的 attestation/rule gate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-package-http-')); const path = join(dir, 'db.sqlite'); const port = 44000 + Math.floor(Math.random() * 500)
  let child: ReturnType<typeof spawn> | undefined
  try {
    const db = openDb(path); const contract = createContract(db, { client: 'HTTP', project: '离线', periodStart: '2026-08-16', periodEnd: '2026-08-16', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] }, 2026)
    db.prepare(`INSERT INTO rounds (id,contract_id,round_no,due_date,items,status,created_at) VALUES ('ROUND-HTTP-OFFLINE',?,1,'2026-08-16','[{"matrix":"废水","items":["COD"],"qty":1}]','pending','2026-08-16')`).run(contract.id)
    createUser(db, { username: 'http-sampler', name: 'HTTP采样', roles: ['sampler'], password: 'secret1' }); db.prepare(`UPDATE users SET must_change_pw=0 WHERE username='http-sampler'`).run(); assignRound(db, 'ROUND-HTTP-OFFLINE', ['http-sampler']); db.close()
    child = spawn(process.execPath, ['src/server.ts'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, PORT: String(port), DB_PATH: path, OFFLINE_WRITE_ENABLED: 'true', SENSITIVE_OFFLINE_PACKAGE_ENABLED: 'true', OFFLINE_PACKAGE_SIGNING_PRIVATE_KEY: keys.privateKey }, stdio: 'ignore' })
    const base = `http://127.0.0.1:${port}`; let login: Response | undefined
    for (let i = 0; i < 40; i++) { try { login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'http-sampler', password: 'secret1' }) }); if (login.ok) break } catch {} await new Promise(r => setTimeout(r, 25)) }
    const token = (await login!.json() as any).token
    const response = await fetch(base + '/api/rounds/ROUND-HTTP-OFFLINE/offline-package', { headers: { authorization: `Bearer ${token}`, 'x-managed-device-id': 'client-cannot-bypass', 'x-managed-device-proof': 'fake' } })
    assert.equal(response.status, 403)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal((await response.json() as any).error_code, 'FORM_RULE_NOT_APPROVED')
  } finally { child?.kill(); rmSync(dir, { recursive: true, force: true }) }
})
