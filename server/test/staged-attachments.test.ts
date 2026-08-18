import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { openDb, resolveLegacyStagingDir } from '../src/db.ts'
import { stageAttachment, getStagedAttachmentStatus, cancelStagedAttachment, addStagedAttachmentRef, gcStagedAttachments, startStagingGcTimer, createUser, assignRound, currentOfflineTaskScope } from '../src/handlers.ts'
import { detectImageMime } from '../src/attachmentSecurity.ts'

function fixture() {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO users(username,name,roles,pass_salt,pass_hash,status,must_change_pw,created_at) VALUES('sampler-a','同名','["sampler"]','x','x','active',0,'2026-08-17T00:00:00.000Z')`).run()
  db.prepare(`INSERT INTO contracts(id,client,status,created_at) VALUES('c-1','客户','confirmed','2026-08-17T00:00:00.000Z')`).run()
  db.prepare(`INSERT INTO rounds(id,contract_id,round_no,due_date,status,sampler,sampler_ids,assignment_status,assignment_updated_at,items,created_at) VALUES('round-1','c-1',1,'2026-08-17','pending','同名','["sampler-a"]','active','2026-08-17T00:00:00.000Z','[{"matrix":"水","qty":1}]','2026-08-17T00:00:00.000Z')`).run()
  return db
}
const actor = { username: 'sampler-a', name: '同名', roles: ['sampler'], status: 'active' } as any
const input = { roundId: 'round-1', sampleSlotId: 'round-1:水:1', clientAttachmentId: 'local-a', hash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', mime: 'image/jpeg', size: 3, revision: 1 }

test('openDb upgrades legacy UUID files and preserves missing or corrupt ledgers',()=>{const dir=mkdtempSync(join(tmpdir(),'legacy-stage-')),dbPath=join(dir,'legacy.sqlite'),goodName='11111111-1111-4111-8111-111111111111.jpg',badName='22222222-2222-4222-8222-222222222222.jpg',missingName='33333333-3333-4333-8333-333333333333.jpg',good=Buffer.from([0xff,0xd8,0xff,1]),bad=Buffer.from('bad');try{const raw=new DatabaseSync(dbPath);raw.exec(`CREATE TABLE staged_attachments(receipt_id TEXT PRIMARY KEY,round_id TEXT,stored_name TEXT,content_hash TEXT,mime TEXT,size INTEGER,status TEXT);`);raw.prepare(`INSERT INTO staged_attachments VALUES(?,?,?,?,?,?,?)`).run('good','r',goodName,createHash('sha256').update(good).digest('hex'),'image/jpeg',good.length,'legacy_pending');raw.prepare(`INSERT INTO staged_attachments VALUES(?,?,?,?,?,?,?)`).run('bad','r',badName,'0'.repeat(64),'image/jpeg',bad.length,'legacy_pending');raw.prepare(`INSERT INTO staged_attachments VALUES(?,?,?,?,?,?,?)`).run('missing','r',missingName,'0'.repeat(64),'image/jpeg',4,'legacy_pending');raw.close();writeFileSync(join(dir,goodName),good);writeFileSync(join(dir,badName),bad);const db=openDb(dbPath,{legacyStagingDir:dir});const goodRow=db.prepare(`SELECT status,blob,stored_name,cleanup_pending FROM staged_attachments WHERE receipt_id='good'`).get() as any;assert.equal(goodRow.status,'uploaded_staged');assert.deepEqual(Buffer.from(goodRow.blob),good);assert.equal(goodRow.stored_name,null);assert.equal(goodRow.cleanup_pending,0);assert.equal(existsSync(join(dir,goodName)),false);assert.equal((db.prepare(`SELECT status FROM staged_attachments WHERE receipt_id='bad'`).get() as any).status,'storage_error');assert.equal(existsSync(join(dir,badName)),true);assert.equal((db.prepare(`SELECT status FROM staged_attachments WHERE receipt_id='missing'`).get() as any).status,'storage_error');db.close()}finally{rmSync(dir,{recursive:true,force:true})}})

test('legacy migration rejects traversal and symlinks, and retries cleanup after unlink failure',()=>{const dir=mkdtempSync(join(tmpdir(),'legacy-safe-')),dbPath=join(dir,'legacy.sqlite'),name='44444444-4444-4444-8444-444444444444.jpg',linkName='55555555-5555-4555-8555-555555555555.jpg',bytes=Buffer.from([0xff,0xd8,0xff,2]),hash=createHash('sha256').update(bytes).digest('hex');try{const raw=new DatabaseSync(dbPath);raw.exec(`CREATE TABLE staged_attachments(receipt_id TEXT PRIMARY KEY,round_id TEXT,stored_name TEXT,content_hash TEXT,mime TEXT,size INTEGER,status TEXT);`);for(const [id,file] of [['good',name],['escape','../outside.jpg'],['link',linkName]])raw.prepare(`INSERT INTO staged_attachments VALUES(?,?,?,?,?,?,?)`).run(id,'r',file,hash,'image/jpeg',bytes.length,'legacy_pending');raw.close();writeFileSync(join(dir,name),bytes);writeFileSync(join(dir,'outside.jpg'),bytes);symlinkSync(join(dir,'outside.jpg'),join(dir,linkName));const first=openDb(dbPath,{legacyStagingDir:dir,unlinkFile:()=>{throw new Error('busy')}});const pending=first.prepare(`SELECT blob,stored_name,cleanup_pending FROM staged_attachments WHERE receipt_id='good'`).get() as any;assert.deepEqual(Buffer.from(pending.blob),bytes);assert.equal(pending.stored_name,name);assert.equal(pending.cleanup_pending,1);assert.equal((first.prepare(`SELECT status FROM staged_attachments WHERE receipt_id='escape'`).get() as any).status,'storage_error');assert.equal((first.prepare(`SELECT status FROM staged_attachments WHERE receipt_id='link'`).get() as any).status,'storage_error');first.close();const second=openDb(dbPath,{legacyStagingDir:dir});assert.equal((second.prepare(`SELECT stored_name FROM staged_attachments WHERE receipt_id='good'`).get() as any).stored_name,null);assert.equal(existsSync(join(dir,name)),false);assert.equal(existsSync(join(dir,'outside.jpg')),true);second.close()}finally{rmSync(dir,{recursive:true,force:true})}})

test('cleanup treats ENOENT after unlink-before-marker crash as completed on next start',()=>{const dir=mkdtempSync(join(tmpdir(),'legacy-crash-')),dbPath=join(dir,'legacy.sqlite'),name='66666666-6666-4666-8666-666666666666.jpg',bytes=Buffer.from([0xff,0xd8,0xff,3]),hash=createHash('sha256').update(bytes).digest('hex');try{const raw=new DatabaseSync(dbPath);raw.exec(`CREATE TABLE staged_attachments(receipt_id TEXT PRIMARY KEY,round_id TEXT,stored_name TEXT,content_hash TEXT,mime TEXT,size INTEGER,status TEXT);`);raw.prepare(`INSERT INTO staged_attachments VALUES(?,?,?,?,?,?,?)`).run('crash','r',name,hash,'image/jpeg',bytes.length,'legacy_pending');raw.close();writeFileSync(join(dir,name),bytes);let once=true;const first=openDb(dbPath,{legacyStagingDir:dir,beforeCleanupMarker:()=>{if(once){once=false;throw new Error('simulated marker crash')}}});const pending=first.prepare(`SELECT blob,stored_name,cleanup_pending FROM staged_attachments WHERE receipt_id='crash'`).get() as any;assert.deepEqual(Buffer.from(pending.blob),bytes);assert.equal(pending.stored_name,name);assert.equal(pending.cleanup_pending,1);assert.equal(existsSync(join(dir,name)),false);first.close();const second=openDb(dbPath,{legacyStagingDir:dir});const recovered=second.prepare(`SELECT blob,stored_name,cleanup_pending FROM staged_attachments WHERE receipt_id='crash'`).get() as any;assert.deepEqual(Buffer.from(recovered.blob),bytes);assert.equal(recovered.stored_name,null);assert.equal(recovered.cleanup_pending,0);second.close()}finally{rmSync(dir,{recursive:true,force:true})}})

test('legacy directory override wins while default remains UPLOAD_DIR/.staging',()=>{assert.equal(resolveLegacyStagingDir('/srv/uploads'),resolve('/srv/uploads/.staging'));assert.equal(resolveLegacyStagingDir('/srv/uploads','/mnt/legacy-only'),'/mnt/legacy-only')})

test('image magic accepts only JPEG, PNG, WebP and HEIC signatures',()=>{
  assert.equal(detectImageMime(Buffer.from([0xff,0xd8,0xff])),'image/jpeg')
  assert.equal(detectImageMime(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])),'image/png')
  assert.equal(detectImageMime(Buffer.from('RIFFxxxxWEBP')),'image/webp')
  assert.equal(detectImageMime(Buffer.from('xxxxftypheic')),'image/heic')
  assert.equal(detectImageMime(Buffer.from('<script>')),null)
})

test('same attachment key and hash is idempotent, conflicting payload is rejected', () => {
  const db = fixture()
  const first = stageAttachment(db, input, Buffer.from('abc'), actor, { managedDeviceId: 'device-a', now: () => new Date('2026-08-17T01:00:00Z') })
  const retry = stageAttachment(db, input, Buffer.from('abc'), actor, { managedDeviceId: 'device-a', now: () => new Date('2026-08-17T01:01:00Z') })
  assert.equal(retry.receiptId, first.receiptId)
  assert.throws(() => stageAttachment(db, { ...input, hash: '3608bca1e44ea6c4d268eb6db02260269892c0b42b86bbf1e77a6fa16c3c9282' }, Buffer.from('xyz'), actor, { managedDeviceId: 'device-a' }), /ATTACHMENT_IDEMPOTENCY_CONFLICT/)
})

test('status query recovers a lost response and enforces current assignment and lease', () => {
  const db = fixture()
  const receipt = stageAttachment(db, input, Buffer.from('abc'), actor, { managedDeviceId: 'device-a', now: () => new Date('2026-08-17T01:00:00Z') })
  assert.equal(getStagedAttachmentStatus(db, 'round-1', 'local-a', actor, { managedDeviceId: 'device-a', now: () => new Date('2026-08-17T01:02:00Z') }).receiptId, receipt.receiptId)
  db.prepare(`UPDATE rounds SET assignment_status='revoked' WHERE id='round-1'`).run()
  assert.throws(() => getStagedAttachmentStatus(db, 'round-1', 'local-a', actor, { managedDeviceId: 'device-a' }), /无权访问该期次/)
})

test('staged bytes, ledger and audit commit atomically; expiry creates a new same-hash generation', () => {
  const db = fixture(), now = () => new Date('2026-08-17T01:00:00Z')
  const first = stageAttachment(db, input, Buffer.from('abc'), actor, { managedDeviceId: 'device-a', now, leaseMs: 1000 })
  const row = db.prepare(`SELECT blob,status,generation FROM staged_attachments WHERE receipt_id=?`).get(first.receiptId) as any
  assert.equal(Buffer.from(row.blob).toString(), 'abc'); assert.equal(row.status, 'uploaded_staged'); assert.equal(row.generation, 1)
  const expired = getStagedAttachmentStatus(db, 'round-1', 'local-a', actor, { managedDeviceId: 'device-a', now: () => new Date('2026-08-17T01:00:02Z') })
  assert.equal(expired.status, 'expired'); assert.equal((db.prepare(`SELECT status FROM staged_attachments WHERE receipt_id=?`).get(first.receiptId) as any).status, 'expired')
  const next = stageAttachment(db, input, Buffer.from('abc'), actor, { managedDeviceId: 'device-a', now: () => new Date('2026-08-17T01:00:03Z') })
  assert.notEqual(next.receiptId, first.receiptId); assert.equal((db.prepare(`SELECT generation FROM staged_attachments WHERE receipt_id=?`).get(next.receiptId) as any).generation, 2)
})

test('cancel atomically removes bytes and leaves tombstone audit', () => {
  const db = fixture(), staged = stageAttachment(db, input, Buffer.from('abc'), actor, { managedDeviceId: 'device-a' })
  cancelStagedAttachment(db, 'round-1', 'local-a', actor, { managedDeviceId: 'device-a' })
  const row = db.prepare(`SELECT blob,status FROM staged_attachments WHERE receipt_id=?`).get(staged.receiptId) as any
  assert.equal(row.blob, null); assert.equal(row.status, 'cancelled')
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE record_id='round-1' AND action='attachment_stage_cancel'`).get() as any).n, 1)
})

test('GC deletes only terminal unreferenced generations', () => {
  const db = fixture(), first = stageAttachment(db, input, Buffer.from('abc'), actor, { managedDeviceId: 'device-a', now: () => new Date('2026-08-17T01:00:00Z'), leaseMs: 1 })
  getStagedAttachmentStatus(db, 'round-1', 'local-a', actor, { managedDeviceId: 'device-a', now: () => new Date('2026-08-17T01:00:01Z') })
  addStagedAttachmentRef(db, first.receiptId, 'test', 'keep')
  assert.equal(gcStagedAttachments(db).deleted, 0)
  assert.throws(()=>stageAttachment(db,input,Buffer.from('abc'),actor,{managedDeviceId:'device-a'}),/ATTACHMENT_GENERATION_REFERENCED/)
  db.prepare(`DELETE FROM staged_attachment_refs WHERE receipt_id=?`).run(first.receiptId)
  assert.equal(gcStagedAttachments(db).deleted, 1)
})

test('GC failure rolls back expiry and blob cleanup, then generation advances',()=>{
  const db=fixture(),first=stageAttachment(db,input,Buffer.from('abc'),actor,{managedDeviceId:'device-a',now:()=>new Date('2026-08-17T01:00:00Z'),leaseMs:1})
  db.exec(`CREATE TRIGGER stop_gc BEFORE UPDATE ON staged_attachments WHEN NEW.blob IS NULL BEGIN SELECT RAISE(ABORT,'gc failed'); END`)
  assert.throws(()=>gcStagedAttachments(db,new Date('2026-08-17T01:00:01Z')),/gc failed/)
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM staged_attachments WHERE receipt_id=?`).get(first.receiptId) as any).n,1)
  db.exec('DROP TRIGGER stop_gc')
  gcStagedAttachments(db,new Date('2026-08-17T01:00:01Z'))
  const second=stageAttachment(db,input,Buffer.from('abc'),actor,{managedDeviceId:'device-a'})
  assert.equal((db.prepare(`SELECT generation FROM staged_attachments WHERE receipt_id=?`).get(second.receiptId) as any).generation,2)
})

test('GC persists lease expiry without a status GET and failed business validation does not consume nonce',()=>{const db=fixture(),proof={nonce:'nonce-safe-retry-0001',issuedAt:'2026-08-17T01:00:00.000Z',expiresAt:'2026-08-17T01:05:00.000Z'};stageAttachment(db,input,Buffer.from('abc'),actor,{managedDeviceId:'device-a',now:()=>new Date('2026-08-17T01:00:00Z'),leaseMs:1});assert.equal(gcStagedAttachments(db,new Date('2026-08-17T01:00:01Z')).deleted,1);assert.throws(()=>stageAttachment(db,{...input,clientAttachmentId:'retry',hash:'0'.repeat(64)},Buffer.from('abc'),actor,{managedDeviceId:'device-a',requestNonce:proof}),/HASH_MISMATCH/);assert.equal((db.prepare(`SELECT COUNT(*) n FROM device_request_nonces WHERE nonce=?`).get(proof.nonce) as any).n,0);assert.equal(stageAttachment(db,{...input,clientAttachmentId:'retry'},Buffer.from('abc'),actor,{managedDeviceId:'device-a',requestNonce:proof}).status,'uploaded_staged');assert.throws(()=>getStagedAttachmentStatus(db,'round-1','retry',actor,{managedDeviceId:'device-a',requestNonce:proof}),/UNIQUE constraint/)} )

test('production GC timer expires and clears blobs without uploads',async()=>{const db=fixture();stageAttachment(db,input,Buffer.from('abc'),actor,{managedDeviceId:'device-a',now:()=>new Date('2026-08-17T01:00:00Z'),leaseMs:1});const stop=startStagingGcTimer(db,10,()=>new Date('2026-08-17T01:00:01Z'));await new Promise(resolve=>setTimeout(resolve,35));stop();const row=db.prepare(`SELECT status,blob FROM staged_attachments WHERE client_attachment_id='local-a'`).get() as any;assert.equal(row.status,'expired');assert.equal(row.blob,null)})

test('GC bounds nonce storage while retaining the 24 hour audit window',()=>{const db=fixture();db.prepare(`INSERT INTO device_request_nonces VALUES(?,?,?,?)`).run('d','old','2026-08-14T00:00:00Z','2026-08-14T00:05:00Z');db.prepare(`INSERT INTO device_request_nonces VALUES(?,?,?,?)`).run('d','recent','2026-08-16T12:00:00Z','2099-08-16T12:05:00Z');const result=gcStagedAttachments(db,new Date('2026-08-17T13:00:00Z'));assert.equal(result.noncesDeleted,1);assert.deepEqual((db.prepare(`SELECT nonce FROM device_request_nonces`).all() as any[]).map(x=>x.nonce),['recent'])})

test('server rejects absent managed-device proof, hash mismatch and foreign slot', () => {
  const db = fixture()
  assert.throws(() => stageAttachment(db, input, Buffer.from('abc'), actor, {}), /MANAGED_DEVICE_REQUIRED/)
  assert.throws(() => stageAttachment(db, { ...input, hash: '0'.repeat(64) }, Buffer.from('abc'), actor, { managedDeviceId: 'device-a' }), /ATTACHMENT_HASH_MISMATCH/)
  assert.throws(() => stageAttachment(db, { ...input, sampleSlotId: 'other:slot' }, Buffer.from('abc'), actor, { managedDeviceId: 'device-a' }), /ATTACHMENT_SLOT_MISMATCH/)
})

test('real HTTP upload, lost-response query and cancel are no-store and ignore client device spoofing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staged-attachment-http-')), dbPath = join(dir, 'db.sqlite'), stageDir = join(dir, 'stage'), port = 44600 + Math.floor(Math.random() * 300)
  let child: ReturnType<typeof spawn> | undefined
  try {
    const db = openDb(dbPath)
    db.prepare(`INSERT INTO contracts(id,client,status,created_at) VALUES('c-http','客户','confirmed','2026-08-17')`).run()
    db.prepare(`INSERT INTO rounds(id,contract_id,round_no,due_date,status,items,created_at) VALUES('round-http','c-http',1,'2026-08-17','pending','[{"matrix":"水","qty":1}]','2026-08-17')`).run()
    createUser(db, { username: 'http-sampler', name: 'HTTP采样', roles: ['sampler'], password: 'secret1' }); db.prepare(`UPDATE users SET must_change_pw=0 WHERE username='http-sampler'`).run(); assignRound(db, 'round-http', ['http-sampler']); const packageScope=currentOfflineTaskScope(db,'round-http');db.close()
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), publicKeySpki = publicKey.export({ type: 'spki', format: 'pem' }).toString(), fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
    child = spawn(process.execPath, ['src/server.ts'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, PORT: String(port), DB_PATH: dbPath, ATTACHMENT_STAGING_DIR: stageDir, OFFLINE_WRITE_ENABLED: 'true', SENSITIVE_OFFLINE_PACKAGE_ENABLED: 'true', SIGNED_FORM_RULE_APPROVED: 'true', MANAGED_DEVICE_REGISTRY_JSON: JSON.stringify({ 'http-sampler|round-http': { deviceId: 'server-device', compliant: true, revoked: false, expiresAt: '2099-01-01T00:00:00.000Z', publicKeySpki, fingerprint } }) }, stdio: 'ignore' })
    const base = `http://127.0.0.1:${port}`; let login: Response | undefined
    for (let i = 0; i < 50; i++) { try { login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'http-sampler', password: 'secret1' }) }); if (login.ok) break } catch {}; await new Promise(resolve => setTimeout(resolve, 25)) }
    const token = (await login!.json() as any).token, auth = { authorization: `Bearer ${token}` }, body = Buffer.from([0xff,0xd8,0xff,0x01]), hash = createHash('sha256').update(body).digest('hex'), emptyHash=createHash('sha256').update('').digest('hex')
    let nonceNo=0
    const proof=(method:string,path:string,fields:{sampleSlotId?:string;attachmentId?:string;hash?:string;size?:number;mime?:string;bodyHash:string;contentRevision?:number})=>{const nonce=`nonce-http-${String(++nonceNo).padStart(16,'0')}`,issuedAt=new Date().toISOString(),canonical=[method,path,'http-sampler','round-http',fields.sampleSlotId??'',fields.attachmentId??'',fields.hash??'',String(fields.size??''),fields.mime??'',fields.bodyHash,String(fields.contentRevision??''),packageScope.taskVersion,packageScope.ruleVersion,nonce,issuedAt].join('\n');return {'x-device-nonce':nonce,'x-device-issued-at':issuedAt,'x-device-signature':sign('sha256',Buffer.from(canonical),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64'),'x-task-version':packageScope.taskVersion,'x-rule-version':packageScope.ruleVersion}}
    const uploadPath='/api/rounds/round-http/staged-attachments', uploadProof=proof('POST',uploadPath,{sampleSlotId:'round-http:水:1',attachmentId:'local-http',hash,size:body.length,mime:'image/jpeg',bodyHash:hash,contentRevision:1}), uploadHeaders={ ...auth, ...uploadProof, 'content-type': 'image/jpeg', 'x-client-attachment-id': 'local-http', 'x-sample-slot-id': encodeURIComponent('round-http:水:1'), 'x-content-sha256': hash, 'x-content-size': String(body.length), 'x-content-revision': '1', 'x-managed-device-id': 'spoof-is-ignored' },upload = await fetch(base + uploadPath, { method: 'POST', headers:uploadHeaders, body })
    assert.equal(upload.status, 200); assert.equal(upload.headers.get('cache-control'), 'private, no-store'); const receipt = (await upload.json() as any).receiptId
    const replay=await fetch(base+uploadPath,{method:'POST',headers:uploadHeaders,body});assert.equal(replay.status,409)
    const tampered=await fetch(base+uploadPath,{method:'POST',headers:{...uploadHeaders,...proof('POST',uploadPath,{sampleSlotId:'round-http:水:1',attachmentId:'local-http',hash,size:body.length,mime:'image/jpeg',bodyHash:'0'.repeat(64)})},body});assert.equal(tampered.status,403)
    const oldNonce='nonce-http-expired-0001',oldIssued='2020-01-01T00:00:00.000Z',oldCanonical=['POST',uploadPath,'http-sampler','round-http','round-http:水:1','local-http',hash,String(body.length),'image/jpeg',hash,oldNonce,oldIssued].join('\n'),expired=await fetch(base+uploadPath,{method:'POST',headers:{...uploadHeaders,'x-device-nonce':oldNonce,'x-device-issued-at':oldIssued,'x-device-signature':sign('sha256',Buffer.from(oldCanonical),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64')},body});assert.equal(expired.status,403)
    const itemPath='/api/rounds/round-http/staged-attachments/local-http', query = await fetch(base + itemPath, { headers: { ...auth,...proof('GET',itemPath,{attachmentId:'local-http',bodyHash:emptyHash}) } })
    assert.equal(query.status, 200); assert.equal(query.headers.get('cache-control'), 'private, no-store'); assert.equal((await query.json() as any).receiptId, receipt)
    const cancel = await fetch(base + itemPath+'?action=cancel', { method: 'POST', headers: { ...auth,...proof('POST',itemPath,{attachmentId:'local-http',bodyHash:emptyHash}) } })
    assert.equal(cancel.status, 200); assert.deepEqual(await cancel.json(), { receiptId: receipt, status: 'cancelled' })
  } finally { child?.kill(); rmSync(dir, { recursive: true, force: true }) }
})
