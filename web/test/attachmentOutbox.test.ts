import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { AttachmentOutbox, type AttachmentScope } from '../src/offline/attachmentOutbox'
import { internalSensitiveAttachmentCapability } from '../src/offline/attachmentOutboxInternal'

const scope: AttachmentScope = { ownerId: 'sampler-a', deviceId: 'device-a', roundId: 'round-1', sampleSlotId: 'slot-1' }
const locks = { request: async (_name: string, _options: unknown, callback: () => unknown) => callback() }
const storage = { estimate: async () => ({ usage: 10, quota: 10_000_000 }), persist: async () => true }
let factory: IDBFactory
function idbDone(tx:IDBTransaction){return new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);tx.onerror=()=>reject(tx.error)})}
async function seedLegacy(factory:IDBFactory, bytes='legacy-photo') { const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=factory.open('field-attachments-v1',1);r.onupgradeneeded=()=>{r.result.createObjectStore('attachments');r.result.createObjectStore('attachment-audit',{autoIncrement:true})};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)}),metadata={...scope,attachmentId:'legacy-1',hash:'x',mime:'image/jpeg',size:bytes.length,revision:1,status:'local_saved' as const,updatedAt:new Date().toISOString()},tx=db.transaction('attachments','readwrite');tx.objectStore('attachments').put({metadata,bytes:new TextEncoder().encode(bytes).buffer},`${scope.ownerId}\u001f${scope.deviceId}\u001f${scope.roundId}\u001f${scope.sampleSlotId}\u001flegacy-1`);await idbDone(tx);db.close() }
async function stores(factory:IDBFactory){return new Promise<string[]>((resolve,reject)=>{const r=factory.open('field-attachments-v1');r.onsuccess=()=>resolve([...r.result.objectStoreNames]);r.onerror=()=>reject(r.error)})}

describe('offline attachment outbox', () => {
  beforeEach(() => { factory = new IDBFactory() })

  it('upgrades the same v1 database without losing confirmed metadata or bytes',async()=>{await seedLegacy(factory);const outbox=new AttachmentOutbox(factory,storage,locks,internalSensitiveAttachmentCapability);expect(await outbox.list(scope)).toMatchObject([{attachmentId:'legacy-1',status:'local_saved'}]);expect(await (await outbox.getBlob(scope,'legacy-1'))?.text()).toBe('legacy-photo');expect(outbox.readonlyMode).toBe(false);expect(await stores(factory)).not.toContain('attachments')})

  it('aborted migration preserves v1 bytes and enters readonly recovery',async()=>{await seedLegacy(factory);const outbox=new AttachmentOutbox(factory,storage,locks,internalSensitiveAttachmentCapability,{failMigration:true});expect(await (await outbox.getBlob(scope,'legacy-1'))?.text()).toBe('legacy-photo');expect(outbox.readonlyMode).toBe(true);expect(await stores(factory)).toContain('attachments');await expect(outbox.save(scope,new Blob(['new']),{attachmentId:'new',revision:1})).rejects.toThrow('ATTACHMENT_READONLY_RECOVERY')})

  it('atomically restores blob and bound metadata after reopen', async () => {
    const first = new AttachmentOutbox(factory, storage, locks, internalSensitiveAttachmentCapability)
    const saved = await first.save(scope, new Blob(['photo-one'], { type: 'image/jpeg' }), { attachmentId: 'a-1', revision: 1 })
    expect(saved.status).toBe('local_saved')
    const reopened = new AttachmentOutbox(factory, storage, locks, internalSensitiveAttachmentCapability)
    const restored = await reopened.read(scope, 'a-1')
    expect(restored?.blob.size).toBe(9)
    expect(restored?.blob.type).toBe('image/jpeg')
    expect(restored?.metadata).toMatchObject({ ownerId: 'sampler-a', deviceId: 'device-a', roundId: 'round-1', sampleSlotId: 'slot-1', attachmentId: 'a-1', revision: 1 })
  })

  it('fails closed across owner, device and sample slot boundaries', async () => {
    const outbox = new AttachmentOutbox(factory, storage, locks, internalSensitiveAttachmentCapability)
    await outbox.save(scope, new Blob(['secret'], { type: 'image/jpeg' }), { attachmentId: 'a-1', revision: 1 })
    await expect(outbox.read({ ...scope, ownerId: 'sampler-b' }, 'a-1')).rejects.toThrow('ATTACHMENT_SCOPE_MISMATCH')
    await expect(outbox.read({ ...scope, deviceId: 'device-b' }, 'a-1')).rejects.toThrow('ATTACHMENT_SCOPE_MISMATCH')
    await expect(outbox.read({ ...scope, sampleSlotId: 'slot-2' }, 'a-1')).rejects.toThrow('ATTACHMENT_SCOPE_MISMATCH')
  })

  it('stops new writes at the conservative quota threshold without deleting existing files', async () => {
    const tightStorage = { estimate: async () => ({ usage: 9_600, quota: 10_000 }), persist: async () => false }
    const outbox = new AttachmentOutbox(factory, tightStorage, locks, internalSensitiveAttachmentCapability)
    await expect(outbox.save(scope, new Blob(['new'], { type: 'image/jpeg' }), { attachmentId: 'a-2', revision: 1 })).rejects.toThrow('ATTACHMENT_CAPACITY_EXCEEDED')
    expect(await outbox.list(scope)).toEqual([])
  })

  it('retains recoverable metadata as storage_error when blob persistence fails', async () => {
    const outbox = new AttachmentOutbox(factory, storage, locks, internalSensitiveAttachmentCapability, { failBlobWrite: true })
    await expect(outbox.save(scope, new Blob(['photo'], { type: 'image/jpeg' }), { attachmentId: 'a-3', revision: 1 })).rejects.toThrow('ATTACHMENT_BLOB_WRITE_FAILED')
    expect(await outbox.list(scope)).toMatchObject([{ attachmentId: 'a-3', status: 'storage_error' }])
  })

  it('keeps uploaded files complete during whole-file retry and records deletion tombstones', async () => {
    const outbox = new AttachmentOutbox(factory, storage, locks, internalSensitiveAttachmentCapability)
    await outbox.save(scope, new Blob(['one'], { type: 'image/jpeg' }), { attachmentId: 'a-1', revision: 1 })
    await outbox.save(scope, new Blob(['two'], { type: 'image/jpeg' }), { attachmentId: 'a-2', revision: 1 })
    await outbox.setStatus(scope, 'a-1', 'queued')
    await outbox.setStatus(scope, 'a-1', 'uploading')
    await outbox.setStatus(scope, 'a-1', 'uploaded_staged', { receiptId: 'r-1' })
    await outbox.setStatus(scope, 'a-2', 'queued')
    await outbox.setStatus(scope, 'a-2', 'uploading')
    await outbox.setStatus(scope, 'a-2', 'retryable_error')
    expect((await outbox.prepareRetry(scope)).map(x => x.metadata.attachmentId)).toEqual(['a-2'])
    await outbox.deleteWithConfirmation(scope, 'a-2', true)
    expect(await outbox.list(scope)).toMatchObject([{ attachmentId: 'a-1', status: 'uploaded_staged' }, { attachmentId: 'a-2', status: 'deleted_tombstone' }])
  })

  it('fails closed when quota evidence is absent or invalid', async () => {
    await expect(new AttachmentOutbox(factory, {}, locks, internalSensitiveAttachmentCapability).save(scope, new Blob(['x']), { attachmentId: 'a-4', revision: 1 })).rejects.toThrow('ATTACHMENT_CAPACITY_EXCEEDED')
    await expect(new AttachmentOutbox(factory, { estimate: async () => ({ usage: Number.NaN, quota: 0 }) }, locks, internalSensitiveAttachmentCapability).save(scope, new Blob(['x']), { attachmentId: 'a-5', revision: 1 })).rejects.toThrow('ATTACHMENT_CAPACITY_EXCEEDED')
  })

  it('does not overwrite a previously durable blob when a replacement write fails', async () => {
    const first = new AttachmentOutbox(factory, storage, locks, internalSensitiveAttachmentCapability)
    await first.save(scope, new Blob(['durable'], { type: 'image/jpeg' }), { attachmentId: 'a-6', revision: 1 })
    const failing = new AttachmentOutbox(factory, storage, locks, internalSensitiveAttachmentCapability, { failBlobWrite: true })
    await expect(failing.save(scope, new Blob(['replacement'], { type: 'image/jpeg' }), { attachmentId: 'a-6', revision: 2 })).rejects.toThrow('ATTACHMENT_BLOB_WRITE_FAILED')
    expect(await (await failing.read(scope, 'a-6'))?.blob?.text()).toBe('durable')
  })
})
