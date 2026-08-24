<script setup lang="ts">
// 样品交接与质控工作面：样品管理员签收交接单，质控员随后生成任务通知单并下达。
// 样品交接与质控安排是十阶段中的两个独立阶段，共用当前专业工作面。
import { ref, computed, nextTick, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, currentUser, type HandoverSheet, type TestNotice, type QualityPlan, type QualityPlanRequirement, type WorkflowAssignment, type WorkflowView, type WorkflowDecisionLevel } from '../api'
import { can, PAGE_ROLES } from '../permissions'
import StageQueueNav from '../components/StageQueueNav.vue'
import ProfessionalTaskQueue from '../components/ProfessionalTaskQueue.vue'
import WorkflowReviewPanel from '../components/WorkflowReviewPanel.vue'
import WorkflowAssignmentEditor from '../components/WorkflowAssignmentEditor.vue'
import ProjectStageProgress from '../components/ProjectStageProgress.vue'
import type { BusinessStageKey, StageQueueKey } from '../workflow/businessStages'
import { matchesActorWorkflowQueue } from '../workflow/actorQueueMatching'

const route = useRoute()
const activeStage = computed<BusinessStageKey>(() => route.query.stage === 'quality' ? 'quality' : 'handover')
const activeQueue = computed<StageQueueKey>(() => ['write', 'review', 'approve', 'rejected', 'final'].includes(String(route.query.queue)) ? route.query.queue as StageQueueKey : 'write')
const hasBasePageAccess = computed(() => currentUser.value?.roles.includes('admin')
  || PAGE_ROLES.qc.some(role => currentUser.value?.roles.includes(role)))

const sheets = ref<HandoverSheet[]>([])          // 待签收（sent）+ 草稿（draft，看得到催采样员发）
const confirmedSheets = ref<HandoverSheet[]>([])
const notices = ref<TestNotice[]>([])
const sheetOpen = ref<string | null>(null)
const rejectReasons = ref<Record<string, string>>({})
const loading = ref(true)
const loadErr = ref('')
const busy = ref<Record<string, boolean>>({})    // 按单号防连点
const workflowByRound = ref<Record<string, WorkflowView | null>>({})
const qualityPlanByRound = ref<Record<string, QualityPlan | null>>({})
const assignmentsByContract = ref<Record<string, WorkflowAssignment[]>>({})
const selectedRoundId = ref('')
const qualityPlan = ref<QualityPlan | null>(null)
const adjustments = ref<QualityPlanRequirement[]>([])
const qualityError = ref<{ code: string; message: string }>({ code: '', message: '' })
const qualityBusy = ref(false)
const qualityAssignmentTarget = ref<HTMLElement | null>(null)

// 按合同排：同一家的单挨在一起，行上带 单位·项目·委托号
const byContract = (a: any, b: any) => String(a.contract_id || '').localeCompare(String(b.contract_id || '')) || String(a.id).localeCompare(String(b.id))
const who = (x: any) => [x.client, x.project].filter(Boolean).join(' · ')

async function loadAll() {
  loading.value = true
  try {
    const all = await api.listHandoverSheets({})
    sheets.value = all.filter(s => s.status !== 'confirmed').sort(byContract)
    confirmedSheets.value = all.filter(s => s.status === 'confirmed')
    notices.value = (await api.listTestNotices()).sort(byContract)
    await loadWorkflowContext(all)
    loadErr.value = ''
  } catch (e: any) {
    // 加载失败≠没活儿干：必须亮出来，不能演成空队列
    loadErr.value = e?.response?.data?.error || e?.message || '加载失败'
  } finally { loading.value = false }
}
async function loadWorkflowContext(all: HandoverSheet[]) {
  const roundIds = [...new Set(all.map(sheet => sheet.round_id).filter(Boolean))]
  workflowByRound.value = Object.fromEntries(await Promise.all(roundIds.map(async roundId => {
    try { return [roundId, await api.getWorkflow('quality_plan', roundId)] as const }
    catch { return [roundId, null] as const }
  })))
  qualityPlanByRound.value = Object.fromEntries(await Promise.all(roundIds.map(async roundId => {
    try { return [roundId, await api.getQualityPlan(roundId)] as const }
    catch { return [roundId, null] as const }
  })))
  const contractIds = [...new Set(all.map(sheet => sheet.contract_id).filter(Boolean))]
  assignmentsByContract.value = Object.fromEntries(await Promise.all(contractIds.map(async contractId => {
    try { return [contractId, await api.listWorkflowAssignments(contractId)] as const }
    catch { return [contractId, []] as const }
  })))
}
onMounted(() => { if (hasBasePageAccess.value) loadAll() })

async function doConfirmSheet(sh: HandoverSheet) {
  const rejects = sh.sample_ids
    .map(id => ({ sampleId: id, reason: (rejectReasons.value[id] || '').trim() }))
    .filter(r => r.reason)
  try {
    await ElMessageBox.confirm(
      rejects.length ? `整单签收 ${sh.id}，其中 ${rejects.length} 个样品拒收？签收后留痕不可改。` : `整单签收 ${sh.id}？签收后留痕不可改。`,
      '签收确认', { confirmButtonText: '签收', cancelButtonText: '再看看', type: 'warning' },
    )
  } catch { return }
  if (busy.value[sh.id]) return
  busy.value[sh.id] = true
  try {
    await api.confirmHandoverSheet(sh.id, rejects)
    ElMessage.success(rejects.length ? `已签收（拒收 ${rejects.length} 个样品）` : '已整单签收')
    rejectReasons.value = {}; sheetOpen.value = null
    await loadAll()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { busy.value[sh.id] = false }
}

const sheetsNeedNotice = computed(() => {
  const has = new Set(notices.value.map(x => x.sheet_id))
  return confirmedSheets.value.filter(s => !has.has(s.id) && s.detail.some(d => !d.rejected)).sort(byContract)
})
const draftNotices = computed(() => notices.value.filter(x => x.status === 'draft'))
const issuedNotices = computed(() => notices.value.filter(x => x.status === 'issued').slice(0, 8))
const visibleSheets = computed(() => sheets.value.filter(sheet => activeQueue.value === 'write' ? sheet.status === 'draft' : activeQueue.value === 'review' ? sheet.status === 'sent' : activeQueue.value === 'rejected' ? sheet.detail.some(row => row.rejected) : false))
const canEditQuality = computed(() => currentUser.value?.roles.includes('qc') === true)
const canAssignReviewers = computed(() => currentUser.value?.roles.some(role => role === 'planner' || role === 'admin') === true)
const qualitySheets = computed(() => confirmedSheets.value.filter(sheet => {
  if (activeQueue.value === 'write' && canAssignReviewers.value) return true
  const workflow = workflowByRound.value[sheet.round_id]
  const assignment = assignmentsByContract.value[sheet.contract_id]?.find(item => item.scope === 'quality')
  const plan = qualityPlanByRound.value[sheet.round_id]
  const me = currentUser.value?.username || ''
  return matchesActorWorkflowQueue(activeQueue.value, workflow, assignment,
    me, plan?.author_username ? [plan.author_username] : (activeQueue.value === 'write' && canEditQuality.value ? [me] : []))
}))
const selectedQualitySheet = computed(() => confirmedSheets.value.find(sheet => sheet.round_id === selectedRoundId.value) || null)
const selectedQualityWorkflow = computed(() => selectedRoundId.value ? workflowByRound.value[selectedRoundId.value] || null : null)
const selectedQualityAssignment = computed(() => selectedQualitySheet.value ? assignmentsByContract.value[selectedQualitySheet.value.contract_id]?.find(item => item.scope === 'quality') || null : null)
const missingQualityAssignmentMessage = computed(() => canAssignReviewers.value
  ? '本项目尚未指定质控复核人和审核人，指定后才能提交复核。'
  : '本项目尚未指定质控复核人和审核人。请联系计划员或管理员指定；当前账号可编制质控安排和派检测任务，不能指定审核人员。')
async function focusQualityAssignment() {
  await nextTick()
  const target = qualityAssignmentTarget.value?.querySelector<HTMLElement>('[data-assignment-scope="quality"]')
  target?.focus()
  target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
}
function onQualityAssignmentSaved(assignment: WorkflowAssignment) {
  const current = assignmentsByContract.value[assignment.contract_id] || []
  assignmentsByContract.value = {
    ...assignmentsByContract.value,
    [assignment.contract_id]: [...current.filter(item => item.scope !== assignment.scope), assignment],
  }
}
async function selectQualityRound(roundId: string) {
  selectedRoundId.value = roundId; qualityError.value = { code: '', message: '' }
  qualityPlan.value = null; adjustments.value = []
  try {
    qualityPlan.value = await api.getQualityPlan(roundId)
    qualityPlanByRound.value = { ...qualityPlanByRound.value, [roundId]: qualityPlan.value }
    adjustments.value = qualityPlan.value?.adjustments.map(item => ({ ...item })) || []
  } catch (error: any) { qualityError.value.message = error?.response?.data?.error || error?.message || '质控安排加载失败' }
}
async function saveQuality() {
  if (!selectedRoundId.value || qualityBusy.value) return
  qualityBusy.value = true; qualityError.value = { code: '', message: '' }
  try {
    qualityPlan.value = await api.saveQualityPlan(selectedRoundId.value, adjustments.value)
    qualityPlanByRound.value = { ...qualityPlanByRound.value, [selectedRoundId.value]: qualityPlan.value }
  }
  catch (error: any) { qualityError.value.message = error?.response?.data?.error || error?.message || '质控安排保存失败' }
  finally { qualityBusy.value = false }
}
async function refreshSelectedQuality() {
  if (!selectedRoundId.value) return
  const workflow = await api.getWorkflow('quality_plan', selectedRoundId.value).catch(() => null)
  workflowByRound.value = { ...workflowByRound.value, [selectedRoundId.value]: workflow }
  await selectQualityRound(selectedRoundId.value)
}
async function submitQualityReview() {
  if (!selectedRoundId.value || qualityBusy.value) return
  qualityBusy.value = true
  try { await api.submitWorkflow('quality_plan', selectedRoundId.value); await refreshSelectedQuality() }
  catch (error: any) { qualityError.value = { code: error?.response?.data?.error_code || '', message: error?.response?.data?.error || error?.message || '提交失败' } }
  finally { qualityBusy.value = false }
}
async function decideQualityReview(input: { revision: number; level: WorkflowDecisionLevel; decision: 'approve' | 'reject'; comment: string }) {
  if (!selectedQualityWorkflow.value || qualityBusy.value) return
  qualityBusy.value = true
  try { await api.decideWorkflow(selectedQualityWorkflow.value.id, input); await refreshSelectedQuality() }
  catch (error: any) { qualityError.value = { code: error?.response?.data?.error_code || '', message: error?.response?.data?.error || error?.message || '审批失败' } }
  finally { qualityBusy.value = false }
}
function addAdjustment() { adjustments.value.push({ qcType: '平行样', qty: 1 }) }
watch(qualitySheets, rows => { if (!rows.some(row => row.round_id === selectedRoundId.value)) selectedRoundId.value = ''; if (!selectedRoundId.value && rows[0]) void selectQualityRound(rows[0].round_id) })

async function doCreateNotice(sh: HandoverSheet) {
  if (busy.value[sh.id]) return
  busy.value[sh.id] = true
  try { await api.createNoticeFromSheet(sh.id); ElMessage.success('已生成任务通知单'); await loadAll() }
  catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { busy.value[sh.id] = false }
}
async function doSaveNotice(n: TestNotice) {
  if (busy.value[n.id]) return
  busy.value[n.id] = true
  try { await api.updateTestNotice(n.id, { dueAt: n.due_at || '', note: n.note || '' }); ElMessage.success('已保存') }
  catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { busy.value[n.id] = false }
}
async function doIssueNotice(n: TestNotice) {
  try {
    await ElMessageBox.confirm(`下达 ${n.id}？任务将进入实验室分析人员待认领池，下达后不可撤回。`, '下达确认',
      { confirmButtonText: '下达', cancelButtonText: '再看看', type: 'warning' })
  } catch { return }
  if (busy.value[n.id]) return
  busy.value[n.id] = true
  try { await api.issueTestNotice(n.id); ElMessage.success('已下达，任务进入待认领池'); await loadAll() }
  catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { busy.value[n.id] = false }
}
// 撤回下达（下错了）：没人认领才能撤，后端会拦
async function doRevokeNotice(n: TestNotice) {
  try {
    const { value } = await ElMessageBox.prompt(`撤回 ${n.id}？任务将从认领池撤下、通知单回草稿。填原因（记入留痕）`, '撤回下达', { confirmButtonText: '撤回', cancelButtonText: '不撤', inputValidator: (v: string) => (v && v.trim() ? true : '原因必填') })
    if (value == null) return
    await api.revokeNotice(n.id, value.trim())
    ElMessage.success('已撤回，通知单回到草稿'); await loadAll()
  } catch (e: any) { if (e !== 'cancel') ElMessage.error(e?.response?.data?.error || e?.message || e) }
}
const dt = (iso?: string | null) => (iso ? iso.slice(5, 16).replace('T', ' ') : '')
</script>

<template>
  <div class="pagewrap">
    <div class="phead">
      <div>
        <h1 class="page">{{ activeStage === 'handover' ? '⑥ 样品交接' : '⑦ 质控' }}</h1>
        <p class="sub">{{ activeStage === 'handover' ? '采样员发起、样品管理员逐项确认，拒收必须说明原因' : '质控员编制安排，指定复核人和审核人依次签批' }}</p>
      </div>
    </div>
    <StageQueueNav v-if="hasBasePageAccess" :active="activeQueue" />

    <ProfessionalTaskQueue v-if="!hasBasePageAccess" scope="quality" :active-queue="activeQueue" />
    <template v-else>

    <div v-if="loadErr" class="card errbar">加载失败（不代表没有待办）：{{ loadErr }} <el-button size="small" text type="primary" @click="loadAll">重试</el-button></div>

    <div v-loading="loading">
    <!-- 待签收交接单 -->
    <div v-if="activeStage === 'handover'" class="card blk">
      <div class="blk-head"><b>待签收交接单</b><span class="muted">采样员发来的整单；可逐样拒收（写原因）</span></div>
      <div v-for="sh in visibleSheets" :key="sh.id" class="row">
        <div class="line">
          <b class="num">{{ sh.id }}</b>
          <el-tag size="small" :type="sh.status === 'sent' ? 'warning' : 'info'">{{ sh.status === 'sent' ? '待签收' : '草稿（等采样员发出）' }}</el-tag>
          <span class="ctx"><b>{{ who(sh) || '散样' }}</b><span v-if="sh.contract_id" class="num cid"> {{ sh.contract_id }}</span></span>
          <span>{{ sh.sample_ids.length }} 个样品 · {{ sh.from_person }} {{ dt(sh.from_at) }}</span>
          <span class="spacer"></span>
          <el-button size="small" text type="primary" @click="sheetOpen = sheetOpen === sh.id ? null : sh.id">{{ sheetOpen === sh.id ? '收起' : '看明细' }}</el-button>
          <a class="plink" :href="`/handover-sheets/${sh.id}/print`" target="_blank">打印</a>
          <el-button v-if="sh.status === 'sent' && can('handover_confirm')" size="small" type="primary" :loading="busy[sh.id]" @click="doConfirmSheet(sh)">整单签收</el-button>
        </div>
        <table v-if="sheetOpen === sh.id" class="dtl">
          <tbody>
            <tr><th>样品编号</th><th>检测项目</th><th>拒收原因（留空=正常签收）</th></tr>
            <tr v-for="d in sh.detail" :key="d.sampleId">
              <td class="num">{{ d.sampleId }}</td>
              <td>{{ (d.items || []).join('、') }}</td>
              <td><el-input v-model="rejectReasons[d.sampleId]" size="small" placeholder="如：采样瓶破损" /></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!visibleSheets.length && !loading" class="empty">当前队列没有交接单</div>
    </div>

    <div v-if="activeStage === 'quality'" class="card blk quality-workspace">
      <div class="blk-head"><b>质控安排</b><span class="muted">空白、平行、加标等要求在这里编制；实验质控结果随第 8 步实验室记录审核。</span></div>
      <div class="quality-select">
        <label>当前期次
          <select :value="selectedRoundId" @change="selectQualityRound(($event.target as HTMLSelectElement).value)">
            <option value="">请选择</option>
            <option v-for="sheet in qualitySheets" :key="sheet.round_id" :value="sheet.round_id">{{ sheet.contract_id }} · {{ who(sheet) || sheet.round_id }}</option>
          </select>
        </label>
      </div>
      <template v-if="selectedQualitySheet">
        <ProjectStageProgress current-stage="quality" :completed-stages="['contract','contract-review','scheme','dispatch','sampling','handover']" />
        <div v-if="qualityPlan" class="requirements">
          <div v-for="item in qualityPlan.requirements" :key="`${item.qcType}-${item.matrix}-${item.analyte}`" class="requirement">
            <b>{{ item.qcType }}</b><span>{{ item.matrix || '全部基质' }} · {{ item.analyte || '全部项目' }}</span><span class="num">× {{ item.qty }}</span><small>{{ item.basis || item.note || '项目质控安排' }}</small>
          </div>
        </div>
        <div v-if="canEditQuality && !selectedQualityWorkflow" class="adjustments">
          <div v-for="(item, index) in adjustments" :key="index" class="adjustment">
            <input v-model="item.qcType" placeholder="质控类型" /><input v-model="item.matrix" placeholder="基质（可空）" />
            <input v-model="item.analyte" placeholder="项目（可空）" /><input v-model.number="item.qty" type="number" min="1" />
            <button type="button" class="remove" @click="adjustments.splice(index, 1)">移除</button>
          </div>
          <div class="quality-actions"><button type="button" class="secondary" @click="addAdjustment">添加调整</button><button type="button" class="primary" :disabled="qualityBusy" @click="saveQuality">保存质控安排</button></div>
        </div>
        <WorkflowReviewPanel v-if="qualityPlan" :workflow="selectedQualityWorkflow" :assignment="selectedQualityAssignment"
          :actor-username="currentUser?.username || ''" :author-username="qualityPlan.author_username"
          :qualification-problem="selectedQualityAssignment ? '' : missingQualityAssignmentMessage"
          :qualification-action-label="!selectedQualityAssignment && canAssignReviewers ? '立即指定人员' : ''"
          :busy="qualityBusy" :error-code="qualityError.code" :error-message="qualityError.message"
          @submit="submitQualityReview" @decide="decideQualityReview" @refresh="refreshSelectedQuality"
          @resolve-qualification-problem="focusQualityAssignment" />
        <div v-if="canAssignReviewers" ref="qualityAssignmentTarget" data-quality-assignment-target class="assignment-focus-target">
          <WorkflowAssignmentEditor :contract-id="selectedQualitySheet.contract_id"
            :assignments="assignmentsByContract[selectedQualitySheet.contract_id] || []" :scopes="['quality']"
            @saved="onQualityAssignmentSaved" />
        </div>
        <p v-else-if="qualityError.message" class="errbar" role="alert">{{ qualityError.message }}</p>
        <p v-else class="empty">尚未保存质控安排。质控员保存后才可提交复核。</p>
      </template>
      <div v-else class="empty">当前队列没有需要处理的质控期次</div>
    </div>

    <!-- 任务通知单 -->
    <div v-if="activeStage === 'quality' && activeQueue === 'write'" class="card blk">
      <div class="blk-head"><b>检测任务通知单</b><span class="muted">HJ-TC-137 · 从已签收交接单生成 → 改完成时限 → 下达（任务进待认领池）</span></div>
      <div v-for="sh in sheetsNeedNotice" :key="sh.id" class="row">
        <div class="line">
          <b class="num">{{ sh.id }}</b>
          <el-tag size="small" type="success">已签收</el-tag>
          <span class="ctx"><b>{{ who(sh) || '散样' }}</b><span v-if="sh.contract_id" class="num cid"> {{ sh.contract_id }}</span></span>
          <span>{{ sh.detail.filter(d => !d.rejected).length }} 个样品待下任务</span>
          <span class="spacer"></span>
          <el-button size="small" type="primary" plain :loading="busy[sh.id]" @click="doCreateNotice(sh)">生成任务通知单</el-button>
        </div>
      </div>
      <div v-for="n in draftNotices" :key="n.id" class="row">
        <div class="line">
          <b class="num">{{ n.id }}</b>
          <el-tag size="small" type="info">草稿</el-tag>
          <span class="ctx"><b>{{ who(n) || '散样' }}</b></span>
          <span>{{ n.groups.length }} 个样品 · {{ n.category }}</span>
          <el-input v-model="n.due_at" size="small" type="date" style="width:150px" />
          <el-input v-model="n.note" size="small" placeholder="备注（如 BOD5 08.05）" style="width:190px" />
          <span class="spacer"></span>
          <el-button size="small" text type="primary" :loading="busy[n.id]" @click="doSaveNotice(n)">保存</el-button>
          <a class="plink" :href="`/test-notices/${n.id}/print`" target="_blank">预览打印</a>
          <el-button size="small" type="primary" :loading="busy[n.id]" @click="doIssueNotice(n)">下达</el-button>
        </div>
      </div>
      <div v-if="!sheetsNeedNotice.length && !draftNotices.length && !loading" class="empty">没有待处理的通知单</div>
    </div>

    <!-- 已下达（含解密单入口） -->
    <div v-if="activeStage === 'quality' && activeQueue === 'final' && issuedNotices.length" class="card blk">
      <div class="blk-head"><b>最近已下达</b><span class="muted">打印件含第2页解密单（HJ-TC-149，质控留存，不随任务下发）</span></div>
      <div v-for="n in issuedNotices" :key="n.id" class="row">
        <div class="line">
          <b class="num">{{ n.id }}</b>
          <el-tag size="small" type="success">已下达</el-tag>
          <span class="ctx"><b>{{ who(n) || '散样' }}</b></span>
          <span>{{ n.groups.length }} 个样品 · 下达 {{ dt(n.issued_at) }}<template v-if="n.due_at"> · 限 {{ n.due_at }}</template></span>
          <span class="spacer"></span>
          <a class="plink" :href="`/test-notices/${n.id}/print`" target="_blank">打印 137+149</a>
          <el-button size="small" text type="danger" :loading="busy[n.id]" @click="doRevokeNotice(n)">撤回</el-button>
        </div>
      </div>
    </div>
    </div>
    </template>
  </div>
</template>

<style scoped>
.errbar{padding:10px 14px;margin-bottom:14px;color:var(--crit);background:var(--crit-soft);font-size:13px}
.blk{padding:14px 18px;margin-bottom:14px}
.blk-head{display:flex;align-items:baseline;gap:10px;margin-bottom:8px}
.blk-head b{font-size:14.5px}
.muted{color:var(--faint);font-size:12px}
.row{border-top:1px solid var(--line);padding:8px 0}
.line{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.num{font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:13px}
.ctx{font-size:13px}
.cid{color:var(--faint);font-size:11.5px;margin-left:6px}
.spacer{flex:1}
.plink{font-size:12px;color:var(--accent);text-decoration:none;white-space:nowrap}
.plink:hover{text-decoration:underline}
.dtl{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:8px}
.dtl th{text-align:left;color:var(--faint);font-weight:600;padding:4px 8px;border-bottom:1px solid var(--line)}
.dtl td{padding:5px 8px;border-bottom:1px solid var(--line)}
.empty{color:var(--faint);font-size:12.5px;padding:8px 0}
</style>
