<script setup lang="ts">
import { onMounted, reactive, watch } from 'vue'
import {
  api, currentUser, PROFESSIONAL_SCOPES, PROFESSIONAL_SCOPE_LABEL,
  type ProfessionalScope, type WorkflowAssignment, type WorkflowCandidate,
} from '../api'
import { todayLocal } from '../utils/date'

const props = withDefaults(defineProps<{
  contractId: string
  assignments: WorkflowAssignment[]
  effectiveDate?: string
  scopes?: ProfessionalScope[]
}>(), { effectiveDate: () => todayLocal(), scopes: () => [...PROFESSIONAL_SCOPES] })
const emit = defineEmits<{ saved: [assignment: WorkflowAssignment] }>()

type Choice = { reviewerUsername: string; approverUsername: string; reason: string }
const choices = reactive<Record<ProfessionalScope, Choice>>({
  sampling: { reviewerUsername: '', approverUsername: '', reason: '' },
  quality: { reviewerUsername: '', approverUsername: '', reason: '' },
  laboratory: { reviewerUsername: '', approverUsername: '', reason: '' },
  report: { reviewerUsername: '', approverUsername: '', reason: '' },
})
const candidates = reactive<Record<ProfessionalScope, { review: WorkflowCandidate[]; approve: WorkflowCandidate[] }>>({
  sampling: { review: [], approve: [] }, quality: { review: [], approve: [] },
  laboratory: { review: [], approve: [] }, report: { review: [], approve: [] },
})
const errors = reactive<Record<ProfessionalScope, string>>({ sampling: '', quality: '', laboratory: '', report: '' })
const busy = reactive<Record<ProfessionalScope, boolean>>({ sampling: false, quality: false, laboratory: false, report: false })

function syncAssignments() {
  for (const scope of props.scopes) {
    const assignment = props.assignments.find(item => item.scope === scope)
    if (!assignment) continue
    choices[scope].reviewerUsername = assignment.reviewer_username
    choices[scope].approverUsername = assignment.approver_username
  }
}

async function loadScope(scope: ProfessionalScope) {
  errors[scope] = ''
  try {
    const [review, approve] = await Promise.all([
      api.listWorkflowCandidates(props.contractId, scope, 'review', props.effectiveDate),
      api.listWorkflowCandidates(props.contractId, scope, 'approve', props.effectiveDate),
    ])
    candidates[scope].review = review
    candidates[scope].approve = approve
  } catch (error: any) {
    errors[scope] = error?.response?.data?.error || error?.message || '候选人员加载失败'
  }
}

async function save(scope: ProfessionalScope) {
  if (busy[scope]) return
  const choice = choices[scope]
  if (!choice.reviewerUsername || !choice.approverUsername) {
    errors[scope] = '复核人和审核人都必须选择'
    return
  }
  const singleActorAcceptanceRequest = currentUser.value?.roles.includes('admin')
    && choice.reviewerUsername === currentUser.value.username
    && choice.approverUsername === currentUser.value.username
  if (choice.reviewerUsername === choice.approverUsername && !singleActorAcceptanceRequest) {
    errors[scope] = '复核人和审核人不能是同一账号'
    return
  }
  busy[scope] = true
  errors[scope] = ''
  try {
    const assignment = await api.setWorkflowAssignment(props.contractId, scope, {
      reviewerUsername: choice.reviewerUsername,
      approverUsername: choice.approverUsername,
      ...(choice.reason.trim() ? { reason: choice.reason.trim() } : {}),
    })
    emit('saved', assignment)
    choices[scope].reason = ''
    await loadScope(scope)
  } catch (error: any) {
    errors[scope] = error?.response?.data?.error || error?.message || '审核人员指定失败'
  } finally { busy[scope] = false }
}

watch(() => props.assignments, syncAssignments, { deep: true, immediate: true })
watch(() => [props.contractId, props.effectiveDate, props.scopes], () => { for (const scope of props.scopes) void loadScope(scope) })
onMounted(() => { for (const scope of props.scopes) void loadScope(scope) })
</script>

<template>
  <section class="assignment-editor" aria-label="专业复核与审核人员指定">
    <div class="heading">
      <div><h3>专业审核人员</h3><p>候选人按 {{ effectiveDate }} 当日有效资格筛选；复核与审核必须由不同账号承担。</p></div>
    </div>
    <p v-if="currentUser?.roles.includes('admin')" class="acceptance-note">单人验收模式开启时，可临时把当前管理员同时指定为复核人与审核人；服务端会校验验收账号和截止时间并记录豁免审计。</p>
    <div class="scope-grid">
      <fieldset v-for="scope in scopes" :key="scope" :data-assignment-scope="scope" tabindex="-1">
        <legend>{{ PROFESSIONAL_SCOPE_LABEL[scope] }}</legend>
        <label>复核人
          <select v-model="choices[scope].reviewerUsername" :data-reviewer="scope" :disabled="busy[scope]">
            <option value="">请选择</option>
            <option v-for="candidate in candidates[scope].review" :key="candidate.username" :value="candidate.username">{{ candidate.name }} · {{ candidate.username }}</option>
          </select>
        </label>
        <p v-if="!candidates[scope].review.length && !errors[scope]" class="empty">没有具备有效{{ PROFESSIONAL_SCOPE_LABEL[scope] }}复核资格且可与审核人分离的候选人</p>
        <label>审核人
          <select v-model="choices[scope].approverUsername" :data-approver="scope" :disabled="busy[scope]">
            <option value="">请选择</option>
            <option v-for="candidate in candidates[scope].approve" :key="candidate.username" :value="candidate.username">{{ candidate.name }} · {{ candidate.username }}</option>
          </select>
        </label>
        <p v-if="!candidates[scope].approve.length && !errors[scope]" class="empty">没有具备有效{{ PROFESSIONAL_SCOPE_LABEL[scope] }}审核资格且可与复核人分离的候选人</p>
        <p v-if="!candidates[scope].review.length || !candidates[scope].approve.length" class="qualification-help">
          <a v-if="currentUser?.roles.includes('admin')" href="/users" data-configure-qualifications>去「人员与权限」配置{{ PROFESSIONAL_SCOPE_LABEL[scope] }}复核/审核资格 →</a>
          <span v-else>请联系管理员配置{{ PROFESSIONAL_SCOPE_LABEL[scope] }}复核/审核资格</span>
        </p>
        <label>换人原因
          <input v-model="choices[scope].reason" :data-reason="scope" :disabled="busy[scope]" placeholder="首次指定可不填；换人时必填" />
        </label>
        <p v-if="errors[scope]" class="error" role="alert">{{ errors[scope] }}</p>
        <button type="button" :data-save-assignment="scope" :disabled="busy[scope]" @click="save(scope)">{{ busy[scope] ? '保存中…' : `保存${PROFESSIONAL_SCOPE_LABEL[scope]}指定` }}</button>
      </fieldset>
    </div>
  </section>
</template>

<style scoped>
.assignment-editor{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:16px 0;margin:16px 0}.heading h3{font-size:18px;margin:0;font-weight:650}.heading p{font-size:14px;color:var(--muted);margin:4px 0 0}.acceptance-note{font-size:14px;color:var(--warn);background:var(--warn-soft);border-left:3px solid var(--warn);padding:10px 12px;margin:12px 0 0}.scope-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:16px}fieldset{margin:0;border:1px solid var(--line);border-radius:10px;padding:14px;background:var(--surface);scroll-margin-block:24px}fieldset:focus{outline:2px solid var(--accent-ring);outline-offset:3px}legend{font-size:15px;font-weight:650;padding:0 6px}label{display:grid;gap:6px;margin:10px 0;font-size:14px;font-weight:500}select,input{box-sizing:border-box;width:100%;height:44px;border:1px solid var(--line);border-radius:6px;padding:0 10px;background:var(--surface);color:var(--ink);font:400 16px inherit}select:focus,input:focus{outline:2px solid var(--accent-ring);outline-offset:1px}.empty{font-size:12px;color:var(--warn);margin:-4px 0 8px}.qualification-help{font-size:13px;line-height:1.5;color:var(--muted);margin:8px 0 12px}.qualification-help a{display:inline-flex;align-items:center;min-height:44px;color:var(--accent);font-weight:600;text-decoration:none}.qualification-help a:hover{text-decoration:underline}.qualification-help a:focus-visible{outline:2px solid var(--accent-ring);outline-offset:2px}.error{font-size:13px;color:var(--crit);margin:8px 0}button{min-height:44px;width:100%;border:1px solid var(--accent);border-radius:7px;background:var(--accent);color:#fff;font:600 14px inherit;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}@media(max-width:760px){.scope-grid{grid-template-columns:1fr}}
</style>
