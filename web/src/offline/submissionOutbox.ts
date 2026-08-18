import type { FieldTaskDraft } from './fieldTaskDraft'

export type LocalSubmissionStatus = 'queued' | 'submitting' | 'unknown_commit' | 'pending' | 'finalizing' | 'complete' | 'invalid' | 'rejected'
export type SubmissionReceipt = { clientSubmissionId: string; receiptId: string; status: 'pending'|'finalizing'|'complete'|'failed'; payloadHash: string; [key: string]: unknown }
export type LocalSubmission = {
  clientSubmissionId: string; revisionKey: string; ownerId: string; deviceId: string; roundId: string
  taskVersion: string; ruleVersion: string; draftRevision: number; canonicalPayload: string; payloadHash: string
  attachmentReceipts: string[]; status: LocalSubmissionStatus; createdAt: string; updatedAt: string
  serverReceipt?: SubmissionReceipt
}
export type SubmissionApi = { create: (submission: LocalSubmission) => Promise<SubmissionReceipt>; query: (clientSubmissionId: string) => Promise<SubmissionReceipt> }

const STORE = 'submissions'
const validOwner = (value:string) => value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) && value.normalize('NFC') === value
const databaseName = (ownerId:string) => `field-submissions-v1-${[...new TextEncoder().encode(ownerId)].map(x=>x.toString(16).padStart(2,'0')).join('')}`
const request = <T>(value:IDBRequest<T>) => new Promise<T>((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error??new Error('SUBMISSION_STORAGE_FAILED'))})
const done = (tx:IDBTransaction) => new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('SUBMISSION_STORAGE_ABORTED'));tx.onerror=()=>reject(tx.error??new Error('SUBMISSION_STORAGE_FAILED'))})
function stable(value:unknown):string { if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);if(typeof value==='number'){if(!Number.isFinite(value))throw new Error('SUBMISSION_CANONICAL_INVALID');return JSON.stringify(value)}if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;if(typeof value==='object')return `{${Object.keys(value as object).sort().map(key=>{const item=(value as any)[key];if(item===undefined)throw new Error('SUBMISSION_CANONICAL_INVALID');return `${JSON.stringify(key)}:${stable(item)}`}).join(',')}}`;throw new Error('SUBMISSION_CANONICAL_INVALID') }
async function sha256(value:string){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('')}

export class SubmissionOutbox {
  private connection?:Promise<IDBDatabase>
  private readonly ownerId:string
  private readonly factory:IDBFactory
  private readonly uuid:()=>string
  constructor(ownerId:string,factory:IDBFactory=globalThis.indexedDB,uuid:()=>string=()=>crypto.randomUUID()) {
    if(!factory||!validOwner(ownerId))throw new Error('SUBMISSION_OWNER_INVALID')
    this.ownerId=ownerId;this.factory=factory;this.uuid=uuid
  }
  private open(){if(this.connection)return this.connection;this.connection=new Promise((resolve,reject)=>{const r=this.factory.open(databaseName(this.ownerId),1);r.onupgradeneeded=()=>{const store=r.result.createObjectStore(STORE,{keyPath:'clientSubmissionId'});store.createIndex('revisionKey','revisionKey',{unique:true})};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error??new Error('SUBMISSION_STORAGE_FAILED'));r.onblocked=()=>reject(new Error('SUBMISSION_STORAGE_BLOCKED'))});return this.connection}
  async create(draft:FieldTaskDraft,attachmentReceipts:string[]):Promise<LocalSubmission>{
    const p=draft.payload.package.signedPayload
    if(draft.ownerId!==this.ownerId||p.assigneeId!==this.ownerId)throw new Error('SUBMISSION_OWNER_MISMATCH')
    const receipts=[...attachmentReceipts].sort();if(new Set(receipts).size!==receipts.length)throw new Error('SUBMISSION_ATTACHMENT_DUPLICATE')
    const canonicalPayload=stable({formCode:p.formCode,draftRevision:draft.payload.draftRevision,global:draft.payload.global,rows:draft.payload.rows}),payloadHash=await sha256(canonicalPayload),revisionKey=`${p.roundId}\u001f${draft.payload.draftRevision}`
    const db=await this.open(),tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE),existing=await request(store.index('revisionKey').get(revisionKey)) as LocalSubmission|undefined
    if(existing){if(existing.ownerId!==this.ownerId||existing.payloadHash!==payloadHash||stable(existing.attachmentReceipts)!==stable(receipts)){tx.abort();throw new Error('SUBMISSION_REVISION_ALREADY_BOUND')}await done(tx);return structuredClone(existing)}
    const at=new Date().toISOString(),record:LocalSubmission={clientSubmissionId:this.uuid(),revisionKey,ownerId:this.ownerId,deviceId:p.deviceId,roundId:p.roundId,taskVersion:p.taskVersion,ruleVersion:p.ruleVersion,draftRevision:draft.payload.draftRevision,canonicalPayload,payloadHash,attachmentReceipts:receipts,status:'queued',createdAt:at,updatedAt:at}
    store.add(record);await done(tx);return structuredClone(record)
  }
  async get(id:string):Promise<LocalSubmission|undefined>{const db=await this.open(),tx=db.transaction(STORE,'readonly'),result=await request(tx.objectStore(STORE).get(id)) as LocalSubmission|undefined;await done(tx);if(result&&result.ownerId!==this.ownerId)throw new Error('SUBMISSION_OWNER_MISMATCH');return result?structuredClone(result):undefined}
  async findForDraft(draft:FieldTaskDraft):Promise<LocalSubmission|undefined>{if(draft.ownerId!==this.ownerId)throw new Error('SUBMISSION_OWNER_MISMATCH');const p=draft.payload.package.signedPayload,key=`${p.roundId}\u001f${draft.payload.draftRevision}`,db=await this.open(),tx=db.transaction(STORE,'readonly'),result=await request(tx.objectStore(STORE).index('revisionKey').get(key)) as LocalSubmission|undefined;await done(tx);return result?structuredClone(result):undefined}
  private async update(id:string,allowed:LocalSubmissionStatus[],mutate:(value:LocalSubmission)=>LocalSubmission){const db=await this.open(),tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE);try{const current=await request(store.get(id)) as LocalSubmission|undefined;if(!current||current.ownerId!==this.ownerId)throw new Error('SUBMISSION_NOT_FOUND');if(!allowed.includes(current.status))throw new Error(`SUBMISSION_STATE_CONFLICT:${current.status}`);const next={...mutate(current),updatedAt:new Date().toISOString()};store.put(next);await done(tx);return structuredClone(next)}catch(error){try{tx.abort()}catch{}throw error}}
  markSubmitting(id:string){return this.update(id,['queued'],x=>({...x,status:'submitting'}))}
  markUnknown(id:string){return this.update(id,['queued','submitting','unknown_commit'],x=>({...x,status:'unknown_commit'}))}
  markInvalid(id:string){return this.update(id,['submitting','unknown_commit','pending','finalizing'],x=>({...x,status:'invalid'}))}
  recordReceipt(id:string,receipt:SubmissionReceipt){return this.update(id,['submitting','unknown_commit','pending','finalizing'],x=>{if(receipt.clientSubmissionId!==x.clientSubmissionId||receipt.payloadHash!==x.payloadHash)throw new Error('SUBMISSION_RECEIPT_MISMATCH');const status=receipt.status==='failed'?'rejected':receipt.status;return{...x,status,serverReceipt:structuredClone(receipt)}})}
}

export async function syncSubmission(outbox:SubmissionOutbox,id:string,api:SubmissionApi):Promise<LocalSubmission>{
  let local=await outbox.get(id);if(!local)throw new Error('SUBMISSION_NOT_FOUND')
  if(local.status==='complete'||local.status==='rejected'||local.status==='invalid')return local
  if(local.status==='unknown_commit'||local.status==='submitting'||local.status==='pending'||local.status==='finalizing'){
    try{return await outbox.recordReceipt(id,await api.query(id))}catch(error:any){if(error?.message==='SUBMISSION_RECEIPT_MISMATCH'){await outbox.markInvalid(id);throw error}return local.status==='unknown_commit'?local:await outbox.markUnknown(id)}
  }
  local=await outbox.markSubmitting(id)
  try{return await outbox.recordReceipt(id,await api.create(local))}
  catch(error:any){if(error?.message==='SUBMISSION_RECEIPT_MISMATCH'){await outbox.markInvalid(id);throw error}local=await outbox.markUnknown(id);try{return await outbox.recordReceipt(id,await api.query(id))}catch(queryError:any){if(queryError?.message==='SUBMISSION_RECEIPT_MISMATCH'){await outbox.markInvalid(id);throw queryError}return local}}
}
