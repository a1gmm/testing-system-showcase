import { hasSensitiveAttachmentCapability, type SensitiveAttachmentCapability } from './attachmentOutboxInternal'

export type AttachmentStatus = 'local_saved'|'queued'|'uploading'|'uploaded_staged'|'retryable_error'|'invalid'|'auth_required'|'rejected'|'deleted_tombstone'|'storage_error'
export type AttachmentScope = { ownerId:string; deviceId:string; roundId:string; sampleSlotId:string }
export type AttachmentMetadata = AttachmentScope & { attachmentId:string; hash:string; mime:string; size:number; revision:number; status:AttachmentStatus; updatedAt:string; receiptId?:string }
type Locks = { request(name:string, options:{mode:'exclusive'}, callback:()=>unknown):Promise<unknown> }
type StorageManagerLike = { estimate?:()=>Promise<{usage?:number;quota?:number}>; persist?:()=>Promise<boolean> }
type StoredAttachment = { metadata:AttachmentMetadata; blob?:Blob }
const DB_NAME='field-attachments-v1', LEGACY='attachments', META='metadata', BLOBS='blobs', AUDIT='attachment-audit', CAPACITY_RATIO=.9, MAX=48*1024*1024
const transitions:Record<AttachmentStatus,AttachmentStatus[]>={local_saved:['queued','deleted_tombstone','storage_error'],queued:['uploading','deleted_tombstone'],uploading:['uploaded_staged','retryable_error','auth_required','rejected'],uploaded_staged:['deleted_tombstone'],retryable_error:['queued','uploading','deleted_tombstone'],invalid:['deleted_tombstone'],auth_required:['queued','uploading','deleted_tombstone'],rejected:['deleted_tombstone'],deleted_tombstone:[],storage_error:['local_saved','deleted_tombstone']}
function request<T>(r:IDBRequest<T>):Promise<T>{return new Promise((ok,no)=>{r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error??new Error('IndexedDB request failed'))})}
function complete(tx:IDBTransaction):Promise<void>{return new Promise((ok,no)=>{tx.oncomplete=()=>ok();tx.onabort=()=>no(tx.error??new Error('IndexedDB transaction aborted'));tx.onerror=()=>no(tx.error??new Error('IndexedDB transaction failed'))})}
function key(s:AttachmentScope,id:string){return `${s.ownerId}\u001f${s.deviceId}\u001f${s.roundId}\u001f${s.sampleSlotId}\u001f${id}`}
function scopeKey(s:AttachmentScope){return `${s.ownerId}\u001f${s.deviceId}\u001f${s.roundId}\u001f${s.sampleSlotId}`}
function same(a:AttachmentScope,b:AttachmentScope){return a.ownerId===b.ownerId&&a.deviceId===b.deviceId&&a.roundId===b.roundId&&a.sampleSlotId===b.sampleSlotId}
async function sha256(bytes:ArrayBuffer){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('')}

export class AttachmentOutbox{
  private connection?:Promise<IDBDatabase>
  readonlyMode=false
  private factory:IDBFactory;private storage:StorageManagerLike;private locks:Locks;private fault:{failBlobWrite?:boolean;failMigration?:boolean}
  constructor(factory:IDBFactory,storage:StorageManagerLike,locks:Locks,capability:SensitiveAttachmentCapability,fault:{failBlobWrite?:boolean;failMigration?:boolean}={}){this.factory=factory;this.storage=storage;this.locks=locks;this.fault=fault;if(!hasSensitiveAttachmentCapability(capability))throw new Error('SENSITIVE_ATTACHMENT_GATE_CLOSED');if(!locks?.request)throw new Error('ATTACHMENT_LOCK_UNAVAILABLE')}
  private open(){
    return this.connection??=new Promise<IDBDatabase>((ok,no)=>{
      const r=this.factory.open(DB_NAME,2)
      r.onupgradeneeded=()=>{
        const db=r.result,tx=r.transaction!
        if(!db.objectStoreNames.contains(META)){const meta=db.createObjectStore(META);meta.createIndex('scope','scopeKey')}
        if(!db.objectStoreNames.contains(BLOBS))db.createObjectStore(BLOBS)
        if(!db.objectStoreNames.contains(AUDIT))db.createObjectStore(AUDIT,{autoIncrement:true})
        if(db.objectStoreNames.contains(LEGACY)){
          const cursor=tx.objectStore(LEGACY).openCursor()
          cursor.onsuccess=()=>{const c=cursor.result;if(!c){db.deleteObjectStore(LEGACY);return}const record=c.value as {metadata:AttachmentMetadata;bytes?:ArrayBuffer},k=String(c.key);if(this.fault.failMigration){tx.abort();return}tx.objectStore(META).put({...record.metadata,scopeKey:scopeKey(record.metadata)},k);if(record.bytes)tx.objectStore(BLOBS).put(record.bytes,k);tx.objectStore(AUDIT).add({...record.metadata,event:'migrated_v1'});c.continue()}
        }
      }
      r.onsuccess=()=>ok(r.result)
      r.onerror=()=>{const fallback=this.factory.open(DB_NAME);fallback.onsuccess=()=>{this.readonlyMode=true;ok(fallback.result)};fallback.onerror=()=>no(r.error??new Error('Cannot open attachment outbox'))}
    })
  }
  private async writable(){const db=await this.open();if(this.readonlyMode||db.version<2)throw new Error('ATTACHMENT_READONLY_RECOVERY');return db}
  private locked<T>(s:AttachmentScope,fn:()=>Promise<T>){if(!this.locks?.request)return Promise.reject(new Error('ATTACHMENT_LOCK_UNAVAILABLE'));return this.locks.request(`tc-attachment-outbox:${s.ownerId}:${s.deviceId}:${s.roundId}`,{mode:'exclusive'},fn) as Promise<T>}
  private async capacityAllows(size:number){try{await this.storage.persist?.()}catch{};if(!this.storage.estimate)return false;const {usage,quota}=await this.storage.estimate();if(!Number.isFinite(usage)||!Number.isFinite(quota)||Number(quota)<=0||Number(usage)<0)return false;return Number(usage)+size<=Math.min(Number(quota)*CAPACITY_RATIO,MAX)}
  async save(scope:AttachmentScope,blob:Blob,input:{attachmentId:string;revision:number}){return this.locked(scope,async()=>{if(!await this.capacityAllows(blob.size))throw new Error('ATTACHMENT_CAPACITY_EXCEEDED');const bytes=await blob.arrayBuffer(),metadata:AttachmentMetadata={...scope,attachmentId:input.attachmentId,revision:input.revision,hash:await sha256(bytes),mime:blob.type||'application/octet-stream',size:blob.size,status:'local_saved',updatedAt:new Date().toISOString()},db=await this.writable(),k=key(scope,input.attachmentId)
    if(this.fault.failBlobWrite){const tx=db.transaction([META,AUDIT],'readwrite'),old=await request(tx.objectStore(META).get(k)) as AttachmentMetadata|undefined,failed={...(old??metadata),status:'storage_error' as const,updatedAt:new Date().toISOString()};tx.objectStore(META).put({...failed,scopeKey:scopeKey(scope)},k);tx.objectStore(AUDIT).add({...failed,event:'blob_write_failed'});await complete(tx);throw new Error('ATTACHMENT_BLOB_WRITE_FAILED')}
    const tx=db.transaction([META,BLOBS,AUDIT],'readwrite');tx.objectStore(META).put({...metadata,scopeKey:scopeKey(scope)},k);tx.objectStore(BLOBS).put(bytes,k);tx.objectStore(AUDIT).add({...metadata,event:'local_saved'});await complete(tx);return metadata})}
  async list(scope:AttachmentScope){const db=await this.open();if(db.version<2){const tx=db.transaction(LEGACY,'readonly'),rows=await request(tx.objectStore(LEGACY).getAll()) as {metadata:AttachmentMetadata}[];await complete(tx);return rows.map(x=>x.metadata).filter(x=>same(x,scope)).sort((a,b)=>a.attachmentId.localeCompare(b.attachmentId))}const tx=db.transaction(META,'readonly'),rows=await request(tx.objectStore(META).index('scope').getAll(scopeKey(scope))) as (AttachmentMetadata&{scopeKey:string})[];await complete(tx);return rows.map(({scopeKey:_k,...m})=>m).sort((a,b)=>a.attachmentId.localeCompare(b.attachmentId))}
  async getBlob(scope:AttachmentScope,id:string):Promise<Blob|null>{const db=await this.open(),k=key(scope,id);if(db.version<2){const tx=db.transaction(LEGACY,'readonly'),row=await request(tx.objectStore(LEGACY).get(k)) as {metadata:AttachmentMetadata;bytes?:ArrayBuffer}|undefined;await complete(tx);return row?.bytes?new Blob([row.bytes],{type:row.metadata.mime}):null}const tx=db.transaction([META,BLOBS],'readonly'),meta=await request(tx.objectStore(META).get(k)) as AttachmentMetadata|undefined;if(!meta){const all=await request(tx.objectStore(META).getAll()) as AttachmentMetadata[];await complete(tx);if(all.some(x=>x.attachmentId===id&&!same(x,scope)))throw new Error('ATTACHMENT_SCOPE_MISMATCH');return null}const bytes=await request(tx.objectStore(BLOBS).get(k)) as ArrayBuffer|undefined;await complete(tx);return bytes?new Blob([bytes],{type:meta.mime}):null}
  async read(scope:AttachmentScope,id:string):Promise<StoredAttachment|null>{const meta=(await this.list(scope)).find(x=>x.attachmentId===id);if(!meta){await this.getBlob(scope,id);return null}const blob=await this.getBlob(scope,id);return {metadata:meta,...(blob?{blob}:{})}}
  async setStatus(scope:AttachmentScope,id:string,status:AttachmentStatus,extra:{receiptId?:string}={}){return this.locked(scope,async()=>{const db=await this.writable(),tx=db.transaction([META,AUDIT],'readwrite'),k=key(scope,id),current=await request(tx.objectStore(META).get(k)) as (AttachmentMetadata&{scopeKey:string})|undefined;if(!current||!same(current,scope)){tx.abort();throw new Error('ATTACHMENT_SCOPE_MISMATCH')}if(!transitions[current.status].includes(status)){tx.abort();throw new Error(`ATTACHMENT_INVALID_TRANSITION:${current.status}:${status}`)}if(status==='uploaded_staged'&&!extra.receiptId){tx.abort();throw new Error('ATTACHMENT_RECEIPT_REQUIRED')}const next={...current,status,...extra,updatedAt:new Date().toISOString()};tx.objectStore(META).put(next,k);tx.objectStore(AUDIT).add({...next,event:status});await complete(tx);const {scopeKey:_k,...result}=next;return result})}
  async prepareRetry(scope:AttachmentScope){const rows=(await this.list(scope)).filter(x=>['local_saved','queued','retryable_error','auth_required'].includes(x.status)),result:StoredAttachment[]=[];for(const metadata of rows){const blob=await this.getBlob(scope,metadata.attachmentId);if(blob)result.push({metadata,blob})}return result}
  async deleteWithConfirmation(scope:AttachmentScope,id:string,confirmed:boolean){if(!confirmed)throw new Error('ATTACHMENT_DELETE_CONFIRMATION_REQUIRED');return this.locked(scope,async()=>{const db=await this.writable(),tx=db.transaction([META,BLOBS,AUDIT],'readwrite'),k=key(scope,id),current=await request(tx.objectStore(META).get(k)) as (AttachmentMetadata&{scopeKey:string})|undefined;if(!current){tx.abort();throw new Error('ATTACHMENT_NOT_FOUND')}const next={...current,status:'deleted_tombstone' as const,updatedAt:new Date().toISOString()};tx.objectStore(META).put(next,k);tx.objectStore(BLOBS).delete(k);tx.objectStore(AUDIT).add({...next,event:'deleted_tombstone'});await complete(tx);const {scopeKey:_k,...result}=next;return result})}
}
