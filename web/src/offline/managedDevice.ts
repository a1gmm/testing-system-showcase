import type { OfflineTaskPackage } from './fieldTaskDraft'
const DB = 'field-managed-device-binding-v1', STORE = 'binding', KEY = 'p256-v1'
function req<T>(r: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) }) }
function done(tx: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error) }) }
function b64(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).match(/.{1,64}/g)?.join('\n') || '' }
function b64raw(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)) }
export type DeviceSignedRequest = { nonce: string; issuedAt: string; signature: string; taskVersion:string; ruleVersion:string }
export type DeviceRequestFields = { method: string; path: string; actor: string; roundId: string; sampleSlotId?: string; attachmentId?: string; hash?: string; size?: number; mime?: string; bodyHash?: string;contentRevision?:number;taskVersion:string;ruleVersion:string }
export function canonicalDeviceRequest(fields: DeviceRequestFields & { nonce: string; issuedAt: string }) {
  return [fields.method.toUpperCase(), fields.path, fields.actor, fields.roundId, fields.sampleSlotId ?? '', fields.attachmentId ?? '', fields.hash ?? '', String(fields.size ?? ''), fields.mime ?? '', fields.bodyHash ?? '',String(fields.contentRevision??''),fields.taskVersion,fields.ruleVersion, fields.nonce, fields.issuedAt].join('\n')
}
export class ManagedDeviceKeyStore {
  private factory: IDBFactory
  private cryptoApi: Crypto
  constructor(factory: IDBFactory = indexedDB, cryptoApi: Crypto = crypto) { this.factory = factory; this.cryptoApi = cryptoApi }
  private async db() { return new Promise<IDBDatabase>((resolve, reject) => { const o = this.factory.open(DB, 1); o.onupgradeneeded = () => o.result.createObjectStore(STORE); o.onsuccess = () => resolve(o.result); o.onerror = () => reject(o.error) }) }
  async enroll(): Promise<{ publicKeySpki: string; fingerprint: string }> {
    const pair = await this.cryptoApi.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair
    const db = await this.db(), tx = db.transaction(STORE, 'readwrite'); await req(tx.objectStore(STORE).put(pair, KEY)); await done(tx)
    return this.describe(pair.publicKey)
  }
  private async describe(publicKey: CryptoKey) { const der = new Uint8Array(await this.cryptoApi.subtle.exportKey('spki', publicKey)); const digest = new Uint8Array(await this.cryptoApi.subtle.digest('SHA-256', der)); return { publicKeySpki: `-----BEGIN PUBLIC KEY-----\n${b64(der)}\n-----END PUBLIC KEY-----\n`, fingerprint: [...digest].map(x => x.toString(16).padStart(2, '0')).join('') } }
  async prove(expectedPem: string, expectedFingerprint: string, challenge: string): Promise<boolean> {
    try { const db = await this.db(), tx = db.transaction(STORE, 'readonly'), pair = await req(tx.objectStore(STORE).get(KEY)) as CryptoKeyPair | undefined; await done(tx); if (!pair?.privateKey || pair.privateKey.extractable) return false
      const described = await this.describe(pair.publicKey); if (described.publicKeySpki !== expectedPem || described.fingerprint !== expectedFingerprint) return false
      const data = new TextEncoder().encode(challenge), signature = await this.cryptoApi.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, data)
      return this.cryptoApi.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, signature, data)
    } catch { return false }
  }
  async signRequest(expectedPem: string, expectedFingerprint: string, fields: DeviceRequestFields, now = new Date()): Promise<DeviceSignedRequest> {
    const db = await this.db(), tx = db.transaction(STORE, 'readonly'), pair = await req(tx.objectStore(STORE).get(KEY)) as CryptoKeyPair | undefined
    await done(tx)
    if (!pair?.privateKey || pair.privateKey.extractable) throw new Error('MANAGED_DEVICE_KEY_REQUIRED')
    const described = await this.describe(pair.publicKey)
    if (described.publicKeySpki !== expectedPem || described.fingerprint !== expectedFingerprint) throw new Error('MANAGED_DEVICE_KEY_MISMATCH')
    const nonce = crypto.randomUUID(), issuedAt = now.toISOString()
    const canonical = canonicalDeviceRequest({ ...fields, nonce, issuedAt })
    const signature = await this.cryptoApi.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(canonical))
    return { nonce, issuedAt, signature: b64raw(new Uint8Array(signature)), taskVersion:fields.taskVersion, ruleVersion:fields.ruleVersion }
  }
}
export async function proveManagedDevicePossession(pkg: OfflineTaskPackage): Promise<boolean> {
  const p = pkg.signedPayload
  return new ManagedDeviceKeyStore().prove(p.deviceBindingPublicKeySpki, p.deviceBindingFingerprint, `${p.roundId}|${p.authorization.nonce}|${pkg.signature}`)
}
