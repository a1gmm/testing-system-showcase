import type { DatabaseSnapshot, OfflineDatabase, StoredDraft } from './offlineVault'
import { readDraftAuthority, replaceDeniedDraftAuthority, sealDraft, verifyDraftAuthority, verifyDraftDenied, verifyDraftSeal, writeDraftAllow, writeDraftDeny } from './draftControlInternal'
import type { DraftTerminalState } from './draftControl'
import { createFieldTaskDraft, draftShapeValid, renewalValid, renewTaskAuthorization, verifyOfflineTaskPackage, type FieldTaskDraft, type OfflineTaskPackage } from './fieldTaskDraft'
import { proveManagedDevicePossession } from './managedDevice'
import { rebuildConflictedDraft } from './draftConflictRecovery'

const META_STORE = 'meta'
const DRAFT_STORE = 'drafts'
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u

function validUserId(userId: string): boolean {
  return userId.length > 0 && [...userId].length <= 128 && !CONTROL_CHARACTERS.test(userId) && !UNPAIRED_SURROGATE.test(userId) && userId.normalize('NFC') === userId
}

export function offlineDatabaseName(userId: string): string {
  const encoded = [...new TextEncoder().encode(userId)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `field-offline-v1-${encoded}`
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
  })
}

export class IndexedDbOfflineDatabase implements OfflineDatabase {
  private readonly databaseName: string
  private readonly userId: string
  private readonly factory: IDBFactory
  private connection?: Promise<IDBDatabase>

  private async trustedDraftValid(draft: FieldTaskDraft): Promise<boolean> {
    const publicKey = String(import.meta.env.VITE_OFFLINE_PACKAGE_PUBLIC_KEY || '').replace(/\\n/g, '\n')
    const p = draft.payload.package.signedPayload, clock = draft.payload.clock, now = Date.now()
    return draft.ownerId === this.userId && draftShapeValid(draft) && clock.trustedServerTime === p.authorization.serverTime
      && Number.isFinite(clock.wallTimeAtTrust) && clock.lastWallTime >= clock.wallTimeAtTrust
      && Date.parse(p.authorization.expiresAt) > now && Date.parse(p.authorization.serverTime) <= now + 12 * 60 * 60_000
      && Date.parse(p.authorization.issuedAt) <= Date.parse(p.authorization.serverTime)
      && await verifyOfflineTaskPackage(draft.payload.package, publicKey) && await proveManagedDevicePossession(draft.payload.package)
  }
  async draftWriteStatus(draft: FieldTaskDraft): Promise<{ allowed: boolean; reason?: string }> {
    if (!await this.trustedDraftValid(draft) || !await verifyDraftSeal(draft)) return { allowed: false, reason: 'integrity_failure' }
    const authority = await readDraftAuthority(draft)
    return await verifyDraftAuthority(draft) ? { allowed: true } : { allowed: false, reason: authority?.reason || 'authority_missing' }
  }
  async denyDraftAuthority(draft: FieldTaskDraft, reason: DraftTerminalState): Promise<void> {
    if (!await this.trustedDraftValid(draft) || !await verifyDraftSeal(draft)) throw new Error('DRAFT_CONTROL_INVALID')
    await writeDraftDeny(draft, reason)
  }

  constructor(userId: string, factory: IDBFactory) {
    if (!validUserId(userId)) throw new Error('Valid immutable user ID is required')
    this.userId = userId
    this.factory = factory
    this.databaseName = offlineDatabaseName(userId)
  }

  private open(): Promise<IDBDatabase> {
    if (this.connection) return this.connection
    this.connection = new Promise((resolve, reject) => {
      const request = this.factory.open(this.databaseName, 1)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE)
        if (!database.objectStoreNames.contains(DRAFT_STORE)) database.createObjectStore(DRAFT_STORE, { keyPath: 'id' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Cannot open offline database'))
      request.onblocked = () => reject(new Error('Offline database upgrade is blocked'))
    })
    return this.connection
  }

  async snapshot(): Promise<DatabaseSnapshot> {
    const database = await this.open()
    const transaction = database.transaction([META_STORE, DRAFT_STORE], 'readonly')
    const meta = transaction.objectStore(META_STORE)
    const drafts = transaction.objectStore(DRAFT_STORE)
    const [schemaVersion, allDrafts] = await Promise.all([
      requestResult(meta.get('schemaVersion')),
      requestResult(drafts.getAll() as IDBRequest<StoredDraft[]>),
    ])
    await transactionDone(transaction)
    return {
      schemaVersion: typeof schemaVersion === 'number' ? schemaVersion : 1,
      drafts: allDrafts.filter((item) => item.ownerId === this.userId),
      ownerMismatch: allDrafts.some((item) => item.ownerId !== this.userId),
    }
  }

  async snapshotReadonly(): Promise<DatabaseSnapshot> {
    if (typeof this.factory.databases !== 'function') throw new Error('Readonly database discovery unavailable')
    const exists = (await this.factory.databases()).some((entry) => entry.name === this.databaseName)
    if (!exists) throw new Error('Offline database does not exist')
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(this.databaseName)
      request.onupgradeneeded = () => {
        request.transaction?.abort()
        request.result.close()
        reject(new Error('Readonly open attempted a version change'))
      }
      request.onsuccess = () => {
        if (!request.result.objectStoreNames.contains(META_STORE) || !request.result.objectStoreNames.contains(DRAFT_STORE)) {
          request.result.close()
          reject(new Error('Offline database stores unavailable'))
          return
        }
        resolve(request.result)
      }
      request.onerror = () => reject(request.error ?? new Error('Cannot open offline database readonly'))
      request.onblocked = () => reject(new Error('Offline database readonly open is blocked'))
    })
    try {
      const transaction = database.transaction([META_STORE, DRAFT_STORE], 'readonly')
      const [schemaVersion, allDrafts] = await Promise.all([
        requestResult(transaction.objectStore(META_STORE).get('schemaVersion')),
        requestResult(transaction.objectStore(DRAFT_STORE).getAll() as IDBRequest<StoredDraft[]>),
      ])
      await transactionDone(transaction)
      return {
        schemaVersion: typeof schemaVersion === 'number' ? schemaVersion : 1,
        drafts: allDrafts.filter((item) => item.ownerId === this.userId),
        ownerMismatch: allDrafts.some((item) => item.ownerId !== this.userId),
      }
    } finally {
      database.close()
    }
  }

  async migrate(targetVersion: number): Promise<void> {
    const database = await this.open()
    const transaction = database.transaction([META_STORE, DRAFT_STORE], 'readwrite')
    const meta = transaction.objectStore(META_STORE)
    const drafts = transaction.objectStore(DRAFT_STORE)
    const currentValue = await requestResult(meta.get('schemaVersion'))
    const currentVersion = typeof currentValue === 'number' ? currentValue : 1
    if (currentVersion >= targetVersion) {
      await transactionDone(transaction)
      return
    }

    const records = await requestResult(drafts.getAll() as IDBRequest<StoredDraft[]>)
    for (const record of records) {
      if (record.ownerId !== this.userId) {
        transaction.abort()
        throw new Error('Offline database owner mismatch')
      }
      if ((record.payload as any)?.kind === 'field-task') { transaction.abort(); throw new Error('FIELD_DRAFT_VERIFIED_MIGRATION_REQUIRED') }
      drafts.put({ ...record, schemaVersion: targetVersion })
    }
    meta.put(targetVersion, 'schemaVersion')
    await transactionDone(transaction)
  }

  async saveDraftAtomic(
    draft: StoredDraft,
    expectedRevision: number,
    command: { scope: 'global' | 'row'; field: string; sampleSlotId?: string; value: unknown; baseValue?: unknown; savedAt: string; wallTime: number },
  ): Promise<StoredDraft> {
    const wallTime = Date.now(), savedAt = new Date(wallTime).toISOString()
    if (draft.ownerId !== this.userId) throw new Error('DRAFT_OWNER_MISMATCH')
    if (!await this.trustedDraftValid(draft as FieldTaskDraft)) throw new Error('DRAFT_TRUST_INVALID')
    if (!await verifyDraftAuthority(draft as FieldTaskDraft)) throw new Error('DRAFT_AUTHORITY_INVALID')
    if (!await verifyDraftSeal(draft as FieldTaskDraft)) throw new Error('DRAFT_CONTROL_INVALID')
    if ((draft as FieldTaskDraft).payload.control?.terminal !== 'active') throw new Error('DRAFT_TERMINAL')
    const currentRevision = Number(draft.payload.draftRevision ?? 0)
    if (currentRevision !== expectedRevision) {
      const currentValue = command.scope === 'global' ? (draft.payload.global as any)?.[command.field] : (draft.payload.rows as any[])?.find(row => row.sampleSlotId === command.sampleSlotId)?.[command.field]
      if (!Object.is(currentValue, command.baseValue)) throw new Error('DRAFT_FIELD_CONFLICT')
      expectedRevision = currentRevision
    }
    const signed = (draft.payload.package as any)?.signedPayload
    const allowedFields = command.scope === 'global' ? signed?.formSchema?.globalFields : signed?.formSchema?.rowFields
    if (!Array.isArray(allowedFields) || !allowedFields.includes(command.field) || command.field === 'samplingDate' || command.field === 'sampleSlotId') throw new Error('DRAFT_FIELD_MISMATCH')
    const payload = structuredClone(draft.payload)
    if (command.scope === 'global') payload.global = { ...((payload.global as Record<string, unknown>) ?? {}), [command.field]: command.value }
    else { const rows = Array.isArray(payload.rows) ? payload.rows.map(row => ({ ...row })) : []; const index = rows.findIndex(row => row.sampleSlotId === command.sampleSlotId); if (index < 0) throw new Error('DRAFT_SAMPLE_SLOT_MISMATCH'); rows[index][command.field] = command.value; payload.rows = rows }
    payload.clock = { ...((payload.clock as Record<string, unknown>) ?? {}), lastWallTime: wallTime }
    const projected = { ...draft, updatedAt: savedAt, payload: { ...payload, draftRevision: currentRevision + 1, localSavedAt: savedAt } }
    const sealed = await sealDraft(projected as FieldTaskDraft, 'active', wallTime)
    const database = await this.open()
    const transaction = database.transaction([DRAFT_STORE], 'readwrite')
    const store = transaction.objectStore(DRAFT_STORE)
    try {
      const existing = await requestResult(store.get(draft.id) as IDBRequest<StoredDraft | undefined>)
      if (existing && existing.ownerId !== this.userId) throw new Error('DRAFT_OWNER_MISMATCH')
      if (!existing || Number(existing.payload.draftRevision ?? 0) !== expectedRevision) throw new Error('DRAFT_REVISION_CONFLICT')
      store.put(sealed)
      await transactionDone(transaction)
      return structuredClone(sealed)
    } catch (error) {
      try { transaction.abort() } catch { /* already completed/aborted */ }
      throw error
    }
  }

  async renewDraftAtomic(draft: StoredDraft, expectedRevision: number, taskPackage: OfflineTaskPackage): Promise<StoredDraft> {
    if (!await this.trustedDraftValid(draft as FieldTaskDraft) || !await verifyDraftAuthority(draft as FieldTaskDraft) || !await verifyOfflineTaskPackage(taskPackage, String(import.meta.env.VITE_OFFLINE_PACKAGE_PUBLIC_KEY || '').replace(/\\n/g, '\n')) || !await proveManagedDevicePossession(taskPackage)) throw new Error('DRAFT_TRUST_INVALID')
    if (!await verifyDraftSeal(draft as FieldTaskDraft) || Number(draft.payload.draftRevision) !== expectedRevision) throw new Error('DRAFT_CONTROL_INVALID')
    if ((draft as FieldTaskDraft).payload.control?.terminal !== 'active') throw new Error('DRAFT_TERMINAL_RENEWAL_FORBIDDEN')
    if (!renewalValid(draft as FieldTaskDraft, taskPackage)) throw new Error('DRAFT_RENEWAL_REJECTED')
    const wallTime = Date.now(), renewed = renewTaskAuthorization(draft as FieldTaskDraft, taskPackage, wallTime)
    const next = { ...renewed, payload: { ...renewed.payload, draftRevision: expectedRevision + 1 } }
    const sealed = await sealDraft(next as FieldTaskDraft, 'active', wallTime)
    await writeDraftAllow(sealed, undefined, draft as FieldTaskDraft)
    const database = await this.open()
    const transaction = database.transaction([DRAFT_STORE], 'readwrite')
    const store = transaction.objectStore(DRAFT_STORE)
    try {
      const existing = await requestResult(store.get(draft.id) as IDBRequest<StoredDraft | undefined>)
      if (!existing || existing.ownerId !== this.userId) throw new Error('DRAFT_OWNER_MISMATCH')
      if (Number(existing.payload.draftRevision ?? 0) !== expectedRevision) throw new Error('DRAFT_REVISION_CONFLICT')
      store.put(sealed)
      await transactionDone(transaction)
      return structuredClone(sealed)
    } catch (error) { try { transaction.abort() } catch {} throw error }
  }

  async installDraftAtomic(taskPackage: OfflineTaskPackage): Promise<StoredDraft> {
    const now = Date.now(), p = taskPackage?.signedPayload
    if (!p || p.assigneeId !== this.userId || !await verifyOfflineTaskPackage(taskPackage, String(import.meta.env.VITE_OFFLINE_PACKAGE_PUBLIC_KEY || '').replace(/\\n/g, '\n')) || !await proveManagedDevicePossession(taskPackage)
      || Date.parse(p.authorization.expiresAt) <= now || Date.parse(p.authorization.serverTime) > now + 12 * 60 * 60_000 || Date.parse(p.authorization.issuedAt) > Date.parse(p.authorization.serverTime)) throw new Error('DRAFT_INSTALL_TRUST_INVALID')
    const unsigned = createFieldTaskDraft(taskPackage, now), database = await this.open(), preflight = database.transaction(DRAFT_STORE, 'readonly')
    const existingDraft = await requestResult(preflight.objectStore(DRAFT_STORE).get(unsigned.id) as IDBRequest<StoredDraft | undefined>); await transactionDone(preflight)
    if (existingDraft) throw new Error('DRAFT_ALREADY_INSTALLED')
    const existingAuthority = await readDraftAuthority(unsigned)
    if (existingAuthority) throw new Error('DRAFT_INSTALL_AUTHORITY_EXISTS')
    const draft = await sealDraft(unsigned, 'active', now)
    await writeDraftAllow(draft)
    const transaction = database.transaction([DRAFT_STORE], 'readwrite')
    const store = transaction.objectStore(DRAFT_STORE)
    try {
      const existing = await requestResult(store.get(draft.id) as IDBRequest<StoredDraft | undefined>)
      if (existing) {
        if (existing.ownerId !== this.userId) throw new Error('DRAFT_OWNER_MISMATCH')
        throw new Error('DRAFT_ALREADY_INSTALLED')
      }
      store.add(draft)
      await transactionDone(transaction)
      return structuredClone(draft)
    } catch (error) {
      try { transaction.abort() } catch { /* already completed/aborted */ }
      throw error
    }
  }

  async rebuildConflictedDraftAtomic(draft:FieldTaskDraft,taskPackage:OfflineTaskPackage){
    const locks=globalThis.navigator?.locks;if(!locks)throw new Error('DRAFT_REPLACEMENT_LOCK_UNAVAILABLE')
    return locks.request(`tc-field-draft:${draft.id}`,{mode:'exclusive'},async()=>{
    const now=Date.now(),fresh=taskPackage?.signedPayload,old=draft.payload.package.signedPayload
    if(draft.ownerId!==this.userId||fresh?.assigneeId!==this.userId||fresh.roundId!==old.roundId||fresh.taskVersionOrdinal<=old.taskVersionOrdinal
      ||!await verifyOfflineTaskPackage(taskPackage,String(import.meta.env.VITE_OFFLINE_PACKAGE_PUBLIC_KEY||'').replace(/\\n/g,'\n'))||!await proveManagedDevicePossession(taskPackage)
      ||!await verifyDraftDenied(draft))throw new Error('DRAFT_REPLACEMENT_TRUST_INVALID')
    const built=rebuildConflictedDraft(draft,taskPackage,now),archived=await sealDraft(built.archived,'conflict',now),replacement=await sealDraft(built.replacement,'active',now),database=await this.open()
    const preflight=database.transaction(DRAFT_STORE,'readonly'),all=await requestResult(preflight.objectStore(DRAFT_STORE).getAll() as IDBRequest<StoredDraft[]>);await transactionDone(preflight)
    const interruptedReplacement=all.find(item=>item.id===draft.id&&(item as FieldTaskDraft).payload.package?.signature===taskPackage.signature) as FieldTaskDraft|undefined
    const interruptedArchive=all.find(item=>item.id.startsWith(`${draft.id}:conflict:${draft.payload.draftRevision}:`))
    if(interruptedReplacement&&interruptedArchive){await replaceDeniedDraftAuthority(draft,interruptedReplacement);return{archived:structuredClone(interruptedArchive),replacement:structuredClone(interruptedReplacement),copyCandidates:structuredClone(built.copyCandidates)}}
    const tx=database.transaction(DRAFT_STORE,'readwrite'),store=tx.objectStore(DRAFT_STORE)
    try{const current=await requestResult(store.get(draft.id) as IDBRequest<StoredDraft|undefined>);if(!current||Number(current.payload.draftRevision)!==draft.payload.draftRevision)throw new Error('DRAFT_REVISION_CONFLICT');store.delete(draft.id);store.put(archived);store.put(replacement);await transactionDone(tx)}catch(error){try{tx.abort()}catch{}throw error}
    await replaceDeniedDraftAuthority(draft,replacement)
    return{archived:structuredClone(archived),replacement:structuredClone(replacement),copyCandidates:structuredClone(built.copyCandidates)}
    })
  }

  async setDraftTerminalAtomic(draft: StoredDraft, terminal: DraftTerminalState, _requestedWallTime: number): Promise<StoredDraft> {
    const wallTime = Date.now()
    if (draft.ownerId !== this.userId || !await this.trustedDraftValid(draft as FieldTaskDraft) || !await verifyDraftSeal(draft as FieldTaskDraft) || !await verifyDraftDenied(draft as FieldTaskDraft)) throw new Error('DRAFT_CONTROL_INVALID')
    const next = { ...draft, payload: { ...draft.payload, draftRevision: Number(draft.payload.draftRevision ?? 0) + 1 } }
    const sealed = await sealDraft(next as FieldTaskDraft, terminal, wallTime)
    const database = await this.open(); const tx = database.transaction(DRAFT_STORE, 'readwrite'); const store = tx.objectStore(DRAFT_STORE)
    const current = await requestResult(store.get(draft.id) as IDBRequest<StoredDraft | undefined>)
    if (!current || Number(current.payload.draftRevision) !== Number(draft.payload.draftRevision)) { tx.abort(); throw new Error('DRAFT_REVISION_CONFLICT') }
    store.put(sealed); await transactionDone(tx); return structuredClone(sealed)
  }

  async persistDraftTerminal(draftId: string, terminal: DraftTerminalState, wallTime: number): Promise<StoredDraft> {
    let lastError: unknown
    for (let attempt = 0; attempt < 4; attempt++) {
      const latest = (await this.snapshot()).drafts.find(item => item.id === draftId)
      if (!latest) throw new Error('DRAFT_NOT_FOUND')
      if (!await this.trustedDraftValid(latest as FieldTaskDraft) || !await verifyDraftSeal(latest as FieldTaskDraft) || !await verifyDraftDenied(latest as FieldTaskDraft)) throw new Error('DRAFT_CONTROL_INVALID')
      if ((latest as FieldTaskDraft).payload.control?.terminal !== 'active') return latest
      try { return await this.setDraftTerminalAtomic(latest, terminal, wallTime) }
      catch (error: any) { lastError = error; if (error?.message !== 'DRAFT_REVISION_CONFLICT') throw error }
    }
    throw lastError ?? new Error('DRAFT_TERMINAL_PERSIST_FAILED')
  }

  async checkpointDraftClockAtomic(draft: StoredDraft, expectedRevision: number, _requestedWallTime: number): Promise<StoredDraft> {
    const wallTime = Date.now()
    if (!await this.trustedDraftValid(draft as FieldTaskDraft)) throw new Error('DRAFT_TRUST_INVALID')
    if (!await verifyDraftAuthority(draft as FieldTaskDraft)) throw new Error('DRAFT_AUTHORITY_INVALID')
    if (draft.ownerId !== this.userId || !await verifyDraftSeal(draft as FieldTaskDraft)) throw new Error('DRAFT_CONTROL_INVALID')
    if ((draft as FieldTaskDraft).payload.control?.terminal !== 'active') throw new Error('DRAFT_TERMINAL')
    const clock = (draft as FieldTaskDraft).payload.clock
    if (!Number.isFinite(wallTime) || wallTime < clock.lastWallTime) throw new Error('DRAFT_CLOCK_INVALID')
    const next = { ...draft, payload: { ...draft.payload, draftRevision: expectedRevision + 1, clock: { ...clock, lastWallTime: wallTime } } }
    const sealed = await sealDraft(next as FieldTaskDraft, 'active', wallTime)
    const database = await this.open(); const tx = database.transaction(DRAFT_STORE, 'readwrite'); const store = tx.objectStore(DRAFT_STORE)
    const current = await requestResult(store.get(draft.id) as IDBRequest<StoredDraft | undefined>)
    if (!current || Number(current.payload.draftRevision) !== expectedRevision) { tx.abort(); throw new Error('DRAFT_REVISION_CONFLICT') }
    store.put(sealed); await transactionDone(tx); return structuredClone(sealed)
  }
}

export function createIndexedDbOfflineDatabase(
  userId: string,
  factory: IDBFactory | undefined = globalThis.indexedDB,
): IndexedDbOfflineDatabase | null {
  if (!factory || !validUserId(userId)) return null
  return new IndexedDbOfflineDatabase(userId, factory)
}
