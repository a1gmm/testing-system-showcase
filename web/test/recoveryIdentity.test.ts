import { webcrypto } from 'node:crypto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, test } from 'vitest'

import {
  clearRecoveryIdentity,
  hydrateRecoveryIdentity,
  IndexedDbRecoveryCredentialKeyStore,
  issueAuthenticatedRecoveryCredential,
  recoveryIdentityHint,
  resolveRecoveryNamespace,
  verifyStoredRecoveryCredential,
  type RecoveryCredentialKeyStore,
} from '../src/offline/recoveryIdentity'

class MemoryKeyStore implements RecoveryCredentialKeyStore {
  key: CryptoKey | null = null
  binding: { userId: string; nonce: string; issuedAt: number } | null = null
  async get() { return this.key }
  async getOrCreate(create: () => Promise<CryptoKey>) { return this.key ?? (this.key = await create()) }
  async getBinding() { return this.binding }
  async setBinding(binding: { userId: string; nonce: string; issuedAt: number } | null) { this.binding = binding }
  async invalidate() { this.binding = null; this.key = null }
}

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    clear: () => values.clear(), getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key), setItem: (key: string, value: string) => values.set(key, value),
  } as Storage
}

const cryptoApi = webcrypto as unknown as Crypto

describe('device-bound recovery credential', () => {
  let storage: Storage
  let keys: MemoryKeyStore
  beforeEach(() => {
    storage = memoryStorage()
    keys = new MemoryKeyStore()
    recoveryIdentityHint.value = null
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: async (_name: string, _options: object, callback: () => unknown) => callback(),
    } })
  })

  test('online authentication signs a Unicode username and cold start verifies it for read-only recovery', async () => {
    await issueAuthenticatedRecoveryCredential('张 三', { storage, keys, crypto: cryptoApi })
    recoveryIdentityHint.value = null

    await hydrateRecoveryIdentity({ storage, keys, crypto: cryptoApi })

    expect(recoveryIdentityHint.value).toBe('张 三')
    expect(resolveRecoveryNamespace(null, recoveryIdentityHint.value)).toEqual({ userId: '张 三', recoveryOnly: true })
  })

  test.each(['userId', 'signature', 'nonce'] as const)('tampering %s fails closed', async (field) => {
    await issueAuthenticatedRecoveryCredential('user-a', { storage, keys, crypto: cryptoApi })
    const credential = JSON.parse(storage.getItem('tc_recovery_credential')!)
    credential[field] = field === 'userId' ? 'user-b' : `${credential[field]}tampered`
    storage.setItem('tc_recovery_credential', JSON.stringify(credential))

    await expect(verifyStoredRecoveryCredential({ storage, keys, crypto: cryptoApi })).resolves.toBeNull()
  })

  test('a previously valid archived credential cannot be replayed after replacement or logout', async () => {
    await issueAuthenticatedRecoveryCredential('user-a', { storage, keys, crypto: cryptoApi })
    const archived = storage.getItem('tc_recovery_credential')!
    await issueAuthenticatedRecoveryCredential('user-b', { storage, keys, crypto: cryptoApi })
    storage.setItem('tc_recovery_credential', archived)
    await expect(verifyStoredRecoveryCredential({ storage, keys, crypto: cryptoApi })).resolves.toBeNull()
    await clearRecoveryIdentity(storage, keys)
    storage.setItem('tc_recovery_credential', archived)
    await expect(verifyStoredRecoveryCredential({ storage, keys, crypto: cryptoApi })).resolves.toBeNull()
  })

  test('failed A to B replacement revokes A before attempting B issuance', async () => {
    await issueAuthenticatedRecoveryCredential('user-a', { storage, keys, crypto: cryptoApi })
    const failingCrypto = { subtle: cryptoApi.subtle, getRandomValues: () => { throw new Error('failed') } } as Crypto
    await expect(issueAuthenticatedRecoveryCredential('user-b', { storage, keys, crypto: failingCrypto })).resolves.toBe(false)
    await expect(verifyStoredRecoveryCredential({ storage, keys, crypto: cryptoApi })).resolves.toBeNull()
  })

  test('concurrent issuance leaves only the last credential current', async () => {
    await Promise.all([
      issueAuthenticatedRecoveryCredential('user-a', { storage, keys, crypto: cryptoApi }),
      issueAuthenticatedRecoveryCredential('user-b', { storage, keys, crypto: cryptoApi }),
    ])
    await expect(verifyStoredRecoveryCredential({ storage, keys, crypto: cryptoApi })).resolves.toBe('user-b')
  })

  test('logout ordered during a slow issuance wins and leaves no recovery state', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const slowCrypto = {
      getRandomValues: cryptoApi.getRandomValues.bind(cryptoApi),
      subtle: { ...cryptoApi.subtle, generateKey: cryptoApi.subtle.generateKey.bind(cryptoApi.subtle), sign: async (...args: Parameters<SubtleCrypto['sign']>) => { await gate; return cryptoApi.subtle.sign(...args) } },
    } as unknown as Crypto
    const issuing = issueAuthenticatedRecoveryCredential('user-a', { storage, keys, crypto: slowCrypto })
    const clearing = clearRecoveryIdentity(storage, keys)
    release()
    await Promise.all([issuing, clearing])
    expect(storage.getItem('tc_recovery_credential')).toBeNull()
    expect(keys.binding).toBeNull()
    expect(recoveryIdentityHint.value).toBeNull()
  })

  test('logout queued behind a pending hydrate prevents stale identity refill', async () => {
    await issueAuthenticatedRecoveryCredential('user-a', { storage, keys, crypto: cryptoApi })
    recoveryIdentityHint.value = null
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const originalGetBinding = keys.getBinding.bind(keys)
    keys.getBinding = async () => { await gate; return originalGetBinding() }
    const hydrating = hydrateRecoveryIdentity({ storage, keys, crypto: cryptoApi })
    const clearing = clearRecoveryIdentity(storage, keys)
    release()
    await Promise.all([hydrating, clearing])
    expect(recoveryIdentityHint.value).toBeNull()
    expect(keys.binding).toBeNull()
  })

  test('non-canonical base64url signature tail is rejected', async () => {
    await issueAuthenticatedRecoveryCredential('user-a', { storage, keys, crypto: cryptoApi })
    const credential = JSON.parse(storage.getItem('tc_recovery_credential')!)
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const index = alphabet.indexOf(credential.signature.at(-1))
    credential.signature = credential.signature.slice(0, -1) + alphabet[(index & 60) | ((index + 1) & 3)]
    storage.setItem('tc_recovery_credential', JSON.stringify(credential))
    await expect(verifyStoredRecoveryCredential({ storage, keys, crypto: cryptoApi })).resolves.toBeNull()
  })

  test('a copied credential without the originating device key is rejected', async () => {
    await issueAuthenticatedRecoveryCredential('user-a', { storage, keys, crypto: cryptoApi })
    const copiedStorage = memoryStorage()
    copiedStorage.setItem('tc_recovery_credential', storage.getItem('tc_recovery_credential')!)

    await expect(verifyStoredRecoveryCredential({ storage: copiedStorage, keys: new MemoryKeyStore(), crypto: cryptoApi })).resolves.toBeNull()
  })

  test('the device key persists in IndexedDB without becoming extractable', async () => {
    const factory = new IDBFactory()
    const first = new IndexedDbRecoveryCredentialKeyStore(factory)
    await issueAuthenticatedRecoveryCredential('张 三', { storage, keys: first, crypto: cryptoApi })

    expect((await first.get())?.extractable).toBe(false)
    const reopened = new IndexedDbRecoveryCredentialKeyStore(factory)
    await expect(verifyStoredRecoveryCredential({ storage, keys: reopened, crypto: cryptoApi })).resolves.toBe('张 三')
  })

  test('a late binding transaction abort never publishes a verifiable credential', async () => {
    class AbortingStore extends MemoryKeyStore {
      calls = 0
      override async setBinding(binding: { userId: string; nonce: string; issuedAt: number } | null) {
        this.calls += 1
        if (this.calls === 2) throw new Error('late transaction abort')
        await super.setBinding(binding)
      }
    }
    const aborting = new AbortingStore()
    await expect(issueAuthenticatedRecoveryCredential('user-a', { storage, keys: aborting, crypto: cryptoApi })).resolves.toBe(false)
    expect(storage.getItem('tc_recovery_credential')).toBeNull()
    await expect(verifyStoredRecoveryCredential({ storage, keys: aborting, crypto: cryptoApi })).resolves.toBeNull()
  })

  test('local credential publication failure rolls back the committed binding', async () => {
    const failingStorage = memoryStorage()
    failingStorage.setItem = () => { throw new Error('quota') }
    await expect(issueAuthenticatedRecoveryCredential('user-a', { storage: failingStorage, keys, crypto: cryptoApi })).resolves.toBe(false)
    expect(keys.binding).toBeNull()
  })

  test('logout is no-throw and invalidates the key when binding revocation fails', async () => {
    await issueAuthenticatedRecoveryCredential('user-a', { storage, keys, crypto: cryptoApi })
    keys.setBinding = async () => { throw new Error('late abort') }
    await expect(clearRecoveryIdentity(storage, keys)).resolves.toBeUndefined()
    expect(keys.key).toBeNull()
    expect(recoveryIdentityHint.value).toBeNull()
  })

  test('crypto or key storage unavailable never falls back to unsigned identity', async () => {
    await expect(verifyStoredRecoveryCredential({ storage, keys, crypto: undefined })).resolves.toBeNull()
    await expect(issueAuthenticatedRecoveryCredential('user-a', { storage, keys, crypto: undefined })).resolves.toBe(false)
    expect(storage.getItem('tc_recovery_credential')).toBeNull()
  })

  test('Web Locks unavailable disables issue and hydrate while clear remains no-throw', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
    await expect(issueAuthenticatedRecoveryCredential('user-a', { storage, keys, crypto: cryptoApi })).resolves.toBe(false)
    await expect(hydrateRecoveryIdentity({ storage, keys, crypto: cryptoApi })).resolves.toBeUndefined()
    expect(recoveryIdentityHint.value).toBeNull()
    await expect(clearRecoveryIdentity(storage, keys)).resolves.toBeUndefined()
  })

  test('control characters and non-normalized usernames fail closed without silently rewriting identity', async () => {
    await expect(issueAuthenticatedRecoveryCredential('user\nadmin', { storage, keys, crypto: cryptoApi })).resolves.toBe(false)
    await expect(issueAuthenticatedRecoveryCredential('e\u0301', { storage, keys, crypto: cryptoApi })).resolves.toBe(false)
    await expect(issueAuthenticatedRecoveryCredential('\uD800', { storage, keys, crypto: cryptoApi })).resolves.toBe(false)
    await expect(issueAuthenticatedRecoveryCredential('\uD801', { storage, keys, crypto: cryptoApi })).resolves.toBe(false)
    expect(storage.getItem('tc_recovery_credential')).toBeNull()
  })

  test('valid emoji, replacement character, Chinese and spaces remain distinct valid identities', async () => {
    await expect(issueAuthenticatedRecoveryCredential('😀 张', { storage, keys, crypto: cryptoApi })).resolves.toBe(true)
    await expect(verifyStoredRecoveryCredential({ storage, keys, crypto: cryptoApi })).resolves.toBe('😀 张')
    await expect(issueAuthenticatedRecoveryCredential('\uFFFD 张', { storage, keys, crypto: cryptoApi })).resolves.toBe(true)
    await expect(verifyStoredRecoveryCredential({ storage, keys, crypto: cryptoApi })).resolves.toBe('\uFFFD 张')
  })

  test('explicit logout clears the signed credential but does not delete device data or key', async () => {
    await issueAuthenticatedRecoveryCredential('user-a', { storage, keys, crypto: cryptoApi })
    storage.setItem('field-offline-device-data', 'sentinel')

    await clearRecoveryIdentity(storage, keys)

    expect(storage.getItem('tc_recovery_credential')).toBeNull()
    expect(storage.getItem('field-offline-device-data')).toBe('sentinel')
    expect(keys.key).not.toBeNull()
  })
})
