<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, currentUser, hasRole, HANDOVER_ACTIONS, PRETREAT_METHODS, type Sample, type Handover, type Pretreatment, type TestTask, type HandoverSheet } from '../api'
import { can } from '../permissions'
import { confirmIfDirty } from '../utils/dirty'
import RecordAttachments from '../components/RecordAttachments.vue'
import BatchEntry from '../components/BatchEntry.vue'
import SymbolInput from '../components/SymbolInput.vue'

const route = useRoute()
import templatesJson from '../data/templates.json'
import { templatePhase } from '../data/phase'
import StructuredSheet from '../components/StructuredSheet.vue'

type Tpl = { code: string; name: string; analyte: string; matrix: string; method: string; sheetType: string; raw: string; file: string }
const templates = templatesJson as Tpl[]

const MATRICES = ['废水', '地表水', '地下水', '海水', '土壤', '固废', '环境空气', '废气', '生活饮用水', '大气降水', '噪声']
const STATUS = [['全部', ''], ['待检测', 'pending'], ['检测中', 'testing'], ['已完成', 'done']] as [string, string][]
const statusLabel: Record<string, string> = { pending: '待检测', testing: '检测中', done: '已完成', rejected: '已拒收' }
// 状态 → 语义色调（仅用于圆点/胶囊，不给文字上色）
const statusTone: Record<string, string> = { pending: 'warn', testing: 'accent', done: 'good', rejected: 'crit' }

// —— 自送样登记表单（客户直接送检、不走委托）——
const form = ref({ client: '', matrix: '废水', items: '', note: '' })
const submitting = ref(false)
// 登记表单默认收起——样品列表才是本页主体，表单常驻会把列表挤没
const showReg = ref(false)
async function register() {
  if (!form.value.matrix) return ElMessage.warning('请选择样品基质')
  submitting.value = true
  try {
    const items = form.value.items.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean)
    const s = await api.createSample({ client: form.value.client, matrix: form.value.matrix, items, note: form.value.note })
    ElMessage.success(`已登记 ${s.id}`)
    form.value.client = ''; form.value.items = ''; form.value.note = ''
    showReg.value = false
    await refresh()
    select(s)
  } catch (e: any) {
    ElMessage.error('登记失败：' + (e?.response?.data?.error || e?.message || e))
  } finally { submitting.value = false }
}

// —— 样品列表 ——
const samples = ref<Sample[]>([])
const statusFilter = ref('')
const keyword = ref('')
const contractFilter = ref('')
const loading = ref(false)
async function refresh() {
  loading.value = true
  try { samples.value = await api.listSamples(statusFilter.value || undefined) }
  catch (e: any) { ElMessage.error('后端未连接？' + (e?.message || e)) }
  finally { loading.value = false }
}
function setStatus(s: string) { statusFilter.value = s; refresh() }
// 按项目（合同）筛选的选项
const contractOpts = computed(() => {
  const m = new Map<string, number>()
  for (const s of samples.value) if (s.contract_id) m.set(s.contract_id, (m.get(s.contract_id) || 0) + 1)
  return [...m.entries()]
})
const shown = computed(() => {
  const rows = samples.value.filter(s => {
    if (onlyMine.value && !myTaskSampleIds.value.has(s.id)) return false
    if (contractFilter.value && s.contract_id !== contractFilter.value) return false
    if (keyword.value) { const k = keyword.value.toLowerCase(); if (!((s.id + s.client + s.matrix + s.items.join('') + (s.contract_id || '')).toLowerCase().includes(k))) return false }
    return true
  })
  // 按合同聚合（全站列表原则）：同一家挨在一起再分页，组头才能连续；盲用户合同已脱敏，保持平铺
  if (isBlindView.value) return rows
  return [...rows].sort((a, b) => String(a.contract_id || '￿').localeCompare(String(b.contract_id || '￿')) || String(a.id).localeCompare(String(b.id)))
})
// 样品成百上千时全量渲染会卡：轻量分页，每页 50；搜索/筛选变了回到第 1 页
const PAGE_SIZE = 50
const page = ref(1)
const paged = computed(() => shown.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
// 组头：当前页里合同号与上一行不同就插一条（排序已保证同合同连续）
const showGrpHead = (i: number) => {
  if (isBlindView.value) return false
  const cur = paged.value[i], prev = paged.value[i - 1]
  return i === 0 || (cur.contract_id || '') !== (prev?.contract_id || '')
}

// —— 我的检测任务（质控派活给我）：检测员默认只看派给自己的活 ——
const myTasks = ref<TestTask[]>([])
const onlyMine = ref(false)
// 搜索/筛选变了回到第 1 页——必须放在 onlyMine 声明之后（watch 同步取值，放前面是 TDZ 白屏）
watch([keyword, statusFilter, contractFilter, onlyMine], () => { page.value = 1 })
const isPureTester = computed(() => hasRole('tester') && !hasRole('tech') && !(currentUser.value?.roles || []).includes('admin'))
// 真盲视角（拍板2）：与后端 isBlindViewer 同口径——纯检测员（不兼 qc/采样/登记/管理/签字岗）
const isBlindView = computed(() => hasRole('tester') && !hasRole('admin', 'tech', 'qc', 'registrar', 'sampler', 'signer'))
const myTaskSampleIds = computed(() => new Set(myTasks.value.map(t => t.sample_id)))
async function loadMyTasks() {
  try { myTasks.value = await api.listTasks({ assignee: 'me' }) } catch { myTasks.value = [] }
  // 纯检测员且确实有派给他的活 → 默认只看自己的
  if (isPureTester.value && myTasks.value.length && !touchedMineToggle.value) onlyMine.value = true
}
const todayStr = new Date().toISOString().slice(0, 10)
const touchedMineToggle = ref(false)
function toggleMine() { touchedMineToggle.value = true; onlyMine.value = !onlyMine.value }

// —— 选中样品 + 选记录表录入 ——
const selected = ref<Sample | null>(null)
const chosenTpl = ref<Tpl | null>(null)
const tplKeyword = ref('')
async function select(s: Sample) {
  if (selected.value?.id === s.id) return
  if (!(await confirmIfDirty())) return   // 表里有没保存的内容，先拦一道
  selected.value = s; chosenTpl.value = null; tplKeyword.value = ''; showAllTpls.value = false; showHo.value = false; showPre.value = false; showTasks.value = false; loadHandovers(); loadPre(); loadTasks(); loadRetention()
  // 保存条件从交接单带出（4℃冷藏/加酸这类要求，盲样也要看得到才好干活）
  api.getSample(s.id).then(d => { if (selected.value?.id === s.id) selected.value = { ...selected.value, storage: (d as any).storage } }).catch(() => {})
}
async function backToPicker() { if (await confirmIfDirty()) chosenTpl.value = null }
// —— 跨合同同表批量录入（PRD 步骤6）——
const batchMode = ref(false)
async function toggleBatch() { if (await confirmIfDirty()) batchMode.value = !batchMode.value }
async function onBatchSaved() { await refresh(); await loadMyTasks() }

// —— 检测任务派工（PRD 步骤5：qc 按样品×项目派给检测员）——
const tasks = ref<TestTask[]>([])
const showTasks = ref(false)
const canAssignTasks = computed(() => can('task_assign'))
const testers = ref<{ username: string; name: string }[]>([])
const taskDraft = ref<Record<string, string>>({})
const TASK_ST: Record<string, string> = { none: '未开始', draft: '录入中', submitted: '待复核', reviewed: '待终审', approved: '已定稿', rejected: '被打回' }
async function loadTasks() {
  tasks.value = []; taskDraft.value = {}
  if (!selected.value) return
  try {
    tasks.value = await api.listTasks({ sampleId: selected.value.id })
    for (const t of tasks.value) taskDraft.value[t.analyte] = t.assignee
  } catch { /* 列表拉不到不挡页面 */ }
}
const taskSaving = ref(false)   // 防连点：连点会重复派工
async function saveTasks() {
  if (!selected.value || taskSaving.value) return
  const items = (selected.value.items || [])
    .map(a => ({ analyte: a, assignee: taskDraft.value[a] || '', assigneeUsername: testers.value.find(t => t.name === taskDraft.value[a])?.username }))
    .filter(x => x.assignee)
  if (!items.length) return ElMessage.warning('先给至少一个项目选检测员')
  taskSaving.value = true
  try {
    tasks.value = await api.assignTasks(selected.value.id, items)
    ElMessage.success('已派检测任务')
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { taskSaving.value = false }
}
// 认领错了退回（本人、未动手）
async function unclaim(t: TestTask) {
  try {
    await api.unclaimTask(t.id as any)
    ElMessage.success('已退回认领池'); await loadTasks(); await loadMyTasks()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
}
// 任务取消（缺测/派错的正路出口）：有记录的项目后端会拦
async function cancelTask(t: TestTask) {
  try {
    const { value } = await ElMessageBox.prompt(`取消「${t.analyte}」的检测任务？填原因（缺测/派错等，记入留痕）`, '取消任务', { confirmButtonText: '取消任务', cancelButtonText: '不取消', inputPlaceholder: '如：样品量不足，本期缺测', inputValidator: (v: string) => (v && v.trim() ? true : '原因必填') })
    if (value == null) return
    await api.cancelTask(t.id as any, value.trim())
    ElMessage.success('任务已取消（留痕）'); await loadTasks()
  } catch (e: any) { if (e !== 'cancel') ElMessage.error(e?.response?.data?.error || e?.message || e) }
}
// 补采：拒收样一键在原期次重建新样+新交接单草稿
const resampleBusy = ref(false)
async function doResample() {
  if (!selected.value || resampleBusy.value) return
  const ok = await ElMessageBox.confirm(`为拒收样 ${selected.value.id} 补采？将在原期次重建新样（继承点位/项目）并生成新交接单草稿。`, '补采确认', { confirmButtonText: '补采', cancelButtonText: '取消', type: 'warning' }).catch(() => null)
  if (!ok) return
  resampleBusy.value = true
  try {
    const r = await api.resampleSample(selected.value.id)
    ElMessage.success(`已补采：新样 ${r.sample.id} · 交接单 ${r.sheet.id}（草稿，编辑后发出）`)
    await refresh(); await loadSheets?.()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { resampleBusy.value = false }
}

// —— 比对数据录入（在线比对）：存到 HJ-TC-501 记录的 data.compare，判定引擎/报告端已就绪 ——
const showCmp = ref(false)
const cmpSaving = ref(false)
const CMP_CODE = 'HJ-TC-501'
const cmpGroups = ref<{ type: string; analyte: string; stdValue: string; pairs: { time: string; online: string; lab: string }[] }[]>([])
watch(showCmp, async on => {
  if (!on || !selected.value) return
  try {
    const rec = await api.getRecord(selected.value.id, CMP_CODE)
    const gs = (rec as any)?.data?.compare
    cmpGroups.value = Array.isArray(gs) ? gs.map((g: any) => ({ type: g.type, analyte: g.analyte, stdValue: g.stdValue ?? '', pairs: (g.pairs || []).map((p: any) => ({ time: p.time || '', online: String(p.online ?? ''), lab: String(p.lab ?? '') })) })) : []
  } catch { cmpGroups.value = [] }
  if (!cmpGroups.value.length) cmpGroups.value = [{ type: 'conc', analyte: '', stdValue: '', pairs: [{ time: '', online: '', lab: '' }] }]
})
async function saveCompare(submit: boolean) {
  if (!selected.value || cmpSaving.value) return
  const groups = cmpGroups.value
    .filter(g => g.analyte.trim() && g.pairs.some(p => p.online !== '' && p.lab !== ''))
    .map(g => ({
      type: g.type, analyte: g.analyte.trim(),
      ...(g.type === 'qc' && g.stdValue !== '' ? { stdValue: Number(g.stdValue) } : {}),
      pairs: g.pairs.filter(p => p.online !== '' && p.lab !== '').map(p => ({ time: p.time, online: Number(p.online), lab: Number(p.lab) })),
    }))
  if (!groups.length) return ElMessage.warning('每组要有项目名和至少一对数值')
  cmpSaving.value = true
  try {
    await api.saveRecord({
      sampleId: selected.value.id, code: CMP_CODE, name: '在线比对检测原始记录', analyte: '在线比对', method: 'HJ 355-2019',
      data: { rows: [], meta: {}, reg: {}, compare: groups } as any, submit,
    })
    ElMessage.success(submit ? '比对数据已提交复核' : '比对数据已保存')
    if (submit) showCmp.value = false
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { cmpSaving.value = false }
}
// —— 前处理记录（6.1.5）——
const canPre = computed(() => can('pretreatment'))
const canConfirmHo = computed(() => can('handover_confirm'))
// —— 留样与处置（批次三）——
const retention = ref<any>(null)
const retForm = ref({ location: '', until: '' })
async function loadRetention() {
  retention.value = null
  if (!selected.value) return
  try {
    retention.value = await api.getRetention(selected.value.id)
    if (retention.value) retForm.value = { location: retention.value.location, until: retention.value.until_date || '' }
    else retForm.value = { location: '', until: '' }
  } catch { /* */ }
}
async function submitRetention() {
  if (!selected.value) return
  if (!retForm.value.location.trim()) return ElMessage.warning('留样位置必填')
  try {
    await api.setRetention(selected.value.id, { location: retForm.value.location, until: retForm.value.until || undefined })
    ElMessage.success('留样已登记'); await loadRetention()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
}
async function submitDispose() {
  if (!selected.value) return
  try {
    const { value } = await ElMessageBox.prompt('处置方式（如：中和后排放 / 到期弃置）', '留样处置', { confirmButtonText: '处置', cancelButtonText: '取消' })
    if (!value?.trim()) return
    await api.disposeRetention(selected.value.id, { method: value.trim() })
    ElMessage.success('已处置留痕'); await loadRetention()
  } catch { /* 取消 */ }
}
const pres = ref<Pretreatment[]>([])
const showPre = ref(false)
const preForm = ref({ method: '微波消解', reagent: '', condition: '', volFinal: '', note: '' })
async function loadPre() {
  pres.value = []
  if (!selected.value) return
  try { pres.value = await api.listPretreatments(selected.value.id) } catch { /* */ }
}
const preSaving = ref(false)
async function submitPre() {
  if (!selected.value || preSaving.value) return
  if (!preForm.value.method) return ElMessage.warning('选前处理方法')
  preSaving.value = true
  try {
    await api.addPretreatment(selected.value.id, { ...preForm.value })
    ElMessage.success('已记录前处理')
    preForm.value = { method: preForm.value.method, reagent: '', condition: '', volFinal: '', note: '' }
    await loadPre()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { preSaving.value = false }
}

// —— 样品交接 / 流转记录（6.1.4）——
const handovers = ref<Handover[]>([])
const showHo = ref(false)
const pendingHo = computed(() => handovers.value.filter(h => !h.confirmed_at).length)
const hoForm = ref({ action: '流转领用', fromPerson: '', toPerson: '', condition: '完好', note: '' })
async function loadHandovers() {
  handovers.value = []
  if (!selected.value) return
  try { handovers.value = await api.listHandovers(selected.value.id) } catch { /* */ }
}
const hoSaving = ref(false)
async function submitHandover() {
  if (!selected.value || hoSaving.value) return
  if (!hoForm.value.action) return ElMessage.warning('选交接类型')
  hoSaving.value = true
  try {
    await api.addHandover(selected.value.id, { ...hoForm.value })
    ElMessage.success('已记录交接')
    hoForm.value = { action: '流转领用', fromPerson: '', toPerson: '', condition: '完好', note: '' }
    showHo.value = false
    await loadHandovers()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { hoSaving.value = false }
}
async function confirmHo(h: Handover) {
  try {
    await api.confirmHandover(h.id)
    ElMessage.success('已确认签收')
    await loadHandovers()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
}
function hoTime(iso: string) { return iso ? iso.slice(0, 16).replace('T', ' ') : '' }

// —— 交接单（批次一）：收样自动草稿 → 采样员改/发出 → 质控员整单签收（可拒收个别样品） ——
const sheets = ref<HandoverSheet[]>([])
const sheetOpen = ref('')
const canSheet = computed(() => can('handover_send'))
async function loadSheets() {
  if (!canSheet.value) return
  try { sheets.value = (await api.listHandoverSheets()).filter(s => s.status !== 'confirmed') } catch { /* */ }
}
async function doSaveSheet(sh: HandoverSheet) {
  try { await api.updateHandoverSheet(sh.id, { storage: sh.storage ?? '' }); ElMessage.success('已保存') }
  catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
}
async function doSendSheet(sh: HandoverSheet) {
  try { await api.sendHandoverSheet(sh.id); ElMessage.success('已发质控员签收'); await loadSheets() }
  catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
}
// 质控签收/任务通知单已拆到「③质控交接」页（Qc.vue）——本页只留采样员发出入口和检测员认领池

// —— 待认领任务池（拍板1：认领为主+质控可指派）——
const unclaimed = ref<TestTask[]>([])
async function loadUnclaimed() {
  if (!can('record_save')) return
  try { unclaimed.value = await api.listUnclaimedTasks() } catch { /* */ }
}
async function doClaim(t: TestTask) {
  try {
    await api.claimTask(t.id)
    ElMessage.success(`已认领 ${t.sample_id} · ${t.analyte}`)
    await loadUnclaimed(); await loadMyTasks()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
}

// 该样品基质下的候选记录表（优先原始记录），按关键词过滤
const showAllTpls = ref(false)
function tplHitsItem(t: any, items: string[]) {
  const a = String(t.analyte || '').toLowerCase(), raw = String(t.raw || '').toLowerCase()
  return items.some(it => { const s = String(it).toLowerCase().trim(); if (!s) return false; return (a && (a.includes(s) || s.includes(a))) || raw.includes(s) })
}
const baseTpls = computed(() => {
  if (!selected.value) return []
  const mx = selected.value.matrix
  const k = tplKeyword.value.toLowerCase()
  return templates
    // 实验室检测步骤只列"实验室"环节的表：把混在原始记录里的现场表（油烟/烟气比对/噪声等）剔掉
    .filter(t => t.matrix === mx && (t.sheetType === '原始记录' || t.sheetType === '前处理') && templatePhase(t) === '实验室')
    .filter(t => !k || (t.raw + t.analyte + t.code + t.method).toLowerCase().includes(k))
})
const matchedTpls = computed(() => {
  const its = selected.value?.items || []
  return its.length ? baseTpls.value.filter(t => tplHitsItem(t, its)) : []
})
const candidateTpls = computed(() => {
  const k = tplKeyword.value.trim()
  // 默认只给匹配本样品检测项目的表；搜索中/点了「显示全部」/无匹配时才铺全部（避免看不到表）
  if (!k && !showAllTpls.value && matchedTpls.value.length) return matchedTpls.value.slice(0, 60)
  return baseTpls.value.slice(0, 60)
})

onMounted(async () => {
  await refresh()
  await loadMyTasks()
  await loadSheets()
  await loadUnclaimed()
  if (canAssignTasks.value) { try { testers.value = await api.listTesters() } catch { /* */ } }
  const want = route.query.sample as string | undefined
  if (want) { const s = samples.value.find(x => x.id === want); if (s) select(s) }
})
</script>

<template>
  <div class="pagewrap wide">
    <div class="phead">
      <div>
        <h1 class="page">检测录入</h1>
        <p class="sub">选一张记录表录入原始数据 · 客户直接送检可「自送样登记」</p>
      </div>
      <div class="hact">
        <span v-if="samples.length" class="hcount num">在库 {{ samples.length }} 个样品</span>
        <el-button v-if="can('record_save')" :type="batchMode ? 'primary' : 'default'" plain @click="toggleBatch">{{ batchMode ? '返回逐样录入' : '同表批量录入' }}</el-button>
        <el-button v-if="can('sample_create')" type="primary" @click="showReg = !showReg">自送样登记</el-button>
      </div>
    </div>

    <!-- 交接单（采样员视角）：收样自动生成草稿 → 补保存条件 → 发质控签收。签收/通知单在「③质控交接」页 -->
    <div v-if="!batchMode && sheets.length && can('handover_send')" class="card hosheet-card">
      <div class="hosheet-head">
        <b>样品交接单</b>
        <span class="muted">收样自动生成 · 补保存条件后发质控员签收（签收在「③质控交接」页）</span>
      </div>
      <div v-for="sh in sheets" :key="sh.id" class="hosheet">
        <div class="hosheet-line">
          <b class="num">{{ sh.id }}</b>
          <span class="muted num">{{ sh.round_id }}</span>
          <span>{{ sh.sample_ids.length }} 个样品</span>
          <el-tag v-if="sh.status === 'draft'" size="small" type="info">草稿</el-tag>
          <el-tag v-else size="small" type="warning">已发待签收</el-tag>
          <span class="muted">交样：{{ sh.from_person || '—' }}</span>
          <span class="spacer"></span>
          <el-button size="small" text type="primary" @click="sheetOpen = sheetOpen === sh.id ? '' : sh.id">{{ sheetOpen === sh.id ? '收起' : '明细' }}</el-button>
          <a class="plink" :href="`/handover-sheets/${sh.id}/print`" target="_blank">打印</a>
          <el-button v-if="sh.status === 'draft'" size="small" type="primary" plain @click="doSendSheet(sh)">发质控签收</el-button>
        </div>
        <div v-if="sheetOpen === sh.id" class="hosheet-detail">
          <div v-if="sh.status === 'draft'" style="margin-bottom:8px">
            <el-input v-model="sh.storage" size="small" placeholder="保存条件（如 4℃冷藏、COD加硫酸至pH≤2）" style="max-width:420px" @change="doSaveSheet(sh)" />
          </div>
          <table class="hosheet-table">
            <thead><tr><th>样品编号</th><th>检测项目</th><th>状态</th></tr></thead>
            <tbody>
              <tr v-for="d in sh.detail" :key="d.sampleId">
                <td class="num">{{ d.sampleId }}</td>
                <td>{{ (d.items || []).join('、') || '—' }}</td>
                <td>{{ d.condition || '完好' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 待认领任务池：通知单下达后，检测员自己领活（质控员也可在样品页指派） -->
    <div v-if="!batchMode && unclaimed.length && can('record_save')" class="card hosheet-card">
      <div class="hosheet-head">
        <b>待认领任务</b>
        <span class="muted">通知单已下达 · 认领后出现在「我的任务」，才能录数据</span>
      </div>
      <div class="claimwrap">
        <div v-for="t in unclaimed" :key="t.id" class="claim">
          <b class="num">{{ t.sample_id }}</b>
          <span>{{ t.analyte }}</span>
          <span v-if="t.due_at" class="duechip" :class="{ over: t.due_at < todayStr }">限 {{ t.due_at }}</span>
          <el-button size="small" type="primary" plain @click="doClaim(t)">认领</el-button>
        </div>
      </div>
    </div>

    <!-- 同表批量录入：一张表多样品（可跨委托），按编号自动归各自合同 -->
    <div v-if="batchMode" class="card" style="padding:16px">
      <BatchEntry :samples="samples" :my-tasks="myTasks" @saved="onBatchSaved" />
    </div>

    <div v-else class="split">
      <!-- 左：登记 + 列表 -->
      <div class="left">
        <section v-if="showReg" class="regsec">
          <div class="sechead"><h2>自送样登记</h2></div>
          <div class="card">
            <p class="reg-hint">客户直接送样、不走委托流程时在此登记；有委托来源的样品由派工 / 采样流程自动入库，无需在这里手动登记。</p>
            <div class="reg-body">
              <label>受检单位<input v-model="form.client" placeholder="如：山东甲厂" /></label>
              <label>样品基质
                <select v-model="form.matrix">
                  <option v-for="m in MATRICES" :key="m" :value="m">{{ m }}</option>
                </select>
              </label>
              <label class="wide">检测项目<input v-model="form.items" placeholder="锌, COD, 氨氮（逗号分隔）" /></label>
              <label class="wide">备注<input v-model="form.note" placeholder="采样点位 / 说明（可空）" /></label>
              <el-button type="primary" :loading="submitting" @click="register">登记并生成编号</el-button>
            </div>
          </div>
        </section>

        <section class="listsec">
          <div class="sechead">
            <h2>样品列表</h2>
            <span class="seccount num">{{ shown.length }} 条</span>
          </div>
          <div class="card list-card">
            <div class="filters">
              <span class="chips">
                <span v-for="[lab, val] in STATUS" :key="val" class="chip" :class="{ on: statusFilter === val }" @click="setStatus(val)">{{ lab }}</span>
                <span v-if="myTasks.length" class="chip mine" :class="{ on: onlyMine }" @click="toggleMine">我的任务<i class="num">{{ myTaskSampleIds.size }}</i></span>
              </span>
              <input v-model="keyword" class="search" placeholder="搜编号 / 单位 / 项目 / 委托号…" />
              <span v-if="contractOpts.length" class="pchips">
                <span class="pchip" :class="{ on: contractFilter === '' }" @click="contractFilter = ''">全部项目</span>
                <span v-for="[cid, n] in contractOpts" :key="cid" class="pchip" :class="{ on: contractFilter === cid }" @click="contractFilter = cid">{{ cid }}<i class="num">{{ n }}</i></span>
              </span>
            </div>
            <div class="list" v-loading="loading">
              <template v-for="(s, si) in paged" :key="s.id">
              <div v-if="showGrpHead(si)" class="grp-head">
                <b>{{ s.contract_id ? (s.client || '（未填单位）') : '散样 · 客户送检' }}</b>
                <span v-if="s.contract_id" class="mono gcid">{{ s.contract_id }}</span>
              </div>
              <div class="item ingrp" :class="{ on: selected?.id === s.id }" @click="select(s)">
                <div class="itop">
                  <span class="sid mono">{{ s.id }}</span>
                  <span class="sst"><span class="sdot" :class="statusTone[s.status]"></span>{{ statusLabel[s.status] || s.status }}</span>
                </div>
                <div class="isub">{{ isBlindView ? '盲样' : (s.client || '（未填单位）') }} · {{ s.matrix }}<span v-if="s.items.length"> · {{ s.items.join('、') }}</span></div>
                <div v-if="s.contract_id" class="ifrom">来自委托 <span class="mono lk">{{ s.contract_id }}</span><span v-if="s.round_id" class="rno">第{{ (s.round_id.match(/-R(\d+)$/) || [])[1] }}期</span></div>
                <div v-else-if="isBlindView" class="ifrom">盲样模式 · 受检单位与点位不可见</div>
                <div v-else class="ifrom">自送样 · 客户送检，无委托来源</div>
              </div>
              </template>
              <div v-if="!shown.length && !loading" class="empty">{{ samples.length ? '没有匹配的样品' : '还没有样品，先在上面登记一个' }}</div>
            </div>
            <el-pagination v-if="shown.length > PAGE_SIZE" class="pager" layout="total, prev, pager, next"
              :total="shown.length" :page-size="PAGE_SIZE" v-model:current-page="page" size="small" />
          </div>
        </section>
      </div>

      <!-- 右：录入 -->
      <div class="right card">
        <template v-if="selected">
          <div class="dhead">
            <div class="dh-main">
              <div class="dname">
                <span class="mono">{{ selected.id }}</span>
                <span class="pill" :class="statusTone[selected.status]">{{ statusLabel[selected.status] }}</span>
                <span v-if="selected.source === 'self'" class="pill">自送样</span>
                <span v-if="selected.storage" class="pill" :title="'保存条件（来自交接单）'">{{ selected.storage }}</span>
                <template v-if="selected.status === 'rejected'">
                  <span v-if="selected.replaced_by" class="pill good">已补采 {{ selected.replaced_by }}</span>
                  <el-button v-else-if="can('handover_send')" size="small" type="warning" :loading="resampleBusy" @click="doResample">补采</el-button>
                </template>
              </div>
              <div class="dsub">{{ isBlindView ? '盲样' : (selected.client || '（未填单位）') }} · {{ selected.matrix }}<span v-if="selected.items.length"> · 检测项目：{{ selected.items.join('、') }}</span></div>
            </div>
          </div>

          <div class="steps">
            <!-- 步骤① 样品交接确认（6.1.4）-->
            <section class="step" :class="{ open: showHo }">
              <button class="step-h" @click="showHo = !showHo">
                <span class="step-no">1</span>
                <span class="step-t">样品交接确认</span>
                <span class="step-sum">
                  <template v-if="handovers.length">{{ handovers.length }} 条流转<em v-if="pendingHo" class="warn">· {{ pendingHo }} 待签收</em></template>
                  <template v-else>确认接样入库 / 流转领用留痕</template>
                </span>
                <el-icon class="step-chev"><ArrowRight /></el-icon>
              </button>
              <div v-if="showHo" class="step-body">
                <div class="ho-timeline">
                  <div v-for="h in handovers" :key="h.id" class="ho-ev">
                    <span class="ho-act">{{ h.action }}</span>
                    <span class="ho-flow"><b>{{ h.from_person || '—' }}</b> → <b>{{ h.to_person || '—' }}</b></span>
                    <span v-if="h.condition" class="ho-cond">
                      <span class="sdot" :class="h.condition === '完好' ? 'good' : 'crit'"></span>{{ h.condition }}
                    </span>
                    <span v-if="h.note" class="ho-note">{{ h.note }}</span>
                    <span class="ho-meta mono">{{ h.who }} · {{ hoTime(h.at) }}</span>
                    <span v-if="h.confirmed_at" class="ho-sign good">✓ 已签收 · {{ h.confirmed_by }}</span>
                    <template v-else>
                      <span class="ho-sign warn">待接收方确认</span>
                      <el-button v-if="canConfirmHo" size="small" text type="primary" @click="confirmHo(h)">确认签收</el-button>
                      <span v-else class="ho-wait">待质控员签收</span>
                    </template>
                    <RecordAttachments type="handover" :id="h.id" />
                  </div>
                  <div v-if="!handovers.length" class="ho-empty">还没有交接记录。采样交接、接样入库、流转领用、留样、处置都在这里留痕。</div>
                </div>
                <div v-if="can('handover_send')" class="ho-add">
                  <select v-model="hoForm.action"><option v-for="a in HANDOVER_ACTIONS" :key="a" :value="a">{{ a }}</option></select>
                  <input v-model="hoForm.fromPerson" placeholder="交出人" />
                  <input v-model="hoForm.toPerson" placeholder="接收人" />
                  <input v-model="hoForm.condition" placeholder="样品状态（完好/破损…）" />
                  <input v-model="hoForm.note" placeholder="备注（可空）" />
                  <el-button size="small" type="primary" :loading="hoSaving" @click="submitHandover">记一条</el-button>
                </div>
              </div>
            </section>

            <!-- 步骤② 检测任务派工（PRD 步骤5：质控员按项目派检测员）-->
            <section class="step" :class="{ open: showTasks }">
              <button class="step-h" @click="showTasks = !showTasks">
                <span class="step-no">2</span>
                <span class="step-t">检测任务派工</span>
                <span class="step-sum">
                  <template v-if="tasks.length">{{ tasks.map(t => `${t.analyte}→${t.assignee}`).join(' · ') }}</template>
                  <template v-else-if="selected.round_id"><em class="warn">还没派活——质控员签收后在此把项目派给检测员</em></template>
                  <template v-else>自送样可不派（登记人直接测）</template>
                </span>
                <el-icon class="step-chev"><ArrowRight /></el-icon>
              </button>
              <div v-if="showTasks" class="step-body">
                <div class="ho-timeline">
                  <div v-for="t in tasks" :key="t.id" class="ho-ev">
                    <span class="ho-act">{{ t.analyte }}</span>
                    <span class="ho-flow">→ <b>{{ t.assignee }}</b></span>
                    <span class="ho-f">{{ TASK_ST[t.record_status] || t.record_status }}</span>
                    <span class="ho-meta mono">{{ t.assigned_by }} 派 · {{ hoTime(t.assigned_at) }}</span>
                    <el-button v-if="canAssignTasks && t.record_status === 'none'" size="small" text type="danger" @click="cancelTask(t)">取消</el-button>
                    <el-button v-if="t.record_status === 'none' && t.assignee === currentUser?.name" size="small" text @click="unclaim(t)">退回认领池</el-button>
                  </div>
                  <div v-if="!tasks.length" class="ho-empty">还没有派工记录。质控员确认签收后，在下面把每个检测项目派给检测员；检测员只能录派给自己的项目。</div>
                </div>
                <div v-if="canAssignTasks && selected.items.length" class="ho-add task-add">
                  <template v-for="a in selected.items" :key="a">
                    <label class="task-row">{{ a }}
                      <select v-model="taskDraft[a]">
                        <option value="">（选检测员）</option>
                        <option v-for="p in testers" :key="p.username || p.name" :value="p.name">{{ p.name }}</option>
                      </select>
                    </label>
                  </template>
                  <el-button size="small" type="primary" :loading="taskSaving" :disabled="taskSaving" @click="saveTasks">{{ tasks.length ? '改派' : '派任务' }}</el-button>
                </div>
                <div v-else-if="canAssignTasks" class="ho-empty">该样品没有检测项目清单，无法按项目派活。</div>
              </div>
            </section>

            <!-- 步骤③ 前处理（6.1.5）-->
            <section class="step" :class="{ open: showPre }">
              <button class="step-h" @click="showPre = !showPre">
                <span class="step-no">3</span>
                <span class="step-t">前处理</span>
                <span class="step-sum">
                  <template v-if="pres.length">{{ pres.length }} 条记录</template>
                  <template v-else>消解 / 萃取 / 浓缩 / 定容留痕（无前处理可跳过）</template>
                </span>
                <el-icon class="step-chev"><ArrowRight /></el-icon>
              </button>
              <div v-if="showPre" class="step-body">
                <div class="ho-timeline">
                  <div v-for="p in pres" :key="p.id" class="ho-ev">
                    <span class="ho-act">{{ p.method }}</span>
                    <span v-if="p.reagent" class="ho-f">试剂 {{ p.reagent }}</span>
                    <span v-if="p.condition" class="ho-f">条件 {{ p.condition }}</span>
                    <span v-if="p.vol_final" class="ho-f">定容 {{ p.vol_final }}</span>
                    <span v-if="p.note" class="ho-note">{{ p.note }}</span>
                    <span class="ho-meta mono">{{ p.who }} · {{ hoTime(p.at) }}</span>
                    <RecordAttachments type="pretreatment" :id="p.id" />
                  </div>
                  <div v-if="!pres.length" class="ho-empty">还没有前处理记录。消解 / 萃取 / 浓缩 / 定容等在这里留痕。</div>
                </div>
                <div v-if="canPre" class="ho-add">
                  <select v-model="preForm.method"><option v-for="m in PRETREAT_METHODS" :key="m" :value="m">{{ m }}</option></select>
                  <input v-model="preForm.reagent" placeholder="所用试剂" />
                  <!-- 条件里的 ℃ 这类符号键盘打不出来，带符号小键盘 -->
                  <SymbolInput v-model="preForm.condition" placeholder="条件 如 180℃ 30min" />
                  <input v-model="preForm.volFinal" placeholder="定容体积" />
                  <input v-model="preForm.note" placeholder="备注（可空）" />
                  <el-button size="small" type="primary" :loading="preSaving" @click="submitPre">记一条</el-button>
                </div>
              </div>
            </section>

            <!-- 留样与处置（批次三）：质控员登记留样位置/期限，到期处置留痕 -->
            <section v-if="canConfirmHo || retention" class="step">
              <div class="step-h static">
                <span class="step-no">留</span>
                <span class="step-t">留样与处置</span>
                <span v-if="retention" class="step-sum">{{ retention.location }} · 存至 {{ retention.until_date || '未定' }}<template v-if="retention.disposed_at"> · 已处置（{{ retention.dispose_method }}）</template></span>
                <span v-else class="step-sum">未登记留样</span>
              </div>
              <div v-if="canConfirmHo && !retention?.disposed_at" class="ho-add">
                <input v-model="retForm.location" placeholder="留样位置 如 留样柜A-3" />
                <input v-model="retForm.until" type="date" title="留存期限" />
                <el-button size="small" @click="submitRetention">{{ retention ? '更新' : '登记留样' }}</el-button>
                <el-button v-if="retention" size="small" type="danger" plain @click="submitDispose">处置</el-button>
              </div>
            </section>

            <!-- 比对数据录入（在线比对项目专用：A/B成对数据 → 判定引擎自动出比对块） -->
            <section v-if="can('record_save')" class="step" :class="{ open: showCmp }">
              <button class="step-h" @click="showCmp = !showCmp">
                <span class="step-no">比</span>
                <span class="step-t">比对数据录入</span>
                <span class="step-sum">在线比对项目用：录 在线仪器 vs 实验室 成对数据，报告自动判定</span>
                <el-icon class="step-chev"><ArrowRight /></el-icon>
              </button>
              <div v-if="showCmp" class="step-body">
                <div v-for="(g, gi) in cmpGroups" :key="gi" class="cmp-group">
                  <div class="cmp-head">
                    <select v-model="g.type">
                      <option value="conc">实际水样测定</option><option value="pH">pH</option>
                      <option value="qc">质控样</option><option value="flow">流量</option><option value="level">液位</option>
                    </select>
                    <input v-model="g.analyte" placeholder="项目 如 CODcr" style="width:110px" />
                    <input v-if="g.type === 'qc'" v-model="g.stdValue" placeholder="标样浓度" style="width:90px" />
                    <el-button size="small" text type="danger" @click="cmpGroups.splice(gi, 1)">删组</el-button>
                  </div>
                  <div v-for="(pr, pi) in g.pairs" :key="pi" class="cmp-pair">
                    <input v-model="pr.time" placeholder="时间 如 09:30" style="width:90px" />
                    <input v-model="pr.online" placeholder="在线值" style="width:90px" />
                    <input v-model="pr.lab" placeholder="实验室值" style="width:90px" />
                    <el-button size="small" text type="danger" @click="g.pairs.splice(pi, 1)">删</el-button>
                  </div>
                  <el-button size="small" text @click="g.pairs.push({ time: '', online: '', lab: '' })">+ 加一对</el-button>
                </div>
                <div class="cmp-acts">
                  <el-button size="small" @click="cmpGroups.push({ type: 'conc', analyte: '', stdValue: '', pairs: [{ time: '', online: '', lab: '' }] })">+ 加比对组</el-button>
                  <el-button size="small" type="primary" :loading="cmpSaving" :disabled="!cmpGroups.length" @click="saveCompare(false)">保存</el-button>
                  <el-button size="small" type="primary" :loading="cmpSaving" :disabled="!cmpGroups.length" @click="saveCompare(true)">保存并提交复核</el-button>
                </div>
              </div>
            </section>

            <!-- 步骤④ 选表录数据 -->
            <section class="step step-main">
              <div class="step-h static">
                <span class="step-no">4</span>
                <span class="step-t">选表录数据</span>
                <span class="step-sum">按 {{ selected.matrix }} + 本样品检测项目筛记录表</span>
              </div>
              <div class="main-body">
                <div v-if="!chosenTpl" class="picker">
                  <div class="pk-h">
                    <div class="sechead">
                      <span v-if="selected.items.length && matchedTpls.length && !tplKeyword.trim()" class="pk-scope">
                        <template v-if="!showAllTpls">已按本样品项目筛出 <b class="num">{{ matchedTpls.length }}</b> 张 · <a @click="showAllTpls = true">显示全部 {{ baseTpls.length }} 张 →</a></template>
                        <template v-else>显示全部 <b class="num">{{ baseTpls.length }}</b> 张 · <a @click="showAllTpls = false">只看本样品项目（{{ matchedTpls.length }}）→</a></template>
                      </span>
                      <span v-else class="pk-scope">{{ selected.matrix }} 下的原始记录 / 前处理表</span>
                    </div>
                    <input v-model="tplKeyword" class="pk-search" placeholder="搜检测项目 / 表号 / 方法…" />
                  </div>
                  <div class="pk-list">
                    <div v-for="t in candidateTpls" :key="t.file" class="pk-item" @click="chosenTpl = t">
                      <div class="pk-name">{{ t.raw }}</div>
                      <div class="pk-sub"><span class="mono">{{ t.code }}</span> · {{ t.method }} · {{ t.analyte }}</div>
                    </div>
                    <div v-if="!candidateTpls.length" class="empty">该基质下暂无匹配记录表</div>
                  </div>
                </div>

                <div v-else class="entry">
                  <div class="entry-bar">
                    <span class="back" @click="backToPicker">← 换一张表</span>
                    <span class="etpl">{{ chosenTpl.raw }}</span>
                  </div>
                  <StructuredSheet
                    :key="selected.id + chosenTpl.file"
                    :sample-id="selected.id"
                    :template-name="chosenTpl.raw"
                    :analyte="chosenTpl.analyte" :method="chosenTpl.method" :matrix="chosenTpl.matrix"
                    :code="chosenTpl.code" :sheet-type="chosenTpl.sheetType"
                    :readonly="!can('record_save')" lock-text="只有检测员能填写检测原始记录" />
                </div>
              </div>
            </section>
          </div>
        </template>
        <div v-else class="rest">左侧选一个样品，或先登记一个</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 页头 */
.pagewrap{display:flex;flex-direction:column;height:calc(100vh - 58px - 44px)}
.phead{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:16px;flex:none}
.page{font-size:22px;font-weight:650;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--muted);margin:0;font-size:13px}
.hact{display:flex;align-items:center;gap:14px;flex:none}
.hcount{color:var(--faint);font-size:12.5px}

.split{flex:1;display:grid;grid-template-columns:360px 1fr;gap:16px;min-height:0}
.left{display:flex;flex-direction:column;gap:20px;min-height:0}
.regsec{flex:none}
.listsec{flex:1;display:flex;flex-direction:column;min-height:0}
.seccount{font-size:12px;color:var(--faint)}

/* 自送样登记 */
.reg-hint{margin:0;padding:12px 16px 0;font-size:12px;color:var(--faint);line-height:1.55}
.reg-body{padding:14px 16px;display:grid;grid-template-columns:1fr 1fr;gap:12px}
.reg-body label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted);min-width:0}
.reg-body label.wide{grid-column:1 / -1}
.reg-body input,.reg-body select{width:100%;min-width:0;border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:7px 9px;font-size:13px;font-family:inherit;color:var(--ink);background:var(--surface)}
.reg-body input:focus,.reg-body select:focus{outline:2px solid var(--accent);outline-offset:-1px}
.reg-body .el-button{grid-column:1 / -1}

/* 样品列表：队列形态 */
.list-card{flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden}
.filters{padding:12px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:8px;flex:none}
.chips{display:flex;gap:4px}
.chip{font-size:11.5px;padding:3px 10px;border-radius:20px;color:var(--muted);cursor:pointer;transition:background .12s ease,color .12s ease}
.chip:hover{background:var(--surface-2)}
.chip.on{background:var(--accent-soft);color:var(--accent-ink);font-weight:600}
.search{width:100%;border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:7px 10px;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--ink)}
.search:focus{outline:2px solid var(--accent);outline-offset:-1px}
.pchips{display:flex;flex-wrap:wrap;gap:4px}
.pchip{font-size:11px;padding:2px 8px;border-radius:20px;color:var(--faint);cursor:pointer;transition:background .12s ease,color .12s ease}
.pchip:hover{background:var(--surface-2)}
.pchip.on{background:var(--accent-soft);color:var(--accent-ink);font-weight:600}
.pchip i{font-style:normal;color:var(--faint);margin-left:4px}
.grp-head{display:flex;align-items:center;gap:8px;padding:6px 14px;background:var(--surface-2);border-bottom:1px solid var(--line);font-size:12px;position:sticky;top:0;z-index:1}
.grp-head b{font-size:12.5px}
.gcid{color:var(--faint);font-size:11px}

.list{flex:1;overflow-y:auto}
.pager{flex:none;padding:8px 12px;border-top:1px solid var(--line);justify-content:center}
.item{padding:11px 16px;cursor:pointer;border-bottom:1px solid var(--line);border-left:2px solid transparent;transition:background .12s ease}
.item:last-child{border-bottom:0}
.item:hover{background:var(--surface-2)}
.item.on{background:var(--accent-soft);border-left-color:var(--accent)}
.itop{display:flex;align-items:center;justify-content:space-between;gap:8px}
.sid{font-size:13px;font-weight:600;color:var(--ink)}
.sst{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--muted);white-space:nowrap}
.isub{font-size:12px;color:var(--muted);margin-top:4px;line-height:1.4}
.ifrom{font-size:11.5px;color:var(--faint);margin-top:3px}
.ifrom .lk{color:var(--accent-ink)}
.ifrom .rno{margin-left:6px;color:var(--accent-ink);font-weight:600}
.empty{padding:26px 16px;color:var(--faint);font-size:13px;text-align:center}
.rest{padding:32px;color:var(--faint);font-size:13px;text-align:center}

/* 右：录入 */
.right{display:flex;flex-direction:column;min-height:0;overflow:hidden}
.dhead{padding:14px 18px;border-bottom:1px solid var(--line);display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex:none}
.dname{font-size:15px;font-weight:650;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsub{font-size:12.5px;color:var(--muted);margin-top:5px}

/* 分步区块：① 交接确认 → ② 前处理 → ③ 选表录数据 */
.steps{flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden}
.step{flex:none;border-bottom:1px solid var(--line)}
.step-h{width:100%;display:flex;align-items:center;gap:10px;padding:11px 18px;background:var(--surface);border:0;font-family:inherit;text-align:left;color:inherit}
button.step-h{cursor:pointer;transition:background .12s ease}
button.step-h:hover{background:var(--surface-2)}
.step-h.static{cursor:default}
.step-no{width:20px;height:20px;border-radius:50%;background:var(--surface-2);color:var(--faint);font-size:11.5px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex:none}
.step.open .step-no,.step-main .step-no{background:var(--accent-soft);color:var(--accent-ink)}
.step-t{font-size:13px;font-weight:600;color:var(--ink)}
.step-sum{font-size:11.5px;color:var(--faint)}
.step-sum em{font-style:normal;margin-left:2px}
.step-sum em.warn{color:var(--crit);font-weight:600}
.step-chev{margin-left:auto;color:var(--faint);font-size:14px;transition:transform .15s ease}
.step.open .step-chev{transform:rotate(90deg)}
.step-main{flex:1;display:flex;flex-direction:column;min-height:0;border-bottom:0}
.main-body{flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden}

/* 交接 / 前处理：区块内行列表 */
.step-body{padding:12px 18px 14px;background:var(--surface-2)}
.step:not(.step-main) .step-body{max-height:300px;overflow-y:auto}
.ho-timeline{display:flex;flex-direction:column;margin-bottom:11px}
.ho-ev{display:flex;align-items:center;gap:10px;font-size:12.5px;flex-wrap:wrap;padding:7px 0;border-bottom:1px solid var(--line)}
.ho-ev:last-child{border-bottom:0}
.ho-act{font-weight:600;color:var(--ink);font-size:12.5px}
.ho-f{font-size:12px;color:var(--muted)}
.ho-flow{color:var(--faint)}
.ho-flow b{color:var(--ink);font-weight:500}
.ho-cond{display:inline-flex;align-items:center;gap:5px;color:var(--muted);font-size:12px}
.ho-note{color:var(--muted);font-size:12px}
.ho-meta{margin-left:auto;color:var(--faint);font-size:11.5px}
.ho-sign{font-size:11px;font-weight:650;padding:1px 7px;border-radius:5px}
.ho-sign.good{color:var(--good);background:var(--good-soft)}
.ho-sign.warn{color:var(--crit);background:var(--crit-soft)}
.ho-empty{font-size:12.5px;color:var(--faint);line-height:1.6;padding:2px 0 4px}
.ho-wait{font-size:11.5px;color:var(--faint)}
.chip.mine{border-style:dashed}
.chip.mine .num{margin-left:4px;font-style:normal}
.task-add{flex-wrap:wrap}
.task-row{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted)}
.task-row select{min-width:110px}
.ho-add{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.ho-add input,.ho-add select{border:1px solid var(--line-strong);border-radius:6px;padding:6px 8px;font-size:12px;font-family:inherit;background:var(--surface);color:var(--ink)}
.ho-add input{min-width:90px;flex:1}

/* 记录表选择：行式 */
.picker{flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden}
.pk-h{padding:16px 18px 12px;border-bottom:1px solid var(--line);flex:none}
.pk-scope{font-size:11.5px;color:var(--faint)}
.pk-scope b{color:var(--ink);font-weight:600}
.pk-scope a{color:var(--accent);cursor:pointer}
.pk-scope a:hover{text-decoration:underline}
.pk-search{width:100%;border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:8px 11px;font-size:13px;font-family:inherit;color:var(--ink);background:var(--surface)}
.pk-search:focus{outline:2px solid var(--accent);outline-offset:-1px}
.pk-list{flex:1;overflow-y:auto}
.pk-item{padding:11px 18px;border-bottom:1px solid var(--line);cursor:pointer;transition:background .12s ease}
.pk-item:last-child{border-bottom:0}
.pk-item:hover{background:var(--surface-2)}
.pk-name{font-size:13px;font-weight:600;color:var(--ink);line-height:1.4}
.pk-sub{font-size:11.5px;color:var(--muted);margin-top:3px}

.entry{flex:1;overflow-y:auto;display:flex;flex-direction:column;min-height:0}
.entry-bar{display:flex;align-items:center;gap:12px;padding:10px 18px;border-bottom:1px solid var(--line);background:var(--surface-2);flex:none}
.back{font-size:12.5px;color:var(--accent);cursor:pointer}
.back:hover{text-decoration:underline}
.etpl{font-size:12.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

@media (max-width:1100px){
  .hcount{display:none}
}

/* 交接单面板 */
.hosheet-card{padding:14px 16px;margin-bottom:14px}
.hosheet-head{display:flex;align-items:baseline;gap:10px;margin-bottom:8px}
.hosheet-head .muted{font-size:12px}
.hosheet{border-top:1px solid var(--line);padding:8px 0}
.hosheet-line{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.hosheet-line .spacer{flex:1}
.hosheet-detail{margin-top:8px;background:var(--surface-2);border-radius:8px;padding:10px 12px}
.hosheet-table{width:100%;border-collapse:collapse;font-size:13px}
.hosheet-table th{text-align:left;color:var(--muted);font-weight:500;padding:4px 8px;border-bottom:1px solid var(--line)}
.hosheet-table td{padding:5px 8px;border-bottom:1px solid var(--line)}
.hosheet-table tr:last-child td{border-bottom:none}
.plink{font-size:12px;color:var(--accent);text-decoration:none;white-space:nowrap}
.plink:hover{text-decoration:underline}
.claimwrap{display:flex;flex-wrap:wrap;gap:8px}
.claim{display:flex;align-items:center;gap:10px;border:1px solid var(--line);border-radius:8px;padding:6px 12px;background:var(--surface-2)}

/* 手机：双栏堆叠 */
@media (max-width:760px){
  .split{grid-template-columns:1fr}
  .list{max-height:45vh}
}
.duechip{font-size:11px;color:var(--warn);background:var(--warn-soft);border-radius:20px;padding:1px 8px}
.duechip.over{color:var(--crit);background:var(--crit-soft)}
.cmp-group{border:1px solid var(--line);border-radius:var(--radius-sm);padding:8px 10px;margin-bottom:8px}
.cmp-head,.cmp-pair,.cmp-acts{display:flex;align-items:center;gap:8px;margin:4px 0;flex-wrap:wrap}
.cmp-head select,.cmp-head input,.cmp-pair input{border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:4px 8px;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--ink)}
</style>
