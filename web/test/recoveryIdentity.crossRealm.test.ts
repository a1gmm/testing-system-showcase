import { webcrypto } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'

class SharedKeyStore {
  key: CryptoKey | null = null
  binding: { userId: string; nonce: string; issuedAt: number } | null = null
  async get() { return this.key }
  async getOrCreate(create: () => Promise<CryptoKey>) { return this.key ?? (this.key = await create()) }
  async getBinding() { return this.binding }
  async setBinding(binding: typeof this.binding) { this.binding = binding }
  async invalidate() { this.key = null; this.binding = null }
}

function sharedStorage(): Storage {
  const values = new Map<string, string>()
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      if (!values.has(key)) return
      values.delete(key)
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: null }))
    },
    setItem: (key, value) => { values.set(key, value); window.dispatchEvent(new StorageEvent('storage', { key, newValue: value })) },
  } as Storage
}

function exclusiveLocks() {
  let tail: Promise<unknown> = Promise.resolve()
  return { request: <T>(_name: string, _options: object, callback: () => Promise<T>) => {
    const result = tail.then(callback)
    tail = result.catch(() => undefined)
    return result
  } }
}

describe('cross-realm recovery lifecycle lock', () => {
  test('logout called after a slow issue waits and wins across independent module realms', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: exclusiveLocks() })
    const storage = sharedStorage()
    const keys = new SharedKeyStore()
    vi.resetModules()
    const realmA = await import('../src/offline/recoveryIdentity')
    vi.resetModules()
    const realmB = await import('../src/offline/recoveryIdentity')
    let entered!: () => void
    let release!: () => void
    const enteredSign = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const cryptoApi = webcrypto as unknown as Crypto
    const slowCrypto = {
      getRandomValues: cryptoApi.getRandomValues.bind(cryptoApi),
      subtle: { ...cryptoApi.subtle, generateKey: cryptoApi.subtle.generateKey.bind(cryptoApi.subtle), sign: async (...args: Parameters<SubtleCrypto['sign']>) => { entered(); await gate; return cryptoApi.subtle.sign(...args) } },
    } as unknown as Crypto

    const issue = realmA.issueAuthenticatedRecoveryCredential('user-a', { storage, keys, crypto: slowCrypto })
    await enteredSign
    const logout = realmB.clearRecoveryIdentity(storage, keys)
    release()
    await Promise.all([issue, logout])

    expect(storage.getItem('tc_recovery_credential')).toBeNull()
    expect(keys.binding).toBeNull()
    expect(realmA.recoveryIdentityHint.value).toBeNull()
    expect(realmB.recoveryIdentityHint.value).toBeNull()
  })

  test('an online issue called after completed logout may establish the new current identity', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: exclusiveLocks() })
    const storage = sharedStorage()
    const keys = new SharedKeyStore()
    vi.resetModules()
    const realmA = await import('../src/offline/recoveryIdentity')
    vi.resetModules()
    const realmB = await import('../src/offline/recoveryIdentity')
    await realmA.clearRecoveryIdentity(storage, keys)
    await expect(realmB.issueAuthenticatedRecoveryCredential('user-b', { storage, keys, crypto: webcrypto as unknown as Crypto })).resolves.toBe(true)
    await expect(realmA.verifyStoredRecoveryCredential({ storage, keys, crypto: webcrypto as unknown as Crypto })).resolves.toBe('user-b')
  })

  test('logout queued behind a pending hydrate clears both realm hints after verification finishes', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: exclusiveLocks() })
    const storage = sharedStorage()
    const keys = new SharedKeyStore()
    vi.resetModules()
    const realmA = await import('../src/offline/recoveryIdentity')
    vi.resetModules()
    const realmB = await import('../src/offline/recoveryIdentity')
    const cryptoApi = webcrypto as unknown as Crypto
    await realmA.issueAuthenticatedRecoveryCredential('user-a', { storage, keys, crypto: cryptoApi })
    realmA.recoveryIdentityHint.value = null
    let entered!: () => void
    let release!: () => void
    const enteredRead = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const originalGetBinding = keys.getBinding.bind(keys)
    keys.getBinding = async () => { entered(); await gate; return originalGetBinding() }

    const hydrate = realmA.hydrateRecoveryIdentity({ storage, keys, crypto: cryptoApi })
    await enteredRead
    const logout = realmB.clearRecoveryIdentity(storage, keys)
    release()
    await Promise.all([hydrate, logout])

    expect(storage.getItem('tc_recovery_credential')).toBeNull()
    expect(keys.binding).toBeNull()
    expect(realmA.recoveryIdentityHint.value).toBeNull()
    expect(realmB.recoveryIdentityHint.value).toBeNull()
  })
})
