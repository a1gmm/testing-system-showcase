<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api, currentUser, type ProfessionalScope, type WorkflowDecisionLevel, type WorkflowTask, type WorkflowView } from '../api'
import type { StageQueueKey } from '../workflow/businessStages'
import WorkflowReviewPanel from './WorkflowReviewPanel.vue'

const props = defineProps<{
  scope: Extract<ProfessionalScope, 'sampling' | 'quality'>
  activeQueue: StageQueueKey
}>()

const loading = ref(false)
const detailLoading = ref(false)
const busy = ref(false)
const error = ref('')
const tasks = ref<WorkflowTask[]>([])
const selectedId = ref('')
const workflow = ref<WorkflowView | null>(null)
const displayedTaskId = ref('')
const displayedDetailToken = ref(0)
let detailRequestSequence = 0

const visibleTasks = computed(() => tasks.value.filter(task => task.decision_level === props.activeQueue))
const selected = computed(() => visibleTasks.value.find(task => task.workflow_instance_id === selectedId.value) || null)

async function selectTask(task: WorkflowTask) {
  const requestToken = ++detailRequestSequence
  selectedId.value = task.workflow_instance_id
  workflow.value = null
  displayedTaskId.value = ''
  displayedDetailToken.value = 0
  detailLoading.value = true
  error.value = ''
  try {
    const detail = await api.getWorkflow(task.subject_type, task.subject_id)
    if (requestToken !== detailRequestSequence || selectedId.value !== task.workflow_instance_id) return
    if (!detail || detail.id !== task.workflow_instance_id
      || detail.subject_type !== task.subject_type || detail.subject_id !== task.subject_id) {
      error.value = '任务详情与当前待办不匹配，请刷新后重试'
      return
    }
    error.value = ''
    workflow.value = detail
    displayedTaskId.value = task.workflow_instance_id
    displayedDetailToken.value = requestToken
  } catch (cause: any) {
    if (requestToken === detailRequestSequence && selectedId.value === task.workflow_instance_id) {
      error.value = cause?.response?.data?.error || cause?.message || '工作流加载失败'
    }
  } finally {
    if (requestToken === detailRequestSequence) detailLoading.value = false
  }
}

async function load() {
  loading.value = true
  detailRequestSequence += 1
  detailLoading.value = false
  selectedId.value = ''
  workflow.value = null
  displayedTaskId.value = ''
  displayedDetailToken.value = 0
  error.value = ''
  try {
    tasks.value = await api.listWorkflowTasks(props.scope)
    const first = visibleTasks.value[0]
    if (first) await selectTask(first)
    else { selectedId.value = ''; workflow.value = null }
  } catch (cause: any) {
    tasks.value = []
    workflow.value = null
    error.value = cause?.response?.data?.error || cause?.message || '专业待办加载失败'
  } finally { loading.value = false }
}

async function decide(input: { revision: number; level: WorkflowDecisionLevel; decision: 'approve' | 'reject'; comment: string }) {
  const task = selected.value
  const detail = workflow.value
  const requestToken = displayedDetailToken.value
  const detailMatchesSelection = !!task && !!detail && !detailLoading.value
    && requestToken === detailRequestSequence && displayedTaskId.value === task.workflow_instance_id
    && detail.id === task.workflow_instance_id && detail.subject_type === task.subject_type && detail.subject_id === task.subject_id
    && detail.current_revision === input.revision && input.level === task.decision_level
  if (!detailMatchesSelection || !task) {
    error.value = detailLoading.value ? '任务详情正在更新，请完成加载后重试' : '任务详情已变化，正在刷新'
    if (task && !detailLoading.value) await selectTask(task)
    return
  }
  const instanceId = task.workflow_instance_id
  busy.value = true
  error.value = ''
  try {
    await api.decideWorkflow(instanceId, input)
    if (requestToken !== detailRequestSequence || selectedId.value !== instanceId) return
    await load()
  } catch (cause: any) { error.value = cause?.response?.data?.error || cause?.message || '处理失败' }
  finally { busy.value = false }
}

watch(() => props.activeQueue, load)
onMounted(load)
</script>

<template>
  <section class="professional-queue" v-loading="loading || detailLoading" aria-label="我的专业待办">
    <div class="queue-head">
      <div><h2>我的专业待办</h2><p>仅显示服务端确认由你以当前专业身份处理的任务。</p></div>
      <span class="count">{{ visibleTasks.length }} 项</span>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div v-if="visibleTasks.length" class="workspace">
      <nav class="task-list" aria-label="专业任务列表">
        <button v-for="task in visibleTasks" :key="task.workflow_instance_id" type="button" :disabled="busy"
          :class="{ active: selectedId === task.workflow_instance_id }" @click="selectTask(task)">
          <b>{{ task.acting_capacity }}</b>
          <span class="mono">{{ task.contract_id }}</span>
          <small class="mono">{{ task.subject_id }}</small>
        </button>
      </nav>
      <WorkflowReviewPanel v-if="selected && workflow && !detailLoading && displayedTaskId === selected.workflow_instance_id"
        :workflow="workflow" :authorized-level="selected.decision_level"
        :actor-username="currentUser?.username || ''" :busy="busy" :error-message="error"
        @decide="decide" @refresh="selected && selectTask(selected)" />
    </div>
    <p v-else-if="!loading" class="empty">当前身份下没有需要处理的专业任务</p>
  </section>
</template>

<style scoped>
.professional-queue{margin-top:16px;padding:18px;background:var(--surface);border:1px solid var(--line);border-radius:10px;color:var(--ink)}
.queue-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.queue-head h2{margin:0;font-size:18px}.queue-head p{margin:4px 0 0;color:var(--muted);font-size:13px}.count{padding:4px 9px;border-radius:999px;background:var(--surface-2);font-size:12px;white-space:nowrap}
.workspace{display:grid;grid-template-columns:minmax(220px,300px) minmax(0,1fr);gap:16px;margin-top:16px}.task-list{display:grid;align-content:start;gap:8px}.task-list button{min-height:64px;padding:10px 12px;text-align:left;border:1px solid var(--line);border-radius:7px;background:var(--surface);color:var(--ink);cursor:pointer}.task-list button.active{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-ring)}.task-list b,.task-list span,.task-list small{display:block}.task-list span,.task-list small{margin-top:3px;color:var(--muted)}
.error{padding:10px 12px;border-radius:6px;background:var(--crit-soft);color:var(--crit)}.empty{margin:18px 0 0;color:var(--muted)}.mono{font-family:var(--font-mono)}
@media (max-width:720px){.workspace{grid-template-columns:1fr}}
</style>
