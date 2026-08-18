import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { openDb } from '../src/db.ts'
import { createSubmission, finalizeSubmission, getSubmissionReceipt, recoverSubmissions } from '../src/submissions.ts'
import { createUser, assignRound, currentOfflineTaskScope } from '../src/handlers.ts'
import { ensureSampleSlots } from '../src/mobileSampleSlots.ts'

const actor = { username: 'sampler-a', name: '采样员甲', roles: ['sampler'], status: 'active' } as any

function fixture(path = ':memory:') {
  const db = openDb(path)
  db.prepare(`INSERT OR IGNORE INTO users(username,name,roles,pass_salt,pass_hash,status,must_change_pw,created_at) VALUES('sampler-a','采样员甲','["sampler"]','x','x','active',0,'2026-08-17T00:00:00.000Z')`).run()
  db.prepare(`INSERT OR IGNORE INTO contracts(id,client,status,created_at) VALUES('c-1','客户','confirmed','2026-08-17T00:00:00.000Z')`).run()
  db.prepare(`INSERT OR IGNORE INTO rounds(id,contract_id,round_no,due_date,status,sampler,sampler_ids,assignment_status,assignment_updated_at,items,created_at) VALUES('round-1','c-1',1,'2026-08-17','pending','采样员甲','["sampler-a"]','active','2026-08-17T00:00:00.000Z','[{"matrix":"水","items":["COD"],"qty":1}]','2026-08-17T00:00:00.000Z')`).run()
  db.prepare(`INSERT OR IGNORE INTO mobile_sample_slots(sample_slot_id,temporary_id,round_id,matrix,items,sequence,state,created_at) VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','round-1','水','["COD"]',1,'active','2026-08-17')`).run()
  return db
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
}

function input(payload = { formCode: 'HJ-TC-136', draftRevision: 7, global: { org: '机构', orgSign: '张三', samplingDate: '2026-08-17' }, rows: [{ sampleSlotId: '00000000-0000-4000-8000-000000000001', sampleNo: '临1', point: '排口', time: '09:00', item: 'COD', volume: '', preserve: '', waterColor: '', smell: '', oil: '', floating: '', anomaly: '', note: '' }] }) {
  const canonicalPayload = canonicalJson(payload)
  return {
    clientSubmissionId: 'sub-00000000-0000-4000-8000-000000000001',
    roundId: 'round-1', ownerId: 'sampler-a', deviceId: 'device-a',
    taskVersion: 'round-1@task-v1', ruleVersion: 'HJ-TC-136@provisional-v1', draftRevision: 7,
    canonicalPayload, payloadHash: createHash('sha256').update(canonicalPayload).digest('hex'), attachmentReceipts: [] as string[],
  }
}

test('same client submission and payload returns one durable receipt; changed payload is rejected', () => {
  const db = fixture(), first = createSubmission(db, input(), actor, { managedDeviceId: 'device-a', expectedTaskVersion: 'round-1@task-v1', expectedRuleVersion: 'HJ-TC-136@provisional-v1' })
  const again = createSubmission(db, input(), actor, { managedDeviceId: 'device-a', expectedTaskVersion: 'round-1@task-v1', expectedRuleVersion: 'HJ-TC-136@provisional-v1' })
  assert.equal(again.receiptId, first.receiptId)
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM mobile_submissions`).get() as any).n, 1)
  assert.throws(() => createSubmission(db, input({ formCode: 'HJ-TC-136', draftRevision: 7, global: { org: '机构', orgSign: '张三', samplingDate: '2026-08-17' }, rows: [] }), actor, { managedDeviceId: 'device-a', expectedTaskVersion: 'round-1@task-v1', expectedRuleVersion: 'HJ-TC-136@provisional-v1' }), (error: any) => error.code === 'IDEMPOTENCY_MISMATCH')
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='mobile_submission_idempotency_mismatch'`).get() as any).n, 1)
  assert.throws(() => createSubmission(db, { ...input(), deviceId: 'device-b' }, actor, { managedDeviceId: 'device-b', expectedTaskVersion: 'round-1@task-v1', expectedRuleVersion: 'HJ-TC-136@provisional-v1' }), (error: any) => error.code === 'IDEMPOTENCY_SCOPE_MISMATCH')
})

test('receipt lookup does not disclose another sampler submission id', () => {
  const db=fixture(),created=createSubmission(db,input(),actor,{managedDeviceId:'device-a',expectedTaskVersion:'round-1@task-v1',expectedRuleVersion:'HJ-TC-136@provisional-v1'})
  const foreign={username:'sampler-b',name:'采样员乙',roles:['sampler'],status:'active'} as any
  assert.throws(()=>getSubmissionReceipt(db,created.clientSubmissionId,foreign),(error:any)=>error.code==='SUBMISSION_NOT_FOUND'&&error.httpStatus===404)
})

test('database commit followed by a lost response is recovered by receipt query without publishing twice', () => {
  const db = fixture(), created = createSubmission(db, input(), actor, { managedDeviceId: 'device-a', expectedTaskVersion: 'round-1@task-v1', expectedRuleVersion: 'HJ-TC-136@provisional-v1' })
  let publishes = 0
  finalizeSubmission(db, created.clientSubmissionId, actor, { publish: (_db, submission) => { publishes++; return { publicationId: `publication:${submission.clientSubmissionId}` } } })
  const queried = getSubmissionReceipt(db, created.clientSubmissionId, actor)
  const retried = finalizeSubmission(db, created.clientSubmissionId, actor, { publish: () => { publishes++; return { publicationId: 'wrong' } } })
  assert.equal(queried.status, 'complete')
  assert.equal(retried.receiptId, queried.receiptId)
  assert.equal(publishes, 1)
})

test('publisher failure rolls back partial publication but leaves durable finalizing state for restart recovery', () => {
  const db = fixture(), created = createSubmission(db, input(), actor, { managedDeviceId: 'device-a', expectedTaskVersion: 'round-1@task-v1', expectedRuleVersion: 'HJ-TC-136@provisional-v1' })
  assert.throws(() => finalizeSubmission(db, created.clientSubmissionId, actor, { publish: database => { database.prepare(`INSERT INTO audit_log(record_id,who,action,detail,at) VALUES('partial','x','partial','{}','2026-08-17')`).run(); throw new Error('publisher failed') } }), /publisher failed/)
  assert.equal(getSubmissionReceipt(db, created.clientSubmissionId, actor).status, 'finalizing')
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE record_id='partial'`).get() as any).n, 0)
})

test('server restart recovers persisted pending and finalizing submissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-submission-')), path = join(dir, 'db.sqlite')
  try {
    let db = fixture(path)
    const pending = createSubmission(db, input(), actor, { managedDeviceId: 'device-a', expectedTaskVersion: 'round-1@task-v1', expectedRuleVersion: 'HJ-TC-136@provisional-v1' })
    db.prepare(`UPDATE mobile_submissions SET status='finalizing' WHERE client_submission_id=?`).run(pending.clientSubmissionId)
    db.close()
    db = openDb(path)
    let publishes = 0
    const result = recoverSubmissions(db, { publish: (_db, submission) => { publishes++; return { publicationId: `publication:${submission.clientSubmissionId}` } } })
    assert.equal(result.completed, 1)
    assert.equal(getSubmissionReceipt(db, pending.clientSubmissionId, actor).status, 'complete')
    assert.equal(publishes, 1)
    db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('restart recovery preserves pending submissions until a later confirmation starts finalization',()=>{
  const db=fixture(),pending=createSubmission(db,input(),actor,{managedDeviceId:'device-a',expectedTaskVersion:'round-1@task-v1',expectedRuleVersion:'HJ-TC-136@provisional-v1'});let publishes=0
  const result=recoverSubmissions(db,{publish:()=>{publishes++;return{publicationId:'must-not-run'}}})
  assert.equal(result.pending,1);assert.equal(result.completed,0);assert.equal(publishes,0);assert.equal(getSubmissionReceipt(db,pending.clientSubmissionId,actor).status,'pending')
})

test('restart recovery isolates one failed finalization and continues with the remaining receipts',()=>{
  const db=fixture(),first=createSubmission(db,input(),actor,{managedDeviceId:'device-a',expectedTaskVersion:'round-1@task-v1',expectedRuleVersion:'HJ-TC-136@provisional-v1'})
  const secondInput={...input(),clientSubmissionId:'sub-00000000-0000-4000-8000-000000000002'}
  const second=createSubmission(db,secondInput,actor,{managedDeviceId:'device-a',expectedTaskVersion:'round-1@task-v1',expectedRuleVersion:'HJ-TC-136@provisional-v1'})
  db.prepare(`UPDATE mobile_submissions SET status='finalizing'`).run()
  const result=recoverSubmissions(db,{publish:(_database,submission)=>{if(submission.clientSubmissionId===first.clientSubmissionId)throw new Error('first failed');return{publicationId:`publication:${submission.clientSubmissionId}`}}})
  assert.deepEqual(result,{completed:1,pending:0,failed:1})
  assert.equal(getSubmissionReceipt(db,first.clientSubmissionId,actor).status,'finalizing')
  assert.equal(getSubmissionReceipt(db,second.clientSubmissionId,actor).status,'complete')
})

test('server requires canonical JSON rather than trusting an equivalent client serialization',()=>{
  const db=fixture(),noncanonical=input();noncanonical.canonicalPayload=JSON.stringify(JSON.parse(noncanonical.canonicalPayload),null,2);noncanonical.payloadHash=createHash('sha256').update(noncanonical.canonicalPayload).digest('hex')
  assert.throws(()=>createSubmission(db,noncanonical,actor,{managedDeviceId:'device-a',expectedTaskVersion:'round-1@task-v1',expectedRuleVersion:'HJ-TC-136@provisional-v1'}),(error:any)=>error.code==='PAYLOAD_NOT_CANONICAL')
})

test('real HTTP explicitly creates a no-store pending receipt and replayed device proof is rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-submission-http-')), dbPath = join(dir, 'db.sqlite'), port = 44900 + Math.floor(Math.random() * 200)
  let child: ReturnType<typeof spawn> | undefined
  try {
    const db = openDb(dbPath)
    db.prepare(`INSERT INTO contracts(id,client,status,created_at) VALUES('c-http','客户','confirmed','2026-08-17')`).run()
    db.prepare(`INSERT INTO rounds(id,contract_id,round_no,due_date,status,items,created_at) VALUES('round-http','c-http',1,'2026-08-17','pending','[{"matrix":"水","items":["COD"],"qty":1}]','2026-08-17')`).run()
    createUser(db, { username: 'http-sampler', name: 'HTTP采样', roles: ['sampler'], password: 'secret1' }); db.prepare(`UPDATE users SET must_change_pw=0 WHERE username='http-sampler'`).run(); assignRound(db, 'round-http', ['http-sampler'])
    const slotId=ensureSampleSlots(db,'round-http',[{matrix:'水',items:['COD'],qty:1}])[0].sampleSlotId
    const scope = currentOfflineTaskScope(db, 'round-http'); db.close()
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), publicKeySpki = publicKey.export({ type: 'spki', format: 'pem' }).toString(), fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
    child = spawn(process.execPath, ['src/server.ts'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, PORT: String(port), DB_PATH: dbPath, OFFLINE_WRITE_ENABLED: 'true', SENSITIVE_OFFLINE_PACKAGE_ENABLED: 'true', SIGNED_FORM_RULE_APPROVED: 'true', MOBILE_SUBMISSION_ENABLED: 'true', MANAGED_DEVICE_REGISTRY_JSON: JSON.stringify({ 'http-sampler|round-http': { deviceId: 'device-http', compliant: true, expiresAt: '2099-01-01T00:00:00.000Z', publicKeySpki, fingerprint } }) }, stdio: 'ignore' })
    const base = `http://127.0.0.1:${port}`; let login: Response | undefined
    for (let i = 0; i < 60; i++) { try { login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'http-sampler', password: 'secret1' }) }); if (login.ok) break } catch {}; await new Promise(resolve => setTimeout(resolve, 25)) }
    const token = (await login!.json() as any).token, canonicalPayload = canonicalJson({draftRevision:3,formCode:'HJ-TC-136',global:{org:'机构',orgSign:'张三',samplingDate:'2026-08-17'},rows:[{sampleSlotId:slotId,sampleNo:'临1',point:'排口',time:'09:00',item:'COD',volume:'',preserve:'',waterColor:'',smell:'',oil:'',floating:'',anomaly:'',note:''}]}), payloadHash = createHash('sha256').update(canonicalPayload).digest('hex')
    const body = { clientSubmissionId: 'submission-http-00000001', taskVersion: scope.taskVersion, ruleVersion: scope.ruleVersion, draftRevision: 3, canonicalPayload, payloadHash, attachmentReceipts: [] }, raw = JSON.stringify(body), bodyHash = createHash('sha256').update(raw).digest('hex'), path = '/api/rounds/round-http/mobile-submissions', nonce = 'submission-http-nonce-0001', issuedAt = new Date().toISOString()
    const canonical = ['POST', path, 'http-sampler', 'round-http', '', body.clientSubmissionId, payloadHash, '', 'application/json', bodyHash, '3', scope.taskVersion, scope.ruleVersion, nonce, issuedAt].join('\n')
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-device-nonce': nonce, 'x-device-issued-at': issuedAt, 'x-device-signature': sign('sha256', Buffer.from(canonical), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64'), 'x-task-version': scope.taskVersion, 'x-rule-version': scope.ruleVersion, 'x-content-revision': '3' }
    const created = await fetch(base + path, { method: 'POST', headers, body: raw }); assert.equal(created.status, 200); assert.equal(created.headers.get('cache-control'), 'private, no-store'); const receipt = await created.json() as any; assert.equal(receipt.status, 'pending');assert.equal('canonicalPayload' in receipt,false);assert.equal('deviceId' in receipt,false)
    const replay = await fetch(base + path, { method: 'POST', headers, body: raw }); assert.equal(replay.status, 409); assert.equal((await replay.json() as any).error_code, 'DEVICE_PROOF_REPLAY')
    const queried = await fetch(base + `/api/mobile-submissions/${body.clientSubmissionId}`, { headers: { authorization: `Bearer ${token}` } }); assert.equal(queried.status, 200); assert.equal(queried.headers.get('cache-control'), 'private, no-store'); assert.equal((await queried.json() as any).receiptId, receipt.receiptId)
  } finally { child?.kill(); rmSync(dir, { recursive: true, force: true }) }
})
