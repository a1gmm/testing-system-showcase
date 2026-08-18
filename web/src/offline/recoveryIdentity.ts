import { ref } from 'vue'

const STORAGE_KEY = 'tc_recovery_credential'
const REVOCATION_SIGNAL_KEY = 'tc_recovery_credential_revoked'
const KEY_DATABASE = 'field-recovery-device-credential-v1'
const KEY_STORE = 'keys'
const KEY_ID = 'hmac-v1'
const LIFECYCLE_LOCK = 'tc-offline-recovery-credential-v1'
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u

export interface RecoveryCredentialKeyStore {
  get(): Promise<CryptoKey | null>
  getOrCreate(create: () => Promise<CryptoKey>): Promise<CryptoKey>
  getBinding(): Promise<RecoveryBinding | null>
  setBinding(binding: RecoveryBinding | null): Promise<void>
  invalidate(): Promise<void>
}

export interface RecoveryBinding { userId: string; nonce: string; issuedAt: number }

interface CredentialDependencies {
  storage?: Storage
  keys?: RecoveryCredentialKeyStore
  crypto?: Crypto
}

interface SignedCredential {
  version: 1
  userId: string
  issuedAt: number
  nonce: string
  signature: string
}

function validUserId(userId: unknown): userId is string {
  return typeof userId === 'string'
    && userId.length > 0
    && [...userId].length <= 128
    && !CONTROL_CHARACTERS.test(userId)
    && !UNPAIRED_SURROGATE.test(userId)
    && userId.normalize('NFC') === userId
}

function availableStorage(): Storage | undefined {
  try { return typeof window !== 'undefined' ? window.localStorage : undefined } catch { return undefined }
}

function availableCrypto(): Crypto | undefined {
  return globalThis.crypto?.subtle ? globalThis.crypto : undefined
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function credentialPayload(value: Omit<SignedCredential, 'signature'>): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify([value.version, value.userId, value.issuedAt, value.nonce])).buffer
}

function parseCredential(raw: string | null): SignedCredential | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    if (value?.version !== 1 || !validUserId(value.userId)) return null
    if (!Number.isSafeInteger(value.issuedAt) || value.issuedAt <= 0) return null
    if (typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value.nonce)) return null
    if (typeof value.signature !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(value.signature)) return null
    return value as SignedCredential
  } catch {
    return null
  }
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('credential key request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('credential transaction aborted'))
    transaction.onerror = () => reject(transaction.error ?? new Error('credential transaction failed'))
  })
}

export class IndexedDbRecoveryCredentialKeyStore implements RecoveryCredentialKeyStore {
  private connection?: Promise<IDBDatabase>
  private readonly factory: IDBFactory

  constructor(factory: IDBFactory) {
    this.factory = factory
  }

  private open(): Promise<IDBDatabase> {
    if (this.connection) return this.connection
    this.connection = new Promise((resolve, reject) => {
      const request = this.factory.open(KEY_DATABASE, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(KEY_STORE)) request.result.createObjectStore(KEY_STORE)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('credential key database unavailable'))
      request.onblocked = () => reject(new Error('credential key database blocked'))
    })
    return this.connection
  }

  async get(): Promise<CryptoKey | null> {
    const database = await this.open()
    const transaction = database.transaction(KEY_STORE, 'readonly')
    const result = await idbRequest(transaction.objectStore(KEY_STORE).get(KEY_ID))
    await transactionDone(transaction)
    return result ?? null
  }

  async getOrCreate(create: () => Promise<CryptoKey>): Promise<CryptoKey> {
    const existing = await this.get()
    if (existing) return existing
    const generated = await create()
    const database = await this.open()
    const transaction = database.transaction(KEY_STORE, 'readwrite')
    const store = transaction.objectStore(KEY_STORE)
    const raced = await idbRequest(store.get(KEY_ID)) as CryptoKey | undefined
    if (!raced) await idbRequest(store.put(generated, KEY_ID))
    await transactionDone(transaction)
    if (raced) return raced
    return generated
  }

  async getBinding(): Promise<RecoveryBinding | null> {
    const database = await this.open()
    const transaction = database.transaction(KEY_STORE, 'readonly')
    const result = await idbRequest(transaction.objectStore(KEY_STORE).get('binding-v1'))
    await transactionDone(transaction)
    return (result as RecoveryBinding | undefined) ?? null
  }

  async setBinding(binding: RecoveryBinding | null): Promise<void> {
    const database = await this.open()
    const transaction = database.transaction(KEY_STORE, 'readwrite')
    const store = transaction.objectStore(KEY_STORE)
    if (binding) await idbRequest(store.put(binding, 'binding-v1'))
    else await idbRequest(store.delete('binding-v1'))
    await transactionDone(transaction)
  }

  async invalidate(): Promise<void> {
    const database = await this.open()
    const transaction = database.transaction(KEY_STORE, 'readwrite')
    const store = transaction.objectStore(KEY_STORE)
    await Promise.all([idbRequest(store.delete(KEY_ID)), idbRequest(store.delete('binding-v1'))])
    await transactionDone(transaction)
  }
}

function resolveDependencies(input: CredentialDependencies = {}) {
  const storage = 'storage' in input ? input.storage : availableStorage()
  const crypto = 'crypto' in input ? input.crypto : availableCrypto()
  const factory = globalThis.indexedDB
  const keys = 'keys' in input ? input.keys : (factory ? new IndexedDbRecoveryCredentialKeyStore(factory) : undefined)
  return { storage, crypto, keys }
}

export const recoveryIdentityHint = ref<string | null>(null)
let issuanceQueue: Promise<void> = Promise.resolve()
let revocationFailed = false

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const result = issuanceQueue.catch(() => undefined).then(task)
  issuanceQueue = result.then(() => undefined, () => undefined)
  return result
}

type LifecycleLocks = { request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T> }

function availableLifecycleLocks(): LifecycleLocks | undefined {
  try { return typeof navigator !== 'undefined' ? navigator.locks as LifecycleLocks | undefined : undefined } catch { return undefined }
}

async function revokeNow(storage: Storage | undefined, keys: RecoveryCredentialKeyStore | undefined): Promise<void> {
  recoveryIdentityHint.value = null
  try { storage?.removeItem(STORAGE_KEY) } catch { /* binding revocation must still run */ }
  if (!keys) { revocationFailed = true; notifyRevocation(storage); return }
  try { await keys.setBinding(null); revocationFailed = false } catch {
    revocationFailed = true
    try { await keys.invalidate(); revocationFailed = false } catch { /* persistent storage unavailable: remain fail closed */ }
  }
  notifyRevocation(storage)
}

function notifyRevocation(storage: Storage | undefined): void {
  try {
    storage?.setItem(REVOCATION_SIGNAL_KEY, `${Date.now()}-${Math.random()}`)
    storage?.removeItem(REVOCATION_SIGNAL_KEY)
  } catch { /* cross-tab hint notification is best effort; binding remains authoritative */ }
}

export async function issueAuthenticatedRecoveryCredential(userId: string, input: CredentialDependencies = {}): Promise<boolean> {
  const { storage, crypto, keys } = resolveDependencies(input)
  return serialized(async () => {
    const locks = availableLifecycleLocks()
    if (!locks) { await revokeNow(storage, keys); return false }
    return locks.request(LIFECYCLE_LOCK, { mode: 'exclusive' }, async () => { try {
    await revokeNow(storage, keys)
    if (!validUserId(userId) || !storage || !crypto?.subtle || !keys || revocationFailed) return false
    const key = await keys.getOrCreate(() => crypto.subtle.generateKey(
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    ) as Promise<CryptoKey>)
    const unsigned = {
      version: 1 as const,
      userId,
      issuedAt: Date.now(),
      nonce: encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    }
    const signature = await crypto.subtle.sign('HMAC', key, credentialPayload(unsigned))
    await keys.setBinding({ userId: unsigned.userId, nonce: unsigned.nonce, issuedAt: unsigned.issuedAt })
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ ...unsigned, signature: encodeBase64Url(new Uint8Array(signature)) }))
    } catch {
      try { await keys.setBinding(null) } catch { try { await keys.invalidate() } catch { revocationFailed = true } }
      return false
    }
    recoveryIdentityHint.value = userId
    return true
  } catch {
    recoveryIdentityHint.value = null
    return false
  } }) })
}

async function verifyStoredRecoveryCredentialNow(input: CredentialDependencies = {}): Promise<string | null> {
  const { storage, crypto, keys } = resolveDependencies(input)
  if (revocationFailed || !storage || !crypto?.subtle || !keys) return null
  const credential = parseCredential(storage.getItem(STORAGE_KEY))
  if (!credential) return null
  try {
    const key = await keys.get()
    if (!key) return null
    const signature = Uint8Array.from(atob(credential.signature.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))
    if (encodeBase64Url(signature) !== credential.signature) return null
    const binding = await keys.getBinding()
    if (!binding || binding.userId !== credential.userId || binding.nonce !== credential.nonce || binding.issuedAt !== credential.issuedAt) return null
    const valid = await crypto.subtle.verify('HMAC', key, signature.buffer as ArrayBuffer, credentialPayload({
      version: credential.version,
      userId: credential.userId,
      issuedAt: credential.issuedAt,
      nonce: credential.nonce,
    }))
    return valid ? credential.userId : null
  } catch {
    return null
  }
}

export function verifyStoredRecoveryCredential(input: CredentialDependencies = {}): Promise<string | null> {
  return serialized(() => {
    const locks = availableLifecycleLocks()
    return locks ? locks.request(LIFECYCLE_LOCK, { mode: 'exclusive' }, () => verifyStoredRecoveryCredentialNow(input)) : Promise.resolve(null)
  })
}

export async function hydrateRecoveryIdentity(input: CredentialDependencies = {}): Promise<void> {
  await serialized(async () => {
    const locks = availableLifecycleLocks()
    if (!locks) { recoveryIdentityHint.value = null; return }
    await locks.request(LIFECYCLE_LOCK, { mode: 'exclusive' }, async () => {
      recoveryIdentityHint.value = await verifyStoredRecoveryCredentialNow(input)
    })
  })
}

export async function clearRecoveryIdentity(
  storage: Storage | undefined = availableStorage(),
  providedKeys?: RecoveryCredentialKeyStore,
): Promise<void> {
  const keys = providedKeys ?? resolveDependencies({ storage }).keys
  recoveryIdentityHint.value = null
  try { storage?.removeItem(STORAGE_KEY) } catch { /* continue with device revocation */ }
  await serialized(async () => {
    const locks = availableLifecycleLocks()
    if (locks) await locks.request(LIFECYCLE_LOCK, { mode: 'exclusive' }, () => revokeNow(storage, keys))
    else await revokeNow(storage, keys)
  }).catch(() => { revocationFailed = true })
}

if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
  if ((event.key === STORAGE_KEY && event.newValue === null) || event.key === REVOCATION_SIGNAL_KEY) recoveryIdentityHint.value = null
})

export function resolveRecoveryNamespace(
  authenticatedUser: { username: string } | null,
  verifiedRecoveryUserId: string | null,
): { userId: string | null; recoveryOnly: boolean } {
  if (authenticatedUser && validUserId(authenticatedUser.username)) return { userId: authenticatedUser.username, recoveryOnly: false }
  return { userId: verifiedRecoveryUserId && validUserId(verifiedRecoveryUserId) ? verifiedRecoveryUserId : null, recoveryOnly: true }
}
