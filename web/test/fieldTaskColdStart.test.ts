import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { mount } from '@vue/test-utils'
import { afterEach, expect, test, vi } from 'vitest'
import { createFieldTaskDraft, type OfflineTaskPackage } from '../src/offline/fieldTaskDraft'
import 'fake-indexeddb/auto'

Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, callback: () => unknown) => callback() } })

afterEach(() => { vi.doUnmock('../src/api'); vi.doUnmock('../src/offline/indexedDb'); vi.doUnmock('../src/offline/recoveryIdentity'); vi.doUnmock('../src/offline/managedDevice'); vi.doUnmock('vue-router'); vi.unstubAllEnvs() })

test('offline cold start with currentUser null writes only through the verified local package and makes no API call', async () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  const signedPayload: OfflineTaskPackage['signedPayload'] = {
    schemaVersion: 1, roundId: 'ROUND-COLD', assigneeId: 'cold-user', deviceId: 'mdm-1', deviceBindingPublicKeySpki: keys.publicKey, deviceBindingFingerprint: createHash('sha256').update(createPublicKey(keys.publicKey).export({ type: 'spki', format: 'der' })).digest('hex'), formCode: 'HJ-TC-136', ruleVersion: 'HJ-TC-136@provisional-v1', taskVersion: 'v1', taskVersionOrdinal: 1, samplingDate: '2026-08-16',
    sampleSlots: [{ sampleSlotId: '00000000-0000-4000-8000-000000000001', temporaryId:'00000000-0000-4000-8000-000000000101', qrPayload:'TC1:00000000-0000-4000-8000-000000000101', matrix: '废水', items: ['COD'] }],
    formSchema: { globalFields: ['org', 'orgSign', 'samplingDate'], rowFields: ['sampleSlotId', 'sampleNo', 'point', 'time', 'item', 'volume', 'preserve', 'waterColor', 'smell', 'oil', 'floating', 'anomaly', 'note'] },
    authorization: { scope: 'field-draft-write', deviceId: 'mdm-1', attestationId: 'att', nonce: 'n', issuedAt: '2026-08-16T08:00:00.000Z', serverTime: '2026-08-16T08:00:00.000Z', expiresAt: '2099-08-17T08:00:00.000Z' },
  }
  const pkg = { signedPayload, signature: sign('sha256', Buffer.from(JSON.stringify(signedPayload)), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') }
  const local: any = createFieldTaskDraft(pkg, Date.now()); local.payload.control = { terminal: 'active' }
  const getPackage = vi.fn()
  const save = vi.fn(async (_draft, _revision, command) => ({ ...local, payload: { ...local.payload, draftRevision: 1, rows: [{ ...local.payload.rows[0], [command.field]: command.value }], localSavedAt: command.savedAt } }))
  vi.stubEnv('VITE_OFFLINE_PACKAGE_PUBLIC_KEY', keys.publicKey.replace(/\n/g, '\\n'))
  const { ref } = await import('vue'); vi.doMock('../src/api', async () => ({ api: { getOfflineTaskPackage: getPackage }, currentUser: ref(null) }))
  vi.doMock('../src/offline/recoveryIdentity', () => ({ verifyStoredRecoveryCredential: async () => 'cold-user' }))
  vi.doMock('../src/offline/managedDevice', () => ({ proveManagedDevicePossession: async () => true }))
  vi.doMock('../src/offline/indexedDb', () => ({ createIndexedDbOfflineDatabase: () => ({ snapshot: async () => ({ schemaVersion: 1, drafts: [local] }), draftWriteStatus: async () => ({ allowed: true }), saveDraftAtomic: save }) }))
  vi.doMock('vue-router', () => ({ useRoute: () => ({ params: { id: 'ROUND-COLD' } }) }))
  const FieldTask = (await import('../src/pages/FieldTask.vue')).default
  const wrapper = mount(FieldTask)
  await vi.waitFor(() => expect(wrapper.find('[data-testid="field-workbench"]').exists()).toBe(true))
  await wrapper.get('[data-testid="row-0-point"]').setValue('冷启动点位')
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(getPackage).not.toHaveBeenCalled()
  expect(save.mock.calls[0][2]).toMatchObject({ scope: 'row', sampleSlotId: '00000000-0000-4000-8000-000000000001', field: 'point' })
  wrapper.unmount()
})
