<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api, currentUser } from '../api'
import FieldTaskWorkbench from '../offline/FieldTaskWorkbench.vue'
import { createIndexedDbOfflineDatabase } from '../offline/indexedDb'
import { reconcileTaskDraft, renewalValid, verifyFieldTaskDraft, verifyOfflineTaskPackage, type FieldTaskDraft, type OfflineTaskPackage } from '../offline/fieldTaskDraft'
import type { DraftTerminalState } from '../offline/draftControl'
import { verifyStoredRecoveryCredential } from '../offline/recoveryIdentity'
import { ManagedDeviceKeyStore, proveManagedDevicePossession, type DeviceRequestFields } from '../offline/managedDevice'
import { AttachmentOutbox, type AttachmentMetadata, type AttachmentScope } from '../offline/attachmentOutbox'
import { internalSensitiveAttachmentCapability } from '../offline/attachmentOutboxInternal'
import { subscribeAuthLogout } from '../offline/authLifecycle'
import { withFieldDraftLock } from '../offline/draftLock'
import { SubmissionOutbox, syncSubmission, type LocalSubmission } from '../offline/submissionOutbox'
import { submissionLocksEditing, type FieldSubmissionUiStatus } from '../offline/fieldSubmissionState'
import { useRoute } from 'vue-router'

const route = useRoute()
const draft = ref<FieldTaskDraft | null>(null)
const loading = ref(true)
const loadError = ref('')
const editable = ref(false)
const readonlyReason = ref('')
const online = ref(navigator.onLine)
const publicKeyPem = String(import.meta.env.VITE_OFFLINE_PACKAGE_PUBLIC_KEY || '').replace(/\\n/g, '\n')
let database: ReturnType<typeof createIndexedDbOfflineDatabase> = null
let authTimer: ReturnType<typeof setInterval> | undefined
let unsubscribeLogout: (() => void) | undefined
let checkpointInFlight = false
const startedAuthenticated = !!currentUser.value
let sessionEnded = false
let terminalLatched = false
let attachmentOutbox: AttachmentOutbox | null = null
const attachmentRows = ref<Record<string, AttachmentMetadata[]>>({})
let submissionOutbox: SubmissionOutbox | null = null
const submissionStatus = ref<FieldSubmissionUiStatus>('idle')
const recoveryNotice = ref('')
const confirmationSnapshot = ref<any>(null)
const sessionRoundId = ref('')
const routeRoundId = computed(() => String(route.params.id || ''))
const sessionMatchesRoute = computed(() => !sessionRoundId.value || sessionRoundId.value === routeRoundId.value)
const submissionFrozen = computed(() => submissionLocksEditing(submissionStatus.value, !!confirmationSnapshot.value))
const effectiveEditable = computed(() => editable.value && sessionMatchesRoute.value && !submissionFrozen.value)

function reasonText(reason: string) {
  return ({ signature_invalid: '任务包签名无效', authorization_expired: '离线授权已到期', clock_untrusted: '设备时间不可信',
    assignment_changed: '任务已改派', task_version_changed: '任务版本已更新', rule_version_changed: '规则版本已更新', owner_mismatch: '本机草稿归属不匹配', scope_invalid: '任务包不允许离线写入' } as Record<string, string>)[reason] || '离线授权不可用'
}
function makeReadonly(reason: string) { editable.value = false; readonlyReason.value = reasonText(reason) }

function bindSignedSession(value: FieldTaskDraft) {
  const signedRoundId = value.payload.package.signedPayload.roundId
  if (sessionRoundId.value && sessionRoundId.value !== signedRoundId) throw new Error('FIELD_SESSION_CHANGED')
  sessionRoundId.value = signedRoundId
  if (!sessionMatchesRoute.value) {
    confirmationSnapshot.value = null
    readonlyReason.value = '网址任务与本机签名任务不一致；本页面已闭锁，请返回任务列表重新进入'
    return false
  }
  return true
}

function assertCanonicalSession() {
  if (!draft.value || !sessionRoundId.value || !sessionMatchesRoute.value || draft.value.payload.package.signedPayload.roundId !== sessionRoundId.value) throw new Error('FIELD_SESSION_MISMATCH')
  return sessionRoundId.value
}

async function refreshEditability() {
  if (!draft.value) return false
  if (!bindSignedSession(draft.value)) return false
  if (!navigator.locks) { terminalLatched = true; editable.value = false; readonlyReason.value = '当前浏览器缺少跨标签安全锁，本机任务只读'; return false }
  if (sessionEnded || terminalLatched) { editable.value = false; if (!readonlyReason.value) readonlyReason.value = '本机任务已终止；草稿保留为只读'; return false }
  try { const authority = await database?.draftWriteStatus(draft.value); if (!authority?.allowed) { terminalLatched = true; editable.value = false; readonlyReason.value = `本机写入授权缺失或不匹配（${authority?.reason || 'authority_missing'}）`; return false } } catch { terminalLatched = true; editable.value = false; readonlyReason.value = '本机安全存储不可用（storage_unavailable）'; return false }
  if (draft.value.payload.control?.terminal !== 'active') { terminalLatched = true; editable.value = false; readonlyReason.value = `本机任务已终止（${draft.value.payload.control?.terminal || 'integrity'}）`; return false }
  const deviceBound = await proveManagedDevicePossession(draft.value.payload.package)
  const state = await verifyFieldTaskDraft(draft.value, publicKeyPem, Date.now(), crypto, deviceBound ? draft.value.payload.package.signedPayload.deviceId : null)
  if (!state.editable) { await persistTerminal(state.reason === 'authorization_expired' ? 'authorization_expired' : state.reason === 'clock_untrusted' ? 'clock_untrusted' : 'integrity_failure'); makeReadonly(state.reason); return false }
  editable.value = true
  readonlyReason.value = ''
  return true
}

async function authorizeDraftMutation() {
  if (!await refreshEditability()) return false
  if (submissionFrozen.value) {
    readonlyReason.value = '当前修订已冻结；如服务器拒绝提交，可修改后生成新修订'
    return false
  }
  return true
}

function attachmentScope(sampleSlotId:string):AttachmentScope { const p=draft.value!.payload.package.signedPayload; return { ownerId:p.assigneeId,deviceId:p.deviceId,roundId:p.roundId,sampleSlotId } }
async function refreshAttachments(sampleSlotId:string){if(attachmentOutbox)attachmentRows.value={...attachmentRows.value,[sampleSlotId]:await attachmentOutbox.list(attachmentScope(sampleSlotId))}}
async function signedRequest(fields:Omit<DeviceRequestFields,'taskVersion'|'ruleVersion'>){const p=draft.value!.payload.package.signedPayload;return new ManagedDeviceKeyStore().signRequest(p.deviceBindingPublicKeySpki,p.deviceBindingFingerprint,{...fields,taskVersion:p.taskVersion,ruleVersion:p.ruleVersion})}
function createAttachmentController(){return {
  enabled:true,
  list:(slot:string)=>attachmentRows.value[slot]??[],
  add:async(slot:string,file:File)=>{if(!attachmentOutbox||!await authorizeDraftMutation())throw new Error('ATTACHMENT_GATE_CLOSED');await attachmentOutbox.save(attachmentScope(slot),file,{attachmentId:crypto.randomUUID(),revision:1});await refreshAttachments(slot)},
  retry:async(slot:string,id:string)=>{if(!attachmentOutbox||!await authorizeDraftMutation())return;await attachmentOutbox.setStatus(attachmentScope(slot),id,'queued');await refreshAttachments(slot)},
  remove:async(slot:string,id:string,confirmed:boolean)=>{if(!attachmentOutbox||!await authorizeDraftMutation())return;const scope=attachmentScope(slot),item=(await attachmentOutbox.list(scope)).find(x=>x.attachmentId===id);if(item?.status==='uploaded_staged'){const path=`/api/rounds/${encodeURIComponent(scope.roundId)}/staged-attachments/${encodeURIComponent(id)}`;const proof=await signedRequest({method:'POST',path,actor:scope.ownerId,roundId:scope.roundId,attachmentId:id,bodyHash:await emptyHash()});await api.cancelStagedRoundAttachment(scope.roundId,id,proof)}await attachmentOutbox.deleteWithConfirmation(scope,id,confirmed);await refreshAttachments(slot)},
  startUpload:async(slot:string)=>{if(!attachmentOutbox||!draft.value||!await authorizeDraftMutation())return;const scope=attachmentScope(slot);for(const item of await attachmentOutbox.prepareRetry(scope)){if(!item.blob||!await authorizeDraftMutation())continue;await attachmentOutbox.setStatus(scope,item.metadata.attachmentId,'queued').catch(()=>undefined);await attachmentOutbox.setStatus(scope,item.metadata.attachmentId,'uploading');const path=`/api/rounds/${encodeURIComponent(scope.roundId)}/staged-attachments`;const fields={method:'POST',path,actor:scope.ownerId,roundId:scope.roundId,sampleSlotId:slot,attachmentId:item.metadata.attachmentId,hash:item.metadata.hash,size:item.metadata.size,mime:item.metadata.mime,bodyHash:item.metadata.hash,contentRevision:item.metadata.revision};try{const proof=await signedRequest(fields),response=await api.stageRoundAttachment(scope.roundId,slot,item.metadata,item.blob,proof);await attachmentOutbox.setStatus(scope,item.metadata.attachmentId,'uploaded_staged',{receiptId:response.receiptId})}catch(error:any){try{const queryPath=`${path}/${encodeURIComponent(item.metadata.attachmentId)}`,proof=await signedRequest({method:'GET',path:queryPath,actor:scope.ownerId,roundId:scope.roundId,attachmentId:item.metadata.attachmentId,bodyHash:await emptyHash()}),status=await api.getStagedRoundAttachment(scope.roundId,item.metadata.attachmentId,proof);await attachmentOutbox.setStatus(scope,item.metadata.attachmentId,'uploaded_staged',{receiptId:status.receiptId})}catch{const status=error?.response?.status;await attachmentOutbox.setStatus(scope,item.metadata.attachmentId,status===401?'auth_required':status===429||!status||status>=500?'retryable_error':'rejected')}}await refreshAttachments(slot)}}
}}
async function emptyHash(){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array()))].map(x=>x.toString(16).padStart(2,'0')).join('')}
async function enableAttachmentOutbox(){if(!draft.value||!editable.value||!navigator.locks||attachmentOutbox)return;const p=draft.value.payload.package.signedPayload;if(!await proveManagedDevicePossession(draft.value.payload.package))return;attachmentOutbox=new AttachmentOutbox(indexedDB,navigator.storage,navigator.locks as any,internalSensitiveAttachmentCapability);for(const slot of p.sampleSlots)await refreshAttachments(slot.sampleSlotId)}

async function submissionBody(local:LocalSubmission){return {clientSubmissionId:local.clientSubmissionId,taskVersion:local.taskVersion,ruleVersion:local.ruleVersion,draftRevision:local.draftRevision,canonicalPayload:local.canonicalPayload,payloadHash:local.payloadHash,attachmentReceipts:local.attachmentReceipts}}
async function prepareSubmission(){
  if(!draft.value||!submissionOutbox||!navigator.onLine||!currentUser.value)throw new Error('SUBMISSION_GATE_CLOSED')
  const roundId=assertCanonicalSession()
  const p=draft.value.payload.package.signedPayload,all=p.sampleSlots.flatMap(slot=>attachmentRows.value[slot.sampleSlotId]??[]).filter(item=>item.status!=='deleted_tombstone')
  if(all.some(item=>item.status!=='uploaded_staged'||!item.receiptId))throw new Error('ATTACHMENTS_NOT_READY')
  let local=await submissionOutbox.findLatestForRound(roundId)
  if(!local||['invalid','rejected'].includes(local.status)){
    if(!await authorizeDraftMutation())throw new Error('SUBMISSION_GATE_CLOSED')
    try{local=await withFieldDraftLock(draft.value.id,async()=>{if(submissionFrozen.value)throw new Error('SUBMISSION_GATE_CLOSED');const latest=(await database!.snapshot()).drafts.find(item=>item.id===draft.value!.id) as FieldTaskDraft;submissionStatus.value='queued';return submissionOutbox!.create(latest,all.map(item=>item.receiptId!))})}
    catch(error){submissionStatus.value='idle';throw error}
  }
  submissionStatus.value=local.status
  local=await syncSubmission(submissionOutbox,local.clientSubmissionId,{
    create:async item=>{const body=await submissionBody(item),path=`/api/rounds/${encodeURIComponent(item.roundId)}/mobile-submissions`,bodyHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(body))))].map(x=>x.toString(16).padStart(2,'0')).join(''),proof=await signedRequest({method:'POST',path,actor:item.ownerId,roundId:item.roundId,attachmentId:item.clientSubmissionId,hash:item.payloadHash,mime:'application/json',bodyHash,contentRevision:item.draftRevision});return api.createMobileSubmission(item.roundId,body,proof)},
    query:itemId=>api.getMobileSubmission(itemId),
  });submissionStatus.value=local.status
}
async function refreshConfirmation(){if(!navigator.onLine||!currentUser.value||!draft.value)return;const roundId=assertCanonicalSession();try{confirmationSnapshot.value=await api.getMobileConfirmation(roundId);if(confirmationSnapshot.value?.status)submissionStatus.value=confirmationSnapshot.value.status}catch(error:any){if(error?.response?.status===404)confirmationSnapshot.value=null;else throw error}}
async function confirmSubmission(password:string){if(!draft.value||!confirmationSnapshot.value||!currentUser.value)throw new Error('CONFIRMATION_GATE_CLOSED');const roundId=assertCanonicalSession(),id=String(confirmationSnapshot.value.clientSubmissionId),body={password},path=`/api/mobile-submissions/${encodeURIComponent(id)}/confirm`,bodyHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(body))))].map(x=>x.toString(16).padStart(2,'0')).join(''),proof=await signedRequest({method:'POST',path,actor:currentUser.value.username,roundId,attachmentId:id,mime:'application/json',bodyHash,contentRevision:Number(confirmationSnapshot.value.draftRevision)}),result=await api.confirmMobileSubmission(id,password,Number(confirmationSnapshot.value.draftRevision),proof);submissionStatus.value=result.status;if(result.status==='complete'){await persistTerminal('submitted');readonlyReason.value='已完成双人确认并取得正式回执；本机草稿保留为只读'}await refreshConfirmation();return result}
async function inviteConfirmation(intendedConfirmerId:string){if(!draft.value||!confirmationSnapshot.value||!currentUser.value)throw new Error('CONFIRMATION_GATE_CLOSED');const roundId=assertCanonicalSession(),id=String(confirmationSnapshot.value.clientSubmissionId),body={intendedConfirmerId},path=`/api/mobile-submissions/${encodeURIComponent(id)}/confirmation-invites`,bodyHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(body))))].map(x=>x.toString(16).padStart(2,'0')).join(''),proof=await signedRequest({method:'POST',path,actor:currentUser.value.username,roundId,attachmentId:id,mime:'application/json',bodyHash,contentRevision:Number(confirmationSnapshot.value.draftRevision)});return api.issueMobileConfirmationInvite(id,intendedConfirmerId,Number(confirmationSnapshot.value.draftRevision),proof)}

async function persistTerminal(terminal: DraftTerminalState) {
  terminalLatched = true
  editable.value = false
  if (authTimer) { clearInterval(authTimer); authTimer = undefined }
  if (!draft.value || !database) return
  try { await database.denyDraftAuthority(draft.value, terminal) }
  catch { readonlyReason.value = '本机安全存储不可用（storage_unavailable）；本页面保持闭锁，请勿关闭设备并联系管理员'; return }
  try {
    draft.value = await withFieldDraftLock(draft.value.id, () => database!.persistDraftTerminal!(draft.value!.id, terminal, Date.now())) as FieldTaskDraft
  } catch {
    readonlyReason.value = `本机任务已终止（${terminal}）；主草稿写入失败，授权注册表已拒绝写入`
  }
}

async function checkpointTrustedClock() {
  if (checkpointInFlight || !draft.value || !database?.checkpointDraftClockAtomic || submissionFrozen.value || !sessionMatchesRoute.value) return
  checkpointInFlight = true
  try {
    if (await refreshEditability()) draft.value = await withFieldDraftLock(draft.value.id, async () => {
      const latest = (await database!.snapshot()).drafts.find(item => item.id === draft.value!.id) as FieldTaskDraft
      if (!(await database!.draftWriteStatus(latest)).allowed) throw new Error('DRAFT_DENIED')
      return database!.checkpointDraftClockAtomic!(latest, latest.payload.draftRevision, Date.now()) as Promise<FieldTaskDraft>
    })
  } catch { editable.value = false; readonlyReason.value = '本机写入版本发生冲突；草稿保留为只读' }
  finally { checkpointInFlight = false }
}

async function renewPackageLocked(pkg: OfflineTaskPackage) {
  if (!draft.value || !database) return false
  draft.value = await withFieldDraftLock(draft.value.id, async () => {
    const latest = (await database!.snapshot()).drafts.find(item => item.id === draft.value!.id) as FieldTaskDraft
    if (!latest || !(await database!.draftWriteStatus(latest)).allowed || !renewalValid(latest, pkg)) throw new Error('DRAFT_RENEWAL_REJECTED')
    return database!.renewDraftAtomic!(latest, latest.payload.draftRevision, pkg) as Promise<FieldTaskDraft>
  })
  return true
}

async function refreshFromServer() {
  if (!navigator.onLine || !currentUser.value || !database) return
  try {
    const requestedRoundId=sessionRoundId.value||routeRoundId.value
    if(sessionRoundId.value&&!sessionMatchesRoute.value)throw new Error('FIELD_SESSION_MISMATCH')
    const pkg = await api.getOfflineTaskPackage(requestedRoundId)
    if (!await verifyOfflineTaskPackage(pkg, publicKeyPem)) { makeReadonly('signature_invalid'); return }
    if(pkg.signedPayload.roundId!==requestedRoundId){loadError.value='服务器任务包身份与网址不一致；已阻断打开';confirmationSnapshot.value=null;return}
    if (draft.value) {
      const authority = await database.draftWriteStatus(draft.value)
      if (!authority.allowed) { terminalLatched = true; editable.value = false; readonlyReason.value = `本机任务已终止（${authority.reason || 'authority_missing'}）`; return }
      const conflict = reconcileTaskDraft(draft.value, pkg)
      if (!conflict.editable) {
        const prior=draft.value;await persistTerminal('conflict')
        if(draft.value&&database.rebuildConflictedDraftAtomic&&pkg.signedPayload.taskVersionOrdinal>prior.payload.package.signedPayload.taskVersionOrdinal){
          try{const rebuilt=await database.rebuildConflictedDraftAtomic(draft.value,pkg);draft.value=rebuilt.replacement as FieldTaskDraft;terminalLatched=false;sessionEnded=false;recoveryNotice.value=`旧草稿已只读封存；可从 ${rebuilt.copyCandidates.rows.length} 条旧记录中人工复制需要的值。`;await refreshEditability();return}catch{makeReadonly(conflict.reason);return}
        }
        makeReadonly(conflict.reason); return
      }
      if (!renewalValid(draft.value, pkg)) return
      await renewPackageLocked(pkg)
    } else {
      draft.value = await database.installDraftAtomic!(pkg) as FieldTaskDraft
    }
    if(!bindSignedSession(draft.value))return
    await refreshEditability()
    await enableAttachmentOutbox()
    await refreshConfirmation()
  } catch (error: any) {
    const code=error?.response?.data?.error_code
    if(draft.value&&(code==='RULE_VERSION_RETIRED'||code==='TASK_VERSION_CONFLICT')){await persistTerminal('conflict');makeReadonly(code==='RULE_VERSION_RETIRED'?'rule_version_changed':'task_version_changed')}
    else if (draft.value && (error?.response?.status === 403 || error?.response?.status === 404)) { await persistTerminal('revoked'); makeReadonly('assignment_changed') }
    else if (draft.value) await refreshEditability()
    else loadError.value = '任务包未获授权下载；生产门槛、规则批准或受管设备证明尚未通过。'
  }
}

async function openTask() {
  const locatorId = currentUser.value?.username ?? await verifyStoredRecoveryCredential()
  if (!locatorId) { loadError.value = '无法定位本机任务包；恢复身份只用于定位，不授予写入权限。'; return }
  database = createIndexedDbOfflineDatabase(locatorId)
  if (!database) { loadError.value = '本机安全存储不可用；没有删除任何草稿。'; return }
  submissionOutbox = new SubmissionOutbox(locatorId, indexedDB)
  const local = (await database.snapshot()).drafts.find(item => item.id === `${routeRoundId.value}:HJ-TC-136`) as FieldTaskDraft | undefined
  if (local) {
    draft.value = local
    if(!bindSignedSession(local))return
    const existingSubmission=await submissionOutbox.findLatestForRound(sessionRoundId.value);if(existingSubmission)submissionStatus.value=existingSubmission.status
    await refreshEditability()
    await enableAttachmentOutbox()
  }
  if (currentUser.value && navigator.onLine) await refreshFromServer()
  else if (!local) loadError.value = '本机没有这个任务包；请登录并联网完成授权下载。'
}

function connectivityChanged() {
  online.value = navigator.onLine
  if (online.value && currentUser.value) void refreshFromServer()
}

onMounted(async () => {
  try { await openTask() } catch { loadError.value = '本机草稿读取失败；没有删除任何草稿。' }
  finally { loading.value = false }
  window.addEventListener('online', connectivityChanged)
  window.addEventListener('offline', connectivityChanged)
  if (!terminalLatched && navigator.locks) authTimer = setInterval(() => { void checkpointTrustedClock() }, 1000)
  unsubscribeLogout = subscribeAuthLogout(() => { sessionEnded = true; void persistTerminal('logout'); editable.value = false; readonlyReason.value = '已退出登录；草稿保留为只读' })
})
onBeforeUnmount(() => {
  window.removeEventListener('online', connectivityChanged)
  window.removeEventListener('offline', connectivityChanged)
  if (authTimer) clearInterval(authTimer)
  unsubscribeLogout?.()
})
watch(currentUser, user => {
  if (startedAuthenticated && !user) { sessionEnded = true; void persistTerminal('logout'); editable.value = false; readonlyReason.value = '已退出登录；草稿保留为只读' }
})
watch(routeRoundId, next => {
  if(sessionRoundId.value&&next!==sessionRoundId.value){confirmationSnapshot.value=null;editable.value=false;readonlyReason.value='网址任务与本机签名任务不一致；本页面已闭锁，请返回任务列表重新进入'}
})

async function saveField(command: { scope: 'global' | 'row'; field: string; sampleSlotId?: string; value: unknown; baseValue: unknown; expectedRevision: number }) {
  if (!database || !draft.value || !await authorizeDraftMutation()) throw new Error('DRAFT_READONLY')
  const wallTime = Date.now()
  const { expectedRevision: _ignoredRevision, ...fieldCommand } = command
  const next = await withFieldDraftLock(draft.value.id, async () => {
    if(submissionFrozen.value||!sessionMatchesRoute.value)throw new Error('DRAFT_FROZEN')
    const latest = (await database!.snapshot()).drafts.find(item => item.id === draft.value!.id) as FieldTaskDraft
    if (!(await database!.draftWriteStatus(latest)).allowed) throw new Error('DRAFT_DENIED')
    return database!.saveDraftAtomic!(latest, command.expectedRevision, { ...fieldCommand, savedAt: new Date(wallTime).toISOString(), wallTime }) as Promise<FieldTaskDraft>
  })
  draft.value = next
  return next
}
</script>

<template>
  <p v-if="loading" class="field-task-message">正在验证并打开本机任务…</p>
  <section v-else-if="loadError" class="field-task-message field-task-message--error" role="alert">
    <p>{{ loadError }}</p>
    <a href="/login">返回登录并重新授权</a>
  </section>
  <FieldTaskWorkbench v-else-if="draft" :draft="draft" :online="online" :editable="effectiveEditable" :readonly-reason="readonlyReason || (submissionFrozen ? '当前修订已冻结；等待服务器确认或永久回执' : '')" :recovery-notice="recoveryNotice" :authorize="authorizeDraftMutation" :save-field="saveField" :attachment-controller="attachmentOutbox ? createAttachmentController() : undefined" :submission-controller="submissionOutbox ? { status: submissionStatus, prepare: prepareSubmission } : undefined" :confirmation-controller="confirmationSnapshot ? { snapshot: confirmationSnapshot, confirm: confirmSubmission, invite: inviteConfirmation } : undefined" />
</template>

<style scoped>
.field-task-message { min-height: 100vh; margin: 0; padding: 32px; background: #f3f0ea; color: #1e2329; font: 600 16px/1.5 "Source Han Sans SC", "Noto Sans SC", "PingFang SC", sans-serif; color-scheme: light; }
.field-task-message--error { color: #b42318; }
.field-task-message p { max-width: 720px; margin: 0 0 20px; }
.field-task-message a { display:inline-flex;min-height:48px;align-items:center;padding:0 18px;border-radius:8px;background:#4f46e5;color:#fff;text-decoration:none;font-weight:700; }
.field-task-message a:focus-visible { outline:3px solid #7c75f2;outline-offset:3px; }
</style>
