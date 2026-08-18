import 'fake-indexeddb/auto'
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { beforeAll, expect, test, vi } from 'vitest'
import { createFieldTaskDraft, type OfflineTaskPackage } from '../src/offline/fieldTaskDraft'
import { IndexedDbOfflineDatabase } from '../src/offline/indexedDb'
import { withFieldDraftLock } from '../src/offline/draftLock'

vi.mock('../src/offline/managedDevice', () => ({ proveManagedDevicePossession: async () => true }))

beforeAll(() => {
  const tails = new Map<string, Promise<void>>()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (name: string, _options: unknown, callback: () => Promise<unknown>) => { const prior = tails.get(name) ?? Promise.resolve(); let release!: () => void; const turn = new Promise<void>(resolve => { release = resolve }); tails.set(name, prior.then(() => turn)); await prior; try { return await callback() } finally { release() } } } })
})

test('timer checkpoint and another realm input serialize and preserve the input', async () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  vi.stubEnv('VITE_OFFLINE_PACKAGE_PUBLIC_KEY', keys.publicKey.replace(/\n/g, '\\n'))
  const p: OfflineTaskPackage['signedPayload'] = { schemaVersion: 1, roundId: 'LOCK', assigneeId: 'lock-user', deviceId: 'd', deviceBindingPublicKeySpki: keys.publicKey, deviceBindingFingerprint: createHash('sha256').update(createPublicKey(keys.publicKey).export({ type: 'spki', format: 'der' })).digest('hex'), formCode: 'HJ-TC-136', ruleVersion: 'r', taskVersion: 't', taskVersionOrdinal: 1, samplingDate: '2026-08-17', sampleSlots: [{ sampleSlotId: '00000000-0000-4000-8000-000000000001', temporaryId:'00000000-0000-4000-8000-000000000101', qrPayload:'TC1:00000000-0000-4000-8000-000000000101', matrix: '水', items: ['COD'] }], formSchema: { globalFields: ['org','orgSign','samplingDate'], rowFields: ['sampleSlotId','sampleNo','point','time','item','volume','preserve','waterColor','smell','oil','floating','anomaly','note'] }, authorization: { scope: 'field-draft-write', deviceId: 'd', attestationId: 'a', nonce: 'n', issuedAt: '2026-08-17T00:00:00.000Z', serverTime: '2026-08-17T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' } }
  const pkg = { signedPayload: p, signature: sign('sha256', Buffer.from(JSON.stringify(p)), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') }
  const a = new IndexedDbOfflineDatabase('lock-user', indexedDB), b = new IndexedDbOfflineDatabase('lock-user', indexedDB), initial: any = await a.installDraftAtomic(pkg)
  await Promise.all([
    withFieldDraftLock(initial.id, async () => { const latest: any = (await a.snapshot()).drafts[0]; await a.checkpointDraftClockAtomic(latest, latest.payload.draftRevision, 1100) }),
    withFieldDraftLock(initial.id, async () => { const latest: any = (await b.snapshot()).drafts[0]; await b.saveDraftAtomic(latest, latest.payload.draftRevision, { scope: 'row', sampleSlotId: '00000000-0000-4000-8000-000000000001', field: 'note', value: 'kept', savedAt: '2026-08-17T00:00:01Z', wallTime: 1200 }) }),
  ])
  const restored: any = (await a.snapshot()).drafts[0]
  expect(restored.payload.rows[0].note).toBe('kept')
  expect(restored.payload.draftRevision).toBe(2)
})
