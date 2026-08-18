import 'fake-indexeddb/auto'
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { IndexedDbOfflineDatabase } from '../src/offline/indexedDb'
import { createFieldTaskDraft, evaluateOfflineAuthorization, reconcileTaskDraft, renewalValid, renewTaskAuthorization, verifyFieldTaskDraft, verifyOfflineTaskPackage, type OfflineTaskPackage } from '../src/offline/fieldTaskDraft'

vi.mock('../src/offline/managedDevice', () => ({ proveManagedDevicePossession: async () => true }))

const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
beforeAll(() => { vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-16T08:30:00.000Z')); Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, callback: () => unknown) => callback() } }); vi.stubEnv('VITE_OFFLINE_PACKAGE_PUBLIC_KEY', keys.publicKey.replace(/\n/g, '\\n')) })
afterAll(() => vi.restoreAllMocks())
function pkg(owner = 'user-a', taskVersion = 'ROUND-1@v1'): OfflineTaskPackage {
  const signedPayload = {
    schemaVersion: 1 as const, roundId: 'ROUND-1', assigneeId: owner, deviceId: 'mdm-1', deviceBindingPublicKeySpki: keys.publicKey, deviceBindingFingerprint: createHash('sha256').update(createPublicKey(keys.publicKey).export({ type: 'spki', format: 'der' })).digest('hex'), formCode: 'HJ-TC-136' as const,
    ruleVersion: 'HJ-TC-136@provisional-v1', taskVersion, taskVersionOrdinal: taskVersion.includes('v2') ? 2 : 1, samplingDate: '2026-08-16',
    sampleSlots: [{ sampleSlotId: '00000000-0000-4000-8000-000000000001', temporaryId:'00000000-0000-4000-8000-000000000101', qrPayload:'TC1:00000000-0000-4000-8000-000000000101', matrix: '废水', items: ['COD'] }],
    formSchema: { globalFields: ['org', 'orgSign', 'samplingDate'], rowFields: ['sampleSlotId', 'sampleNo', 'point', 'time', 'item', 'volume', 'preserve', 'waterColor', 'smell', 'oil', 'floating', 'anomaly', 'note'] },
    authorization: { scope: 'field-draft-write' as const, deviceId: 'mdm-1', attestationId: 'att-1', nonce: 'nonce-1', issuedAt: '2026-08-16T08:00:00.000Z', serverTime: '2026-08-16T08:00:00.000Z', expiresAt: '2026-08-17T08:00:00.000Z' },
  }
  const signature = sign('sha256', Buffer.from(JSON.stringify(signedPayload)), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  return { signedPayload, signature }
}
const draft = (owner = 'user-a') => createFieldTaskDraft(pkg(owner), 1_000_000)
const installed = (db: IndexedDbOfflineDatabase, owner = 'user-a') => db.installDraftAtomic(pkg(owner)) as Promise<any>

describe('signed field package', () => {
  test('valid P-256 package verifies and any signed field tamper fails', async () => {
    expect(await verifyOfflineTaskPackage(pkg(), keys.publicKey)).toBe(true)
    const changed = structuredClone(pkg()); changed.signedPayload.sampleSlots[0].items = ['伪造']
    expect(await verifyOfflineTaskPackage(changed, keys.publicKey)).toBe(false)
    const invalidBinding = pkg(); invalidBinding.signedPayload.deviceBindingFingerprint = '0'.repeat(64)
    invalidBinding.signature = sign('sha256', Buffer.from(JSON.stringify(invalidBinding.signedPayload)), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    expect(await verifyOfflineTaskPackage(invalidBinding, keys.publicKey)).toBe(false)
    expect(await verifyOfflineTaskPackage(pkg(), '')).toBe(false)
  })

  test('clock rollback, forward jump and expiry immediately make verified draft readonly', async () => {
    expect(await verifyFieldTaskDraft(draft(), keys.publicKey, 1_060_000, crypto, 'mdm-1')).toEqual({ editable: true })
    expect(await verifyFieldTaskDraft(draft(), keys.publicKey, 1_060_000, crypto, null)).toMatchObject({ editable: false, reason: 'scope_invalid' })
    expect(evaluateOfflineAuthorization(draft(), 999_999)).toMatchObject({ editable: false, reason: 'clock_untrusted' })
    expect(evaluateOfflineAuthorization(draft(), 1_000_000 + 7 * 86_400_000)).toMatchObject({ editable: false, reason: 'clock_untrusted' })
    expect(evaluateOfflineAuthorization(draft(), 1_000_000 + 86_400_001)).toMatchObject({ editable: false, reason: 'authorization_expired' })
  })
})

describe('atomic HJ-TC-136 persistence', () => {
  test('direct adapter rejects a locally sealed and ALLOW-marked package outside the trusted server key', async () => {
    const rogueKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    const rogue = pkg('rogue-user'); rogue.signature = sign('sha256', Buffer.from(JSON.stringify(rogue.signedPayload)), { key: rogueKeys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    await expect(new IndexedDbOfflineDatabase('rogue-user', indexedDB).installDraftAtomic(rogue)).rejects.toThrow('DRAFT_INSTALL_TRUST_INVALID')
  })

  test('expired signed package cannot be re-anchored with a fresh local wall clock', async () => {
    const user = `expired-${Date.now()}`, expired = pkg(user); expired.signedPayload.authorization.expiresAt = '2026-08-16T09:00:00Z'; expired.signature = sign('sha256', Buffer.from(JSON.stringify(expired.signedPayload)), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    await expect(new IndexedDbOfflineDatabase(user, indexedDB).installDraftAtomic(expired)).rejects.toThrow('DRAFT_INSTALL_TRUST_INVALID')
  })

  test.each([
    ['invalid', { serverTime: 'not-a-date' }],
    ['offset', { serverTime: '2026-08-16T16:00:00.000+08:00' }],
    ['noncanonical', { issuedAt: '2026-08-16T08:00:00Z' }],
    ['server not before expiry', { serverTime: '2026-08-17T08:00:00.000Z', expiresAt: '2026-08-17T08:00:00.000Z' }],
    ['issued after server', { issuedAt: '2026-08-16T09:00:00.000Z', serverTime: '2026-08-16T08:00:00.000Z' }],
  ])('public install rejects %s signed authorization time', async (_case, patch) => {
    const user = `bad-time-${_case}-${Date.now()}`, invalid = pkg(user); invalid.signedPayload.authorization = { ...invalid.signedPayload.authorization, ...patch }; invalid.signature = sign('sha256', Buffer.from(JSON.stringify(invalid.signedPayload)), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    await expect(new IndexedDbOfflineDatabase(user, indexedDB).installDraftAtomic(invalid)).rejects.toThrow('DRAFT_INSTALL_TRUST_INVALID')
  })

  test('real IndexedDB conflict DENY survives reopen with or without the main terminal write', async () => {
    const user = `real-conflict-${Date.now()}`, db = new IndexedDbOfflineDatabase(user, indexedDB), initial = await installed(db, user)
    await db.denyDraftAuthority(initial, 'conflict')
    const terminal: any = await db.persistDraftTerminal(initial.id, 'conflict', 1_060_000)
    const reopened: any = (await new IndexedDbOfflineDatabase(user, indexedDB).snapshot()).drafts[0]
    expect(reopened.payload.control.terminal).toBe('conflict'); expect((await db.draftWriteStatus(reopened)).allowed).toBe(false)

    const fallbackUser = `real-conflict-fallback-${Date.now()}`, fallbackDb = new IndexedDbOfflineDatabase(fallbackUser, indexedDB), active = await installed(fallbackDb, fallbackUser)
    await fallbackDb.denyDraftAuthority(active, 'conflict') // simulate main-terminal database failure after mandatory DENY
    const fallbackReopened: any = (await new IndexedDbOfflineDatabase(fallbackUser, indexedDB).snapshot()).drafts[0]
    expect(fallbackReopened.payload.control.terminal).toBe('active'); expect((await fallbackDb.draftWriteStatus(fallbackReopened)).allowed).toBe(false)
    expect(terminal.payload.control.terminal).toBe('conflict')
  })

  test('full frozen schema creates one row per slot and preserves every field across reopen/migration', async () => {
    const user = `schema-${Date.now()}`; const db = new IndexedDbOfflineDatabase(user, indexedDB); const initial = await installed(db, user)
    const one = await db.saveDraftAtomic!(initial, 0, { scope: 'global', field: 'orgSign', value: '客户签字', savedAt: '2026-08-16T08:01:00.000Z', wallTime: 1_060_000 })
    await db.saveDraftAtomic!(one, 1, { scope: 'row', sampleSlotId: '00000000-0000-4000-8000-000000000001', field: 'waterColor', value: '微黄', savedAt: '2026-08-16T08:02:00.000Z', wallTime: 1_120_000 })
    await expect(db.migrate(2)).rejects.toThrow('FIELD_DRAFT_VERIFIED_MIGRATION_REQUIRED')
    const reopened = new IndexedDbOfflineDatabase(user, indexedDB); const restored: any = (await reopened.snapshot()).drafts[0]
    expect(restored.payload.global.orgSign).toBe('客户签字')
    expect(restored.payload.rows[0]).toMatchObject({ sampleSlotId: '00000000-0000-4000-8000-000000000001', waterColor: '微黄', sampleNo: '', smell: '', oil: '', floating: '', anomaly: '' })
  })

  test('frozen schema rejects missing keys, extra keys and sampling date changes', async () => {
    for (const mutate of [
      (value: any) => { delete value.payload.global.org },
      (value: any) => { value.payload.global.extra = '' },
      (value: any) => { value.payload.global.samplingDate = '2099-01-01' },
      (value: any) => { delete value.payload.rows[0].note },
      (value: any) => { value.payload.rows[0].extra = '' },
    ]) { const changed: any = draft(); mutate(changed); expect(await verifyFieldTaskDraft(changed, keys.publicKey, 1_000_001, crypto, 'mdm-1')).toMatchObject({ editable: false, reason: 'scope_invalid' }) }
  })

  test('cross-tab stale revision cannot overwrite or half-write another writer', async () => {
    const user = `tabs-${Date.now()}`; const a = new IndexedDbOfflineDatabase(user, indexedDB); const b = new IndexedDbOfflineDatabase(user, indexedDB); const initial = await installed(a, user)
    await a.saveDraftAtomic!(initial, 0, { scope: 'row', sampleSlotId: '00000000-0000-4000-8000-000000000001', field: 'point', value: 'A点', savedAt: '2026-08-16T08:01:00.000Z', wallTime: 1_060_000 })
    const latest: any = (await b.snapshot()).drafts[0]
    await expect(b.saveDraftAtomic!(latest, 0, { scope: 'row', sampleSlotId: '00000000-0000-4000-8000-000000000001', field: 'point', baseValue: '', value: 'B覆盖', savedAt: '2026-08-16T08:02:00.000Z', wallTime: 1_120_000 })).rejects.toThrow('DRAFT_FIELD_CONFLICT')
    expect(((await a.snapshot()).drafts[0].payload.rows as any[])[0]).toMatchObject({ point: 'A点', note: '' })
  })

  test('a stale different-field command safely rebases while same-field stale input conflicts', async () => {
    const user = `field-cas-${Date.now()}`, db = new IndexedDbOfflineDatabase(user, indexedDB), initial = await installed(db, user)
    await db.saveDraftAtomic(initial, 0, { scope: 'row', sampleSlotId: '00000000-0000-4000-8000-000000000001', field: 'point', baseValue: '', value: 'A点', savedAt: '2026-08-16T08:01:00Z', wallTime: 1_050_000 })
    const latest: any = (await db.snapshot()).drafts[0]
    const rebased: any = await db.saveDraftAtomic(latest, 0, { scope: 'row', sampleSlotId: '00000000-0000-4000-8000-000000000001', field: 'note', baseValue: '', value: '保留', savedAt: '2026-08-16T08:02:00Z', wallTime: 1_060_000 })
    expect(rebased.payload.rows[0]).toMatchObject({ point: 'A点', note: '保留' })
  })

  test('package scope rejects undeclared fields, frozen samplingDate and foreign sample slots', async () => {
    const user = `scope-${Date.now()}`; const db = new IndexedDbOfflineDatabase(user, indexedDB); const initial = await installed(db, user)
    for (const command of [
      { scope: 'global' as const, field: 'adminFlag', value: true },
      { scope: 'global' as const, field: 'samplingDate', value: '2099-01-01' },
      { scope: 'row' as const, sampleSlotId: 'FOREIGN', field: 'point', value: '越权' },
    ]) await expect(db.saveDraftAtomic!(initial, 0, { ...command, savedAt: '2026-08-16T08:01:00Z', wallTime: 1_060_000 })).rejects.toThrow(/DRAFT_(FIELD|SAMPLE_SLOT)_MISMATCH/)
    expect((await db.snapshot()).drafts[0].payload.draftRevision).toBe(0)
  })

  test('a persisted terminal draft remains readonly after reopen and cannot be edited with its old package', async () => {
    const user = `terminal-${Date.now()}`; const db = new IndexedDbOfflineDatabase(user, indexedDB); const initial = await installed(db, user)
    await db.denyDraftAuthority(initial, 'revoked'); const terminal = await db.setDraftTerminalAtomic(initial, 'revoked', 1_060_000)
    const reopened: any = (await new IndexedDbOfflineDatabase(user, indexedDB).snapshot()).drafts[0]
    expect(reopened.payload.control.terminal).toBe('revoked')
    expect(await verifyFieldTaskDraft(reopened, keys.publicKey, 1_060_001, crypto, 'mdm-1')).toMatchObject({ editable: false })
    await expect(db.saveDraftAtomic(terminal, 1, { scope: 'row', sampleSlotId: '00000000-0000-4000-8000-000000000001', field: 'note', value: '旧包复活', savedAt: '2026-08-16T08:02:00Z', wallTime: 1_060_001 })).rejects.toThrow(/DRAFT_(TERMINAL|AUTHORITY_INVALID)/)
  })

  test('terminal persistence refuses to mint DENY on its own', async () => {
    const user = `terminal-no-deny-${Date.now()}`, db = new IndexedDbOfflineDatabase(user, indexedDB), initial = await installed(db, user)
    await expect(db.persistDraftTerminal(initial.id, 'revoked', 1_060_000)).rejects.toThrow('DRAFT_CONTROL_INVALID')
  })

  test('terminal persistence rereads a newer writer revision instead of losing revocation', async () => {
    const user = `terminal-race-${Date.now()}`; const db = new IndexedDbOfflineDatabase(user, indexedDB); const initial = await installed(db, user)
    await db.saveDraftAtomic(initial, 0, { scope: 'row', sampleSlotId: '00000000-0000-4000-8000-000000000001', field: 'note', value: '并发输入', savedAt: '2026-08-16T08:01:00Z', wallTime: 1_050_000 })
    await db.denyDraftAuthority(initial, 'revoked'); const terminal: any = await db.persistDraftTerminal(initial.id, 'revoked', 1_060_000)
    expect(terminal.payload.control.terminal).toBe('revoked')
    expect(terminal.payload.rows[0].note).toBe('并发输入')
    expect(((await new IndexedDbOfflineDatabase(user, indexedDB).snapshot()).drafts[0].payload.control as any).terminal).toBe('revoked')
  })

  test('ordinary renewal cannot clear terminal and explicit replacement requires a higher task version', async () => {
    const user = `replace-${Date.now()}`, db = new IndexedDbOfflineDatabase(user, indexedDB), initial = await installed(db, user)
    await db.denyDraftAuthority(initial, 'logout'); const terminal: any = await db.setDraftTerminalAtomic(initial, 'logout', 1_050_000)
    await expect(db.renewDraftAtomic(terminal, 1, pkg(user))).rejects.toThrow(/DRAFT_(TERMINAL_RENEWAL_FORBIDDEN|TRUST_INVALID)/)
    const resigned = pkg(user, 'ROUND-1@v2')
    await expect(db.renewDraftAtomic(terminal, 1, resigned)).rejects.toThrow(/DRAFT_(TERMINAL_RENEWAL_FORBIDDEN|TRUST_INVALID)/)
    const rebuilt=await db.rebuildConflictedDraftAtomic(terminal,resigned)
    expect(rebuilt.archived.id).toContain(':conflict:1:')
    expect((rebuilt.archived as any).payload.control.terminal).toBe('conflict')
    expect((rebuilt.replacement as any).payload.package.signedPayload.taskVersionOrdinal).toBe(2)
    expect((await db.draftWriteStatus(rebuilt.replacement as any)).allowed).toBe(true)
    expect((await db.snapshot()).drafts).toHaveLength(2)
  })

  test('A/B isolation, install-once and task renewal conflicts retain local data', async () => {
    const a = new IndexedDbOfflineDatabase('iso-a', indexedDB), b = new IndexedDbOfflineDatabase('iso-b', indexedDB)
    const initial = await installed(a, 'iso-a'); await expect(a.installDraftAtomic!(pkg('iso-a'))).rejects.toThrow(/DRAFT_INSTALL_AUTHORITY_EXISTS|DRAFT_ALREADY_INSTALLED/)
    expect((await b.snapshot()).drafts).toHaveLength(0)
    expect(reconcileTaskDraft(initial, pkg('iso-b'))).toMatchObject({ editable: false, reason: 'assignment_changed' })
    expect(reconcileTaskDraft(initial, pkg('iso-a', 'ROUND-1@v2'))).toMatchObject({ editable: false, reason: 'task_version_changed' })
    initial.payload.rows[0].note = '不得丢失'
    const renewed = renewTaskAuthorization(initial, pkg('iso-a'), 2_000_000)
    expect(renewed.payload.rows[0].note).toBe('不得丢失')
    expect(renewed.payload.clock.wallTimeAtTrust).toBe(2_000_000)
    expect((await a.snapshot()).drafts).toHaveLength(1)
  })

  test('renewal is monotonic, device-binding stable, and stale concurrent responses lose revision CAS', async () => {
    const user = `renew-${Date.now()}`; const db = new IndexedDbOfflineDatabase(user, indexedDB); const initial = await installed(db, user)
    const newer = pkg(user); newer.signedPayload.authorization = { ...newer.signedPayload.authorization, nonce: 'new', issuedAt: '2026-08-16T09:00:00.000Z', serverTime: '2026-08-16T09:00:00.000Z', expiresAt: '2026-08-17T09:00:00.000Z' }
    newer.signature = sign('sha256', Buffer.from(JSON.stringify(newer.signedPayload)), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    expect(renewalValid(initial, newer)).toBe(true)
    const rebound = structuredClone(newer); rebound.signedPayload.deviceBindingFingerprint = '0'.repeat(64)
    expect(renewalValid(initial, rebound)).toBe(false)
    const renewed = renewTaskAuthorization(initial, newer, 2_000_000)
    const stored = await db.renewDraftAtomic(initial, 0, newer)
    await expect(db.renewDraftAtomic(initial, 0, newer)).rejects.toThrow(/DRAFT_(REVISION_CONFLICT|TRUST_INVALID)/)
    expect(stored.payload.draftRevision).toBe(1)
  })

  test('trusted wall clock checkpoint advances in a sealed revision transaction', async () => {
    const user = `clock-${Date.now()}`; const db = new IndexedDbOfflineDatabase(user, indexedDB); const initial = await installed(db, user)
    const checkpoint: any = await db.checkpointDraftClockAtomic(initial, 0, 1_060_000)
    expect(checkpoint.payload.clock.lastWallTime).toBeGreaterThanOrEqual(initial.payload.clock.lastWallTime)
    expect(checkpoint.payload.control.lastWallTime).toBe(checkpoint.payload.clock.lastWallTime)
    expect(checkpoint.payload.draftRevision).toBe(1)
    await expect(db.checkpointDraftClockAtomic(initial, 0, 1_060_001)).rejects.toThrow('DRAFT_REVISION_CONFLICT')
  })

  test('process-style reopen recovery remains below automated 5 second threshold', async () => {
    const user = `restore-${Date.now()}`; const db = new IndexedDbOfflineDatabase(user, indexedDB); await installed(db, user)
    const started = performance.now(); const reopened = new IndexedDbOfflineDatabase(user, indexedDB); expect((await reopened.snapshot()).drafts).toHaveLength(1); expect(performance.now() - started).toBeLessThan(5000)
  })
})

export { keys, pkg }
