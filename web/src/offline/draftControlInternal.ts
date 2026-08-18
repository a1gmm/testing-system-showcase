import type { FieldTaskDraft } from './fieldTaskDraft'

const DB_NAME = 'field-draft-control-key-v1'
const STORE = 'keys'
const KEY = 'hmac-sha256-v1'
export type DraftTerminalState = 'active' | 'conflict' | 'revoked' | 'logout' | 'authorization_expired' | 'clock_untrusted' | 'integrity_failure' | 'storage_error' | 'submitted'

export type DraftControlEnvelope = {
  version: 1; roundId: string; ownerId: string; packageSignature: string; taskVersion: string; ruleVersion: string
  revision: number; trustedServerTime: string; wallTimeAtTrust: number; lastWallTime: number; terminal: DraftTerminalState
  business: { global: Record<string, unknown>; rows: FieldTaskDraft['payload']['rows'] }
}
export type DraftAuthorityRecord = {
  version: 2; ownerId: string; roundId: string; state: 'ALLOW' | 'DENY'; packageSignature: string; taskVersion: string
  taskVersionOrdinal: number; assigneeId: string; deviceId: string; ruleVersion: string; updatedAt: string; reason?: DraftTerminalState; seal: string
}

function request<T>(value: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error) }) }
function done(tx: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error) }) }
export function canonicalControl(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalControl).join(',')}]`
  return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonicalControl((value as Record<string, unknown>)[key])}`).join(',')}}`
}

export class DraftControlKeyStore {
  private factory: IDBFactory
  private cryptoApi: Crypto
  constructor(factory: IDBFactory = indexedDB, cryptoApi: Crypto = crypto) { this.factory = factory; this.cryptoApi = cryptoApi }
  private async db() {
    return new Promise<IDBDatabase>((resolve, reject) => { const open = this.factory.open(DB_NAME, 1); open.onupgradeneeded = () => open.result.createObjectStore(STORE); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error) })
  }
  async key(create: boolean): Promise<CryptoKey | null> {
    const db = await this.db(); let tx = db.transaction(STORE, 'readonly'); let key = await request(tx.objectStore(STORE).get(KEY)) as CryptoKey | undefined; await done(tx)
    if (key || !create) return key ?? null
    const locks = globalThis.navigator?.locks
    if (!locks) throw new Error('CONTROL_KEY_LOCK_UNAVAILABLE')
    return locks.request('tc-field-control-key-v1', { mode: 'exclusive' }, async () => {
      tx = db.transaction(STORE, 'readonly'); const winner = await request(tx.objectStore(STORE).get(KEY)) as CryptoKey | undefined; await done(tx)
      if (winner) return winner
      const generated = await this.cryptoApi.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']) as CryptoKey
      tx = db.transaction(STORE, 'readwrite')
      const completion = done(tx)
      try { await request(tx.objectStore(STORE).add(generated, KEY)); await completion; return generated }
      catch { await completion.catch(() => undefined); const read = db.transaction(STORE, 'readonly'); const stored = await request(read.objectStore(STORE).get(KEY)) as CryptoKey | undefined; await done(read); if (!stored) throw new Error('CONTROL_KEY_RACE'); return stored }
    })
  }
  async sign(envelope: unknown): Promise<string> {
    const key = await this.key(true); if (!key) throw new Error('CONTROL_KEY_UNAVAILABLE')
    const signature = new Uint8Array(await this.cryptoApi.subtle.sign('HMAC', key, new TextEncoder().encode(canonicalControl(envelope))))
    return btoa(String.fromCharCode(...signature)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  }
  async verify(envelope: unknown, signature: string): Promise<boolean> {
    const key = await this.key(false); if (!key || !/^[A-Za-z0-9_-]+$/.test(signature)) return false
    try { const bytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); return this.cryptoApi.subtle.verify('HMAC', key, bytes, new TextEncoder().encode(canonicalControl(envelope))) } catch { return false }
  }
  private authorityKey(ownerId: string, roundId: string) { return `authority:${ownerId}:${roundId}` }
  private recordMatches(record: DraftAuthorityRecord, draft: FieldTaskDraft) { const p = draft.payload.package.signedPayload; return record.ownerId === draft.ownerId && record.roundId === p.roundId && record.packageSignature === draft.payload.package.signature && record.taskVersion === p.taskVersion && record.taskVersionOrdinal===p.taskVersionOrdinal && record.assigneeId === p.assigneeId && record.deviceId === p.deviceId && record.ruleVersion === p.ruleVersion }
  private async writeAuthority(draft: FieldTaskDraft, state: 'ALLOW' | 'DENY', reason?: DraftTerminalState, updatedAt = new Date().toISOString(), previous?: FieldTaskDraft): Promise<DraftAuthorityRecord> {
    const p = draft.payload.package.signedPayload
    const envelope = { version: 2 as const, ownerId: draft.ownerId, roundId: p.roundId, state, packageSignature: draft.payload.package.signature,
      taskVersion: p.taskVersion, taskVersionOrdinal:p.taskVersionOrdinal, assigneeId: p.assigneeId, deviceId: p.deviceId, ruleVersion: p.ruleVersion, updatedAt, ...(reason ? { reason } : {}) }
    const record = { ...envelope, seal: await this.sign(envelope) }
    const locks = globalThis.navigator?.locks
    if (!locks) throw new Error('CONTROL_KEY_LOCK_UNAVAILABLE')
    await locks.request(`tc-field-authority:${draft.ownerId}:${p.roundId}`, { mode: 'exclusive' }, async () => {
      const db = await this.db(), authorityKey = this.authorityKey(envelope.ownerId, envelope.roundId), read = db.transaction(STORE, 'readonly')
      const current = await request(read.objectStore(STORE).get(authorityKey)) as DraftAuthorityRecord | undefined; await done(read)
      if (current) { const { seal, ...currentEnvelope } = current; if (!await this.verify(currentEnvelope, seal)) throw new Error('DRAFT_AUTHORITY_INVALID') }
      if (state === 'ALLOW') {
        if (current?.state === 'DENY') throw new Error('DRAFT_AUTHORITY_TERMINAL')
        if (previous ? !current || !this.recordMatches(current, previous) : current && !this.recordMatches(current, draft)) throw new Error('DRAFT_AUTHORITY_CAS_MISMATCH')
      }
      const tx = db.transaction(STORE, 'readwrite'), objectStore = tx.objectStore(STORE), latest = await request(objectStore.get(authorityKey)) as DraftAuthorityRecord | undefined
      if (canonicalControl(latest ?? null) !== canonicalControl(current ?? null)) { tx.abort(); throw new Error('DRAFT_AUTHORITY_CAS_MISMATCH') }
      await request(objectStore.put(record, authorityKey)); await done(tx)
    })
    return record
  }
  async writeAllow(draft: FieldTaskDraft, previous?: FieldTaskDraft, updatedAt?: string) { return this.writeAuthority(draft, 'ALLOW', undefined, updatedAt, previous) }
  async writeDeny(draft: FieldTaskDraft, reason: DraftTerminalState, updatedAt?: string) { return this.writeAuthority(draft, 'DENY', reason, updatedAt) }
  async readAuthority(draft: FieldTaskDraft): Promise<DraftAuthorityRecord | null> {
    const p = draft.payload.package.signedPayload, db = await this.db(), tx = db.transaction(STORE, 'readonly')
    const record = await request(tx.objectStore(STORE).get(this.authorityKey(draft.ownerId, p.roundId))) as DraftAuthorityRecord | undefined; await done(tx)
    if (!record) return null
    const { seal, ...envelope } = record
    return await this.verify(envelope, seal) ? record : { ...record, state: 'DENY', reason: 'integrity_failure' }
  }
  async replaceDeniedWithAllow(previous:FieldTaskDraft,next:FieldTaskDraft){
    const old=previous.payload.package.signedPayload,fresh=next.payload.package.signedPayload
    if(previous.ownerId!==next.ownerId||old.roundId!==fresh.roundId||old.assigneeId!==fresh.assigneeId||old.deviceId!==fresh.deviceId||fresh.taskVersionOrdinal<=old.taskVersionOrdinal)throw new Error('DRAFT_REPLACEMENT_VERSION_INVALID')
    const db=await this.db(),key=this.authorityKey(next.ownerId,fresh.roundId),read=db.transaction(STORE,'readonly'),current=await request(read.objectStore(STORE).get(key)) as DraftAuthorityRecord|undefined;await done(read)
    if(!current){throw new Error('DRAFT_AUTHORITY_MISSING')}const{seal,...envelope}=current;if(!await this.verify(envelope,seal)||current.state!=='DENY'||!this.recordMatches(current,previous))throw new Error('DRAFT_AUTHORITY_INVALID')
    const nextEnvelope={version:2 as const,ownerId:next.ownerId,roundId:fresh.roundId,state:'ALLOW' as const,packageSignature:next.payload.package.signature,taskVersion:fresh.taskVersion,taskVersionOrdinal:fresh.taskVersionOrdinal,assigneeId:fresh.assigneeId,deviceId:fresh.deviceId,ruleVersion:fresh.ruleVersion,updatedAt:new Date().toISOString()}
    const record={...nextEnvelope,seal:await this.sign(nextEnvelope)},tx=db.transaction(STORE,'readwrite');await request(tx.objectStore(STORE).put(record,key));await done(tx);return record
  }
}

export async function readDraftAuthority(draft: FieldTaskDraft, store = new DraftControlKeyStore()) { return store.readAuthority(draft) }
export async function writeDraftAllow(draft: FieldTaskDraft, store = new DraftControlKeyStore(), previous?: FieldTaskDraft) { return store.writeAllow(draft, previous) }
export async function writeDraftDeny(draft: FieldTaskDraft, reason: DraftTerminalState, store = new DraftControlKeyStore()) { return store.writeDeny(draft, reason) }
export async function replaceDeniedDraftAuthority(previous:FieldTaskDraft,next:FieldTaskDraft,store=new DraftControlKeyStore()){return store.replaceDeniedWithAllow(previous,next)}
export async function verifyDraftAuthority(draft: FieldTaskDraft, store = new DraftControlKeyStore()): Promise<boolean> {
  const record = await store.readAuthority(draft), p = draft.payload.package.signedPayload
  return !!record && record.state === 'ALLOW' && record.ownerId === draft.ownerId && record.roundId === p.roundId
    && record.packageSignature === draft.payload.package.signature && record.taskVersion === p.taskVersion && record.taskVersionOrdinal===p.taskVersionOrdinal
    && record.assigneeId === p.assigneeId && record.deviceId === p.deviceId && record.ruleVersion === p.ruleVersion
}
export async function verifyDraftDenied(draft: FieldTaskDraft, store = new DraftControlKeyStore()): Promise<boolean> {
  const record = await store.readAuthority(draft), p = draft.payload.package.signedPayload
  return !!record && record.state === 'DENY' && record.ownerId === draft.ownerId && record.roundId === p.roundId
    && record.packageSignature === draft.payload.package.signature && record.taskVersion === p.taskVersion && record.taskVersionOrdinal===p.taskVersionOrdinal
    && record.assigneeId === p.assigneeId && record.deviceId === p.deviceId && record.ruleVersion === p.ruleVersion
}

export function controlEnvelope(draft: FieldTaskDraft, terminal: DraftTerminalState, lastWallTime: number): DraftControlEnvelope {
  const p = draft.payload.package.signedPayload
  return { version: 1, roundId: p.roundId, ownerId: draft.ownerId, packageSignature: draft.payload.package.signature, taskVersion: p.taskVersion, ruleVersion: p.ruleVersion,
    revision: draft.payload.draftRevision, trustedServerTime: p.authorization.serverTime, wallTimeAtTrust: draft.payload.clock.wallTimeAtTrust, lastWallTime, terminal,
    business: { global: draft.payload.global, rows: draft.payload.rows } }
}

export async function sealDraft(draft: FieldTaskDraft, terminal: DraftTerminalState, lastWallTime: number, store = new DraftControlKeyStore()): Promise<FieldTaskDraft> {
  const control = controlEnvelope(draft, terminal, lastWallTime)
  const controlSeal = await store.sign(control)
  return { ...draft, payload: { ...draft.payload, clock: { ...draft.payload.clock, trustedServerTime: control.trustedServerTime, lastWallTime }, control, controlSeal } }
}

export async function verifyDraftSeal(draft: FieldTaskDraft, store = new DraftControlKeyStore()): Promise<boolean> {
  const control = draft.payload.control
  if (!control || !draft.payload.controlSeal || draft.payload.clock.trustedServerTime !== control.trustedServerTime
    || draft.payload.clock.wallTimeAtTrust !== control.wallTimeAtTrust || draft.payload.clock.lastWallTime !== control.lastWallTime
    || canonicalControl(controlEnvelope(draft, control.terminal, control.lastWallTime)) !== canonicalControl(control)) return false
  return store.verify(control, draft.payload.controlSeal)
}
