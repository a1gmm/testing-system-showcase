import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { expect, test, vi } from 'vitest'
import { createFieldTaskDraft, type OfflineTaskPackage } from '../src/offline/fieldTaskDraft'
import 'fake-indexeddb/auto'

Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, callback: () => unknown) => callback() } })

function signed(keys: ReturnType<typeof generateKeyPairSync>, version: string): OfflineTaskPackage {
  const signedPayload: OfflineTaskPackage['signedPayload'] = { schemaVersion: 1, roundId: 'ROUND-ONLINE', assigneeId: 'user-a', deviceId: 'mdm-1', deviceBindingPublicKeySpki: keys.publicKey as string, deviceBindingFingerprint: createHash('sha256').update(createPublicKey(keys.publicKey as string).export({ type: 'spki', format: 'der' })).digest('hex'), formCode: 'HJ-TC-136', ruleVersion: 'HJ-TC-136@provisional-v1', taskVersion: version, taskVersionOrdinal: version.includes('v2') ? 2 : 1, samplingDate: '2026-08-16', sampleSlots: [{ sampleSlotId: '00000000-0000-4000-8000-000000000001', temporaryId:'00000000-0000-4000-8000-000000000101', qrPayload:'TC1:00000000-0000-4000-8000-000000000101', matrix: '废水', items: ['COD'] }], formSchema: { globalFields: ['org', 'orgSign', 'samplingDate'], rowFields: ['sampleSlotId', 'sampleNo', 'point', 'time', 'item', 'volume', 'preserve', 'waterColor', 'smell', 'oil', 'floating', 'anomaly', 'note'] }, authorization: { scope: 'field-draft-write', deviceId: 'mdm-1', attestationId: 'att', nonce: version, issuedAt: '2026-08-16T08:00:00.000Z', serverTime: '2026-08-16T08:00:00.000Z', expiresAt: '2099-08-17T08:00:00.000Z' } }
  return { signedPayload, signature: sign('sha256', Buffer.from(JSON.stringify(signedPayload)), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') }
}

test('authenticated online refresh detects task version conflict and keeps the existing draft readonly', async () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  const local = createFieldTaskDraft(signed(keys, 'v1'), Date.now()); local.payload.rows[0].note = '现场不能丢'; let stored: any = local
  const getPackage = vi.fn(async () => signed(keys, 'v2')); const renew = vi.fn()
  const persistTerminal = vi.fn(async (_id: string, terminal: string) => { stored = { ...stored, payload: { ...stored.payload, draftRevision: stored.payload.draftRevision + 1, control: { terminal } } }; return stored })
  vi.stubEnv('VITE_OFFLINE_PACKAGE_PUBLIC_KEY', keys.publicKey.replace(/\n/g, '\\n'))
  vi.doMock('../src/api', () => ({ api: { getOfflineTaskPackage: getPackage }, currentUser: ref({ username: 'user-a' }) }))
  vi.doMock('../src/offline/recoveryIdentity', () => ({ verifyStoredRecoveryCredential: async () => null }))
  vi.doMock('../src/offline/managedDevice', () => ({ proveManagedDevicePossession: async () => true }))
  vi.doMock('../src/offline/indexedDb', () => ({ createIndexedDbOfflineDatabase: () => ({ snapshot: async () => ({ schemaVersion: 1, drafts: [stored] }), draftWriteStatus: async () => ({ allowed: true }), denyDraftAuthority: async () => {}, renewDraftAtomic: renew, persistDraftTerminal: persistTerminal }) }))
  vi.doMock('vue-router', () => ({ useRoute: () => ({ params: { id: 'ROUND-ONLINE' } }) }))
  const FieldTask = (await import('../src/pages/FieldTask.vue')).default; const wrapper = mount(FieldTask)
  await vi.waitFor(() => expect(wrapper.text()).toContain('任务版本已更新'))
  expect(wrapper.text()).toContain('草稿仍保留在本机')
  expect(wrapper.text()).toContain('00000000-0000-4000-8000-000000000001')
  expect(renew).not.toHaveBeenCalled()
  expect(persistTerminal).toHaveBeenCalledOnce()
  expect(stored.payload.control.terminal).toBe('conflict')
  wrapper.unmount()
})
