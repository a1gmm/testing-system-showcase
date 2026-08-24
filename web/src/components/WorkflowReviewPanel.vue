<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { WorkflowAssignment, WorkflowDecisionLevel, WorkflowView } from '../api'

const props = defineProps<{
  workflow: WorkflowView | null
  assignment?: WorkflowAssignment | null
  authorizedLevel?: WorkflowDecisionLevel | null
  actorUsername: string
  authorUsername?: string
  errorCode?: string
  errorMessage?: string
  qualificationProblem?: string
  qualificationActionLabel?: string
  busy?: boolean
}>()

const emit = defineEmits<{
  submit: []
  decide: [input: { revision: number; level: WorkflowDecisionLevel; decision: 'approve' | 'reject'; comment: string }]
  refresh: []
  'resolve-qualification-problem': []
}>()

const rejectionReason = ref('')
watch(() => props.workflow?.current_revision, () => { rejectionReason.value = '' })

const decisionLevel = computed<WorkflowDecisionLevel | null>(() => {
  if (!props.workflow) return null
  if (props.authorizedLevel === 'review' && props.workflow.status === 'pending_review') return 'review'
  if (props.authorizedLevel === 'approve' && props.workflow.status === 'pending_approval') return 'approve'
  if (!props.assignment) return null
  if (props.workflow.status === 'pending_review' && props.assignment.reviewer_username === props.actorUsername) return 'review'
  if (props.workflow.status === 'pending_approval' && props.assignment.approver_username === props.actorUsername) return 'approve'
  return null
})
const maySubmit = computed(() => {
  const status = props.workflow?.status
  return (!props.workflow || status === 'draft' || status === 'rejected' || status === 'withdrawn')
    && (props.workflow ? props.workflow.created_by === props.actorUsername : props.authorUsername === props.actorUsername)
})
const primaryLabel = computed(() => decisionLevel.value === 'review' ? '复核通过' : decisionLevel.value === 'approve' ? '审核通过' : maySubmit.value ? '提交复核' : '')
const statusLabel = computed(() => ({
  draft: '编制中', pending_review: '待复核', pending_approval: '待审核', approved: '已审核定稿', rejected: '已退回', withdrawn: '已撤回',
})[props.workflow?.status || 'draft'])
const visibleError = computed(() => props.errorCode === 'WORKFLOW_STALE_REVISION' ? '内容已有新版本，请刷新' : props.errorMessage || '')

function primary() {
  if (props.busy) return
  if (decisionLevel.value && props.workflow) {
    emit('decide', { revision: props.workflow.current_revision, level: decisionLevel.value, decision: 'approve', comment: '' })
  } else if (maySubmit.value) emit('submit')
}
function reject() {
  if (!decisionLevel.value || !props.workflow || !rejectionReason.value.trim() || props.busy) return
  emit('decide', {
    revision: props.workflow.current_revision,
    level: decisionLevel.value,
    decision: 'reject',
    comment: rejectionReason.value.trim(),
  })
}
</script>

<template>
  <section class="review-panel" aria-label="专业复核与审核">
    <div class="review-head">
      <div>
        <h3>专业复核与审核</h3>
        <p>{{ statusLabel }}<template v-if="workflow"> · 当前版本 {{ workflow.current_revision }}</template></p>
      </div>
      <span class="state" :class="workflow?.status">{{ statusLabel }}</span>
    </div>

    <div v-if="assignment" class="assignees">
      <span>指定复核人 <b class="mono">{{ assignment?.reviewer_username || '未指定' }}</b></span>
      <span>指定审核人 <b class="mono">{{ assignment?.approver_username || '未指定' }}</b></span>
    </div>
    <div v-if="qualificationProblem" class="attention" role="alert">
      <span>{{ qualificationProblem }}</span>
      <button v-if="qualificationActionLabel" type="button" data-qualification-action @click="$emit('resolve-qualification-problem')">{{ qualificationActionLabel }}</button>
    </div>
    <p v-if="visibleError" class="error" role="alert">
      {{ visibleError }}
      <button v-if="errorCode === 'WORKFLOW_STALE_REVISION'" type="button" @click="$emit('refresh')">刷新</button>
    </p>

    <div v-if="decisionLevel" class="decision">
      <label for="workflow-rejection">退回原因</label>
      <textarea id="workflow-rejection" v-model="rejectionReason" data-rejection-reason rows="2" placeholder="退回时必须说明需要修改的内容"></textarea>
      <div class="actions">
        <button type="button" data-reject-action class="secondary" :disabled="busy || !rejectionReason.trim()" @click="reject">退回修改</button>
        <button type="button" data-primary-action class="primary" :disabled="busy" @click="primary">{{ primaryLabel }}</button>
      </div>
    </div>
    <div v-else-if="primaryLabel && !qualificationProblem" class="actions single">
      <button type="button" data-primary-action class="primary" :disabled="busy || !!qualificationProblem" @click="primary">{{ primaryLabel }}</button>
    </div>

    <details v-if="workflow?.revisions.length" class="history">
      <summary>版本历史 · {{ workflow.revisions.length }} 个版本</summary>
      <ol>
        <li v-for="revision in [...workflow.revisions].reverse()" :key="revision.revision">
          <b>版本 {{ revision.revision }}</b>
          <span>{{ revision.submitted_by }} · {{ revision.submitted_at.slice(0, 16).replace('T', ' ') }}</span>
        </li>
      </ol>
    </details>
  </section>
</template>

<style scoped>
.review-panel{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0;color:var(--ink)}
.review-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;border-bottom:1px solid var(--line);padding-bottom:12px}
h3{font-size:18px;margin:0;font-weight:650}p{margin:4px 0 0;color:var(--muted);font-size:14px}.state{font-size:12px;border-radius:999px;padding:4px 9px;background:var(--surface-2);white-space:nowrap}.state.pending_review,.state.pending_approval{background:var(--warn-soft);color:var(--warn)}.state.approved{background:var(--good-soft);color:var(--good)}
.assignees{display:flex;flex-wrap:wrap;gap:8px 24px;padding:12px 0;font-size:14px}.mono{font-family:var(--font-mono);font-weight:600}.attention,.error{padding:10px 12px;border-radius:6px;margin:0 0 12px}.attention{display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--warn-soft);color:var(--warn);font-size:14px}.attention button{flex:none;min-height:44px;border:1px solid var(--warn);border-radius:7px;padding:0 14px;background:var(--surface);color:var(--warn);font:600 14px inherit;cursor:pointer}.attention button:focus-visible{outline:2px solid var(--accent-ring);outline-offset:2px}.error{background:#FDECEA;color:var(--crit)}.error button{margin-left:8px;border:0;background:transparent;color:inherit;text-decoration:underline;cursor:pointer}
.decision label{display:block;font-size:14px;font-weight:600;margin-bottom:8px}.decision textarea{box-sizing:border-box;width:100%;min-height:72px;border:1px solid var(--line);border-radius:6px;padding:10px 12px;background:var(--surface);color:var(--ink);font:400 16px/1.5 inherit}.decision textarea:focus{outline:2px solid var(--accent-ring);outline-offset:1px}
.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}.actions button{min-height:44px;border-radius:7px;padding:0 16px;font:600 14px inherit;cursor:pointer}.actions button:disabled{opacity:.5;cursor:not-allowed}.primary{border:1px solid var(--accent);background:var(--accent);color:#fff}.secondary{border:1px solid var(--line);background:var(--surface);color:var(--crit)}
.history{border-top:1px solid var(--line);margin-top:16px;padding-top:12px}.history summary{font-size:14px;font-weight:600;cursor:pointer}.history ol{list-style:none;padding:8px 0 0;margin:0}.history li{display:flex;gap:12px;justify-content:space-between;padding:8px 0;border-top:1px solid var(--line);font-size:13px}.history li span{color:var(--muted)}
@media (max-width:640px){.assignees,.attention{display:grid}.attention button{width:100%}.history li{display:grid;gap:2px}.actions{display:grid}.actions button{width:100%}}
</style>
