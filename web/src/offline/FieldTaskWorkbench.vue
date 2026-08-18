<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { FieldTaskDraft } from './fieldTaskDraft'
import { recoveryActionFor, recoveryText } from './mobileRecovery'
import { assessFieldReadiness, departureMilestones, requestOneShotLocation, type LocationEvidence } from './fieldReadiness'

type SaveCommand = { scope: 'global' | 'row'; field: string; sampleSlotId?: string; value: unknown; baseValue: unknown; expectedRevision: number }
type AttachmentView = { attachmentId: string; status: string; size: number }
type AttachmentController = { enabled: boolean; list: (sampleSlotId: string) => AttachmentView[]; add: (sampleSlotId: string, file: File) => Promise<void>; retry: (sampleSlotId: string, attachmentId: string) => Promise<void>; remove: (sampleSlotId: string, attachmentId: string, confirmed: boolean) => Promise<void>; startUpload: (sampleSlotId: string) => Promise<void> }
type SubmissionController = { status: string; prepare: () => Promise<void> }
type ConfirmationController = { snapshot: { summaryHash:string;taskVersion:string;ruleVersion:string;draftRevision:number;confirmedBy:string[];assignedIds?:string[] }; confirm:(password:string)=>Promise<unknown>; invite?:(intendedConfirmerId:string)=>Promise<{qrPayload:string;expiresAt:string}> }
const props = defineProps<{
  draft: FieldTaskDraft; online: boolean; editable: boolean; readonlyReason?: string; recoveryNotice?: string
  authorize: () => Promise<boolean>
  saveField: (command: SaveCommand) => Promise<FieldTaskDraft>
  attachmentController?: AttachmentController
  submissionController?: SubmissionController
  confirmationController?: ConfirmationController
}>()

const globalFields = reactive<Record<string, any>>({ ...props.draft.payload.global })
const rows = reactive<any[]>(props.draft.payload.rows.map(row => ({ ...row })))
const revision = ref(props.draft.payload.draftRevision)
const savedAt = ref(props.draft.payload.localSavedAt ?? props.draft.updatedAt)
const saving = ref(false)
const preparingSubmission = ref(false)
const submissionError = ref('')
const confirmationPassword=ref('')
const confirming=ref(false)
const invitee=ref('')
const inviteResult=ref<{qrPayload:string;expiresAt:string}|null>(null)
const plannedEndAt=ref('')
const readinessResult=ref<{ready:boolean;reasons:string[]}|null>(null)
const locationEvidence=ref<LocationEvidence|null>(null)
const locationNote=ref('')
const saveError = ref('')
let saveQueue = Promise.resolve()
let lastCommand: Omit<SaveCommand, 'expectedRevision' | 'baseValue'> | null = null

watch(() => props.draft, next => {
  Object.assign(globalFields, next.payload.global)
  rows.splice(0, rows.length, ...next.payload.rows.map(row => ({ ...row })))
  revision.value = next.payload.draftRevision
  savedAt.value = next.payload.localSavedAt ?? next.updatedAt
})
const savedTime = computed(() => {
  const parsed = new Date(savedAt.value)
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleTimeString('zh-CN', { hour12: false }) : '尚未保存'
})

function persistedValue(command: Omit<SaveCommand, 'expectedRevision' | 'baseValue'>) { return command.scope === 'global' ? props.draft.payload.global[command.field] : (props.draft.payload.rows.find(row => row.sampleSlotId === command.sampleSlotId) as Record<string, unknown> | undefined)?.[command.field] }
function enqueue(command: Omit<SaveCommand, 'expectedRevision' | 'baseValue'>) {
  lastCommand = command
  const baseValue = persistedValue(command)
  saveQueue = saveQueue.then(async () => {
    saving.value = true
    saveError.value = ''
    if (!await props.authorize()) throw new Error('DRAFT_READONLY')
    const next = await props.saveField({ ...command, baseValue, expectedRevision: revision.value })
    revision.value = next.payload.draftRevision
    savedAt.value = next.payload.localSavedAt ?? next.updatedAt
  }).catch(() => { saveError.value = '本机保存失败或授权已失效；草稿未被覆盖，请检查只读原因。' })
    .finally(() => { saving.value = false })
  return saveQueue
}
async function flushCurrent() {
  await saveQueue
  await enqueue(lastCommand ?? { scope: 'global', field: 'org', value: globalFields.org })
}
function attachments(sampleSlotId: string) { return props.attachmentController?.list(sampleSlotId) ?? [] }
function uploadedCount(sampleSlotId: string) { return attachments(sampleSlotId).filter(x => x.status === 'uploaded_staged').length }
const statusText: Record<string, string> = { local_saved: '已保存本机', queued: '待上传', uploading: '正在上传整个文件', uploaded_staged: '已上传暂存', retryable_error: '上传失败，可整个文件重试', invalid: '文件无效', auth_required: '需要重新登录', rejected: '服务器拒绝', deleted_tombstone: '已删除（留痕）', storage_error: '本机存储错误' }
async function pickFile(sampleSlotId: string, event: Event) { const file = (event.target as HTMLInputElement).files?.[0]; if (file && props.attachmentController?.enabled) await props.attachmentController.add(sampleSlotId, file) }
function confirmAttachmentDelete(){return window.confirm('确定删除这张未正式提交的照片吗？删除会保留审计记录。')}
const submissionText = computed(() => ({ queued:'尚未创建服务端提交', submitting:'正在创建服务端提交', unknown_commit:'正在确认服务器结果，请勿重复操作', pending:'服务端已接收，等待冻结与确认', finalizing:'服务端正在完成提交', complete:'已取得永久服务端回执', invalid:'提交内容需要修正', rejected:'服务器已拒绝提交' } as Record<string,string>)[props.submissionController?.status ?? 'queued'] ?? '尚未创建服务端提交')
async function prepareSubmission(){if(!props.submissionController||preparingSubmission.value)return;preparingSubmission.value=true;submissionError.value='';try{await props.submissionController.prepare()}catch(error:any){submissionError.value=error?.message==='ATTACHMENTS_NOT_READY'?'仍有照片未完成安全暂存；本机草稿和照片均已保留。':error?.message==='SUBMISSION_RECEIPT_MISMATCH'?'服务器回执与本机内容不一致，已阻断并保留本机数据。':recoveryText(recoveryActionFor(error))}finally{preparingSubmission.value=false}}
async function confirmFrozenSnapshot(){if(!props.confirmationController||!confirmationPassword.value||confirming.value)return;confirming.value=true;submissionError.value='';try{await props.confirmationController.confirm(confirmationPassword.value);confirmationPassword.value=''}catch(error){submissionError.value=recoveryText(recoveryActionFor(error))}finally{confirming.value=false}}
async function createConfirmationInvite(){if(!props.confirmationController?.invite||!invitee.value||confirming.value)return;confirming.value=true;submissionError.value='';try{inviteResult.value=await props.confirmationController.invite(invitee.value)}catch(error){submissionError.value=recoveryText(recoveryActionFor(error))}finally{confirming.value=false}}
async function checkReadiness(){const p=props.draft.payload.package.signedPayload;let cameraReady=false;try{const stream=await navigator.mediaDevices?.getUserMedia({video:{facingMode:'environment'}});cameraReady=!!stream;stream?.getTracks().forEach(track=>track.stop())}catch{cameraReady=false}let storageReady=false;try{const estimate=await navigator.storage?.estimate(),persisted=await navigator.storage?.persisted();storageReady=!!props.attachmentController?.enabled&&persisted===true&&Number.isFinite(estimate?.quota)&&Number.isFinite(estimate?.usage)&&Number(estimate!.quota)>0&&Number(estimate!.usage)/Number(estimate!.quota)<.8}catch{storageReady=false}readinessResult.value=assessFieldReadiness({packageValid:p.formCode==='HJ-TC-136'&&!!props.draft.payload.package.signature,hasAllSlots:p.sampleSlots.length>0&&p.sampleSlots.every(slot=>!!slot.sampleSlotId&&!!slot.qrPayload),storageReady,cameraReady,authorizationExpiresAt:p.authorization.expiresAt,plannedEndAt:new Date(plannedEndAt.value).toISOString()})}
async function captureLocation(){locationEvidence.value=await requestOneShotLocation(navigator.geolocation)}
const requiredFieldsComplete=computed(()=>Object.entries(globalFields).every(([key,value])=>key==='orgSign'||String(value??'').trim())&&rows.every(row=>['sampleNo','point','time','item','volume','preserve'].every(field=>String(row[field]??'').trim())))
const attachmentsComplete=computed(()=>rows.every(row=>attachments(row.sampleSlotId).length>0&&attachments(row.sampleSlotId).every(file=>file.status==='uploaded_staged')))
const milestones=computed(()=>departureMilestones({requiredFieldsComplete:requiredFieldsComplete.value,attachmentsComplete:attachmentsComplete.value,localSaved:!saving.value,confirmationCount:props.confirmationController?.snapshot.confirmedBy.length??0,submissionStatus:props.submissionController?.status??'queued'}))
const availableInvitees=computed(()=>{const snapshot=props.confirmationController?.snapshot;if(!snapshot)return[];return(snapshot.assignedIds??[]).filter(id=>!snapshot.confirmedBy.includes(id))})
</script>

<template>
  <main data-testid="field-workbench" class="field-workbench field-workbench--light">
    <aside class="task-rail" aria-label="任务与样品槽位">
      <p class="eyebrow">现场采样任务</p><h1>{{ draft.payload.package.signedPayload.roundId }}</h1>
      <p class="status" :class="online ? 'status--online' : 'status--offline'">{{ online ? '网络可用' : '离线工作' }}</p>
      <p class="version">HJ-TC-136 · {{ draft.payload.package.signedPayload.ruleVersion }}</p>
      <h2>样品槽位</h2><ol><li v-for="row in rows" :key="row.sampleSlotId"><strong>{{ row.sampleSlotId }}</strong></li></ol>
    </aside>
    <section class="work-surface" aria-labelledby="form-title">
      <header><div><p class="eyebrow">首张冻结表</p><h2 id="form-title">水和废水采样原始记录表</h2></div>
        <div class="save-state" aria-live="polite"><strong>{{ saving ? '正在保存到本机' : '已保存到本机' }}</strong><span>最近成功 {{ savedTime }}</span></div></header>
      <div v-if="!editable" data-testid="readonly-reason" class="readonly-notice" role="status"><strong>当前只读</strong>：{{ readonlyReason || '离线授权已失效' }}。草稿仍保留在本机，不会自动清除。</div>
      <div v-if="recoveryNotice" class="readonly-notice" role="status">{{ recoveryNotice }}</div>
      <div v-if="saveError" class="save-error" role="alert">{{ saveError }}</div>
      <section class="submission-status" aria-labelledby="readiness-title"><h3 id="readiness-title">出发前离线准备</h3><label>计划最晚结束时间<input data-testid="planned-end" v-model="plannedEndAt" type="datetime-local" /></label><button type="button" class="secondary-action" :disabled="!plannedEndAt" @click="checkReadiness">检查离线准备</button><p v-if="readinessResult" data-testid="readiness-result">{{ readinessResult.ready?'已准备：任务包、样品槽位、本机存储、相机能力和授权时长均满足。':`尚未准备：${readinessResult.reasons.join('、')}` }}</p></section>
      <section v-if="submissionController" class="submission-status" aria-labelledby="submission-title">
        <h3 id="submission-title">提交与确认</h3><p aria-live="polite">{{ submissionText }}</p>
        <p v-if="submissionError" data-testid="submission-error" class="save-error" role="alert">{{ submissionError }}</p>
        <button data-testid="prepare-submission" type="button" class="secondary-action" :disabled="!online || !editable || preparingSubmission || submissionController.status==='complete'" @click="prepareSubmission">{{ preparingSubmission ? '正在处理' : ['unknown_commit','pending','finalizing'].includes(submissionController.status) ? '查询提交状态' : '创建待确认提交' }}</button>
        <p>此动作不会跳过规则重验、双人确认或正式编号步骤。</p>
      </section>
      <section v-if="confirmationController" class="submission-status" aria-labelledby="confirmation-title"><h3 id="confirmation-title">冻结快照双人确认</h3><p>摘要 {{ confirmationController.snapshot.summaryHash }}</p><p>任务 {{ confirmationController.snapshot.taskVersion }} · 规则 {{ confirmationController.snapshot.ruleVersion }} · 草稿修订 {{ confirmationController.snapshot.draftRevision }}</p><p>已确认 {{ confirmationController.snapshot.confirmedBy.length }} / 2 人。请当前登录人员独立核对后重新输入自己的密码。</p><label>当前人员密码<input data-testid="confirmation-password" v-model="confirmationPassword" type="password" autocomplete="current-password" /></label><button data-testid="confirm-frozen-snapshot" type="button" class="secondary-action" :disabled="!online||confirming||!confirmationPassword" @click="confirmFrozenSnapshot">{{ confirming?'正在确认':'确认冻结快照' }}</button><template v-if="confirmationController.invite"><label>邀请另一名采样员<select v-model="invitee"><option value="">请选择</option><option v-for="id in availableInvitees" :key="id" :value="id">{{ id }}</option></select></label><button data-testid="create-confirmation-invite" type="button" class="secondary-action" :disabled="!online||confirming||!invitee" @click="createConfirmationInvite">生成第二设备确认码</button><div v-if="inviteResult" class="invite-code" data-testid="confirmation-invite-code"><strong>{{ inviteResult.qrPayload }}</strong><span>10 分钟内有效；只含一次性随机令牌，不含客户或样品信息。</span></div></template></section>

      <div class="field-grid global-fields">
        <label>受检单位名称<input data-testid="field-org" v-model="globalFields.org" :disabled="!editable" @input="enqueue({scope:'global',field:'org',value:globalFields.org})" /></label>
        <label>受检单位签字<input data-testid="field-org-sign" v-model="globalFields.orgSign" :disabled="!editable" @input="enqueue({scope:'global',field:'orgSign',value:globalFields.orgSign})" /></label>
        <label>采样日期<input data-testid="field-sampling-date" :value="globalFields.samplingDate" disabled /></label>
      </div>

      <article v-for="(row, index) in rows" :key="row.sampleSlotId" class="sample-row">
        <h3>样品槽位 {{ index + 1 }} <span>{{ row.sampleSlotId }}</span></h3>
        <div class="field-grid">
          <label>样品编号<input :data-testid="`row-${index}-sampleNo`" v-model="row.sampleNo" :disabled="!editable" @input="enqueue({scope:'row',sampleSlotId:row.sampleSlotId,field:'sampleNo',value:row.sampleNo})" /></label>
          <label>检测点位<input :data-testid="`row-${index}-point`" v-model="row.point" :disabled="!editable" @input="enqueue({scope:'row',sampleSlotId:row.sampleSlotId,field:'point',value:row.point})" /></label>
          <label>采样时间<input type="time" v-model="row.time" :disabled="!editable" @input="enqueue({scope:'row',sampleSlotId:row.sampleSlotId,field:'time',value:row.time})" /></label>
          <label>检测项目<input v-model="row.item" :disabled="!editable" @input="enqueue({scope:'row',sampleSlotId:row.sampleSlotId,field:'item',value:row.item})" /></label>
          <label>采样体积 (ml)<input inputmode="decimal" v-model="row.volume" :disabled="!editable" @input="enqueue({scope:'row',sampleSlotId:row.sampleSlotId,field:'volume',value:row.volume})" /></label>
          <label>保存容器及方法<input v-model="row.preserve" :disabled="!editable" @input="enqueue({scope:'row',sampleSlotId:row.sampleSlotId,field:'preserve',value:row.preserve})" /></label>
          <label>水色<input v-model="row.waterColor" :disabled="!editable" @input="enqueue({scope:'row',sampleSlotId:row.sampleSlotId,field:'waterColor',value:row.waterColor})" /></label>
          <label>气味<input v-model="row.smell" :disabled="!editable" @input="enqueue({scope:'row',sampleSlotId:row.sampleSlotId,field:'smell',value:row.smell})" /></label>
          <label>浮油<input v-model="row.oil" :disabled="!editable" @input="enqueue({scope:'row',sampleSlotId:row.sampleSlotId,field:'oil',value:row.oil})" /></label>
          <label>漂浮物<input v-model="row.floating" :disabled="!editable" @input="enqueue({scope:'row',sampleSlotId:row.sampleSlotId,field:'floating',value:row.floating})" /></label>
          <label>其他异常现象<input v-model="row.anomaly" :disabled="!editable" @input="enqueue({scope:'row',sampleSlotId:row.sampleSlotId,field:'anomaly',value:row.anomaly})" /></label>
          <label class="field-wide">备注<textarea v-model="row.note" :disabled="!editable" @input="enqueue({scope:'row',sampleSlotId:row.sampleSlotId,field:'note',value:row.note})" /></label>
        </div>
        <section class="attachment-card" :aria-labelledby="`attachment-title-${index}`">
          <h4 :id="`attachment-title-${index}`">照片与附件</h4>
          <p v-if="!attachmentController?.enabled" class="attachment-gate">敏感照片本机保存尚未通过设备门禁；现有草稿不受影响。</p>
          <label class="attachment-picker">拍摄或选择照片<input :data-testid="`attachment-input-${index}`" type="file" accept="image/jpeg,image/png,image/webp,image/heic" capture="environment" :disabled="!editable || !attachmentController?.enabled" @change="pickFile(row.sampleSlotId,$event)" /></label>
          <p v-if="attachmentController?.enabled" class="attachment-summary">已暂存 {{ uploadedCount(row.sampleSlotId) }} / {{ attachments(row.sampleSlotId).length }} 个文件。进度按文件计，不显示单文件百分比。</p>
          <ul v-if="attachmentController?.enabled" class="attachment-list"><li v-for="file in attachments(row.sampleSlotId)" :key="file.attachmentId"><span>{{ file.attachmentId }} · {{ statusText[file.status] || file.status }}</span><button v-if="file.status==='retryable_error'" type="button" :disabled="!editable" @click="attachmentController?.retry(row.sampleSlotId,file.attachmentId)">整个文件重试</button><button type="button" :disabled="!editable" @click="attachmentController?.remove(row.sampleSlotId,file.attachmentId,confirmAttachmentDelete())">删除</button></li></ul>
          <button v-if="online && attachmentController?.enabled && attachments(row.sampleSlotId).some(x=>['local_saved','queued','retryable_error','auth_required'].includes(x.status))" type="button" class="secondary-action" :disabled="!editable" :aria-disabled="!editable" @click="attachmentController.startUpload(row.sampleSlotId)">准备同步文件</button>
          <p v-if="attachmentController?.enabled">文件上传只进入服务器暂存区，不会自动正式提交记录。</p>
        </section>
      </article>
      <section class="submission-status departure-check" aria-labelledby="departure-title"><h3 id="departure-title">离场检查</h3><ul><li :class="{done:milestones.localComplete}">本机采集完成：{{ milestones.localComplete?'完成':'未完成' }}</li><li :class="{done:milestones.confirmationComplete}">双人确认完成：{{ milestones.confirmationComplete?'完成':'未完成' }}</li><li :class="{done:milestones.formalSubmissionComplete}">正式提交完成：{{ milestones.formalSubmissionComplete?'完成':'未完成' }}</li></ul><p>这三个状态独立显示；本机完成不会被误写成已正式提交。</p><button data-testid="capture-location" type="button" class="secondary-action" @click="captureLocation">主动记录一次位置</button><p v-if="locationEvidence">定位结果：{{ locationEvidence.status }}<template v-if="locationEvidence.accuracy"> · 精度约 {{ Math.round(locationEvidence.accuracy) }} 米</template></p><label v-if="locationEvidence&&locationEvidence.status!=='captured'">定位说明（拒绝、超时或精度不足时可填写）<textarea v-model="locationNote" placeholder="例如：厂房内无卫星信号，已核对门牌和点位标识" /></label><p>定位失败不会阻断“保存本机”，系统不会后台持续跟踪。</p></section>
      <footer><button data-primary-action="true" type="button" :disabled="!editable" @click="flushCurrent">保存本机</button></footer>
    </section>
  </main>
</template>

<style scoped>
.field-workbench{min-height:100vh;display:grid;grid-template-columns:300px minmax(0,1fr);background:#f3f0ea;color:#1e2329;font-family:"Source Han Sans SC","Noto Sans SC","PingFang SC",sans-serif;color-scheme:light}.task-rail{padding:24px;border-right:1px solid #cbc5ba;background:#e9e5dd}.eyebrow{margin:0 0 8px;color:#62676e;font-size:14px;font-weight:600}h1,h2{margin:0 0 16px}.status{display:inline-flex;min-height:44px;align-items:center;padding:0 14px;border-radius:6px;font-weight:600}.status--offline{color:#8a4700;background:#fff1df}.status--online{color:#176b5b;background:#e8f4f0}.version,li span,.save-state span,h3 span{color:#62676e;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:14px}ol{padding:0;list-style:none}li{padding:12px 0;border-top:1px solid #cbc5ba}.work-surface{width:min(800px,calc(100% - 32px));margin:0 auto;padding:24px 0 112px}header{display:flex;justify-content:space-between;gap:24px;border-bottom:1px solid #cbc5ba}.save-state{display:grid;align-content:start;gap:4px;color:#176b5b;text-align:right}.readonly-notice,.save-error{margin:16px 0;padding:16px;border-left:4px solid #b05c00;background:#fff1df}.save-error{border-color:#b42318}.submission-status{margin:20px 0;padding:16px 0;border-top:1px solid #cbc5ba;border-bottom:1px solid #cbc5ba}.submission-status h3{margin:0}.field-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding-top:16px}.global-fields{padding:24px 0}.sample-row{padding:24px 0;border-top:1px solid #cbc5ba}.sample-row h3{margin:0}label{display:grid;gap:8px;font-weight:600}input,textarea{box-sizing:border-box;min-height:48px;width:100%;padding:12px;border:1px solid #cbc5ba;border-radius:6px;background:#fffefc;color:#1e2329;font:inherit}input:focus,textarea:focus{outline:3px solid #7c75f2;outline-offset:1px}input:disabled,textarea:disabled{background:#e9e5dd;color:#62676e}.field-wide{grid-column:1/-1}.attachment-card{margin-top:24px;padding:16px;border:1px solid #cbc5ba;border-radius:8px;background:#fffefc}.attachment-card h4{margin:0 0 12px}.attachment-gate{padding:12px;border-left:4px solid #b05c00;background:#fff1df}.attachment-picker input{min-height:48px}.attachment-list{padding:0;list-style:none}.attachment-list li{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.attachment-list button,.secondary-action{min-width:120px;min-height:44px;background:#e9e5dd;color:#1e2329;border:1px solid #a9a297}footer{position:sticky;bottom:0;display:flex;justify-content:flex-end;padding:16px 0 max(16px,env(safe-area-inset-bottom));background:#f3f0ea}button{min-width:160px;min-height:52px;border:0;border-radius:7px;background:#4f46e5;color:#fff;font:inherit;font-weight:700}button:disabled{opacity:.55}@media(max-width:760px){.field-workbench{display:block}.task-rail{border-right:0;border-bottom:1px solid #cbc5ba}.work-surface{padding-top:20px}header{display:grid}.save-state{text-align:left}.field-grid{grid-template-columns:1fr}.field-wide{grid-column:auto}footer button{width:100%}}@media(prefers-color-scheme:dark){.field-workbench{background:#f3f0ea;color:#1e2329}.task-rail{background:#e9e5dd}.attachment-card,input,textarea{background:#fffefc;color:#1e2329}}
.submission-status select{box-sizing:border-box;min-height:48px;width:100%;padding:12px;border:1px solid #cbc5ba;border-radius:6px;background:#fffefc;color:#1e2329;font:inherit}.invite-code{display:grid;gap:8px;margin-top:12px;padding:12px;background:#e8f4f0;overflow-wrap:anywhere}
</style>
