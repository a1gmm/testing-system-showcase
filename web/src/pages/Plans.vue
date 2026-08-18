<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, currentUser, QC_TYPES, UNIT_OPTS, type DueRound, type RoundDetail, type FieldInfo, type QcRecord, type QcRequirement } from '../api'
import { can } from '../permissions'
import { confirmIfDirty, hasDirty } from '../utils/dirty'
import { todayLocal } from '../utils/date'
import RecordAttachments from '../components/RecordAttachments.vue'
import StructuredSheet from '../components/StructuredSheet.vue'
import templatesJson from '../data/templates.json'
import { templatePhase } from '../data/phase'
import { FORMS } from '../data/forms'
import { defaultStage, type StageKey } from '../utils/roundStage'
import { buildRoundSheetSeed, initialSheetCodes, samplingSheetsForMatrix } from '../utils/samplingWorkflow'

// 采样单池 = 作业环节为"现场"的表（采样记录 + 挂在原始记录里的现场直读/比对表），按基质匹配；交接表在样品页挂附件
type Tpl = { code: string; name: string; analyte: string; matrix: string; method: string; sheetType: string; file: string; raw?: string; phase?: string; stage?: string }
const SAMPLING_SHEETS = (templatesJson as Tpl[]).filter(t => templatePhase(t) === '现场')
function sheetsForMatrix(matrix: string): Tpl[] {
  const hit = samplingSheetsForMatrix(SAMPLING_SHEETS, matrix)
  // 基质没标的采样单（臭气/油烟等）按项目名兜底匹配
  return hit.length ? hit : SAMPLING_SHEETS.filter(t => t.analyte && matrix.includes(t.analyte))
}
// 固废最小份样数（HJ 298-2019，与后端同表）
const SW_PORTIONS: [number, number][] = [[5, 5], [25, 8], [50, 13], [90, 20], [150, 32], [500, 50], [1000, 80]]
const swMinPortions = (tons: number) => { for (const [cap, n] of SW_PORTIONS) if (tons <= cap) return n; return 100 }

const router = useRouter()
const rollupLabel: Record<string, string> = { pending: '待检测', testing: '检测中', review: '待审核', approved: '已审核' }
const FILTERS = [['', '全部'], ['todo', '待派工'], ['assigned', '待采样'], ['done', '已采样']] as [string, string][]

const rounds = ref<DueRound[]>([])
const detail = ref<RoundDetail | null>(null)
const filter = ref('')
const keyword = ref('')
const loading = ref(false)
const assign = ref({ samplers: [] as string[], planDate: '' })

function stateOf(r: DueRound) { return r.status === 'failed' ? 'failed' : (r.status === 'cancelled' ? 'cancelled' : (r.status === 'done' ? 'done' : (r.status === 'rescheduled' ? 'rescheduled' : (r.sampler ? 'assigned' : 'todo')))) }
const stateLabel: Record<string, string> = { todo: '待派工', assigned: '已派工·待采样', done: '已采样', failed: '未采成·待改期', rescheduled: '已改期·待采样', cancelled: '已终止' }
// 状态 → 语义色调（仅用于圆点/胶囊）；已终止不上色（灰）
const stateTone: Record<string, string> = { todo: 'warn', assigned: 'accent', done: 'good', failed: 'warn', rescheduled: 'accent', cancelled: '' }
const rollupTone: Record<string, string> = { pending: '', testing: 'accent', review: 'warn', approved: 'good' }
const bucketTone: Record<string, string> = { overdue: 'crit', soon: 'warn', later: '', done: 'good' }

async function refresh() {
  loading.value = true
  try {
    rounds.value = await api.listAllRounds()
    if (detail.value) detail.value = await api.getRoundDetail(detail.value.round.id)
  } catch (e: any) { ElMessage.error('后端未连接？' + (e?.message || e)) }
  finally { loading.value = false }
}
const shown = computed(() => rounds.value.filter(r => {
  if (filter.value && stateOf(r) !== filter.value) return false
  if (keyword.value) {
    const k = keyword.value.toLowerCase()
    if (!(r.client + (r.project || '') + r.contract_id + (r.sampler || '')).toLowerCase().includes(k)) return false
  }
  return true
}))
// 该干的排前面：逾期 > 临近 > 以后 > 已采
const ORDER: Record<string, number> = { overdue: 0, soon: 1, later: 2, done: 3 }
const sorted = computed(() => [...shown.value].sort((a, b) => (Number(b.urgent || 0) - Number(a.urgent || 0)) || (ORDER[a.bucket] ?? 9) - (ORDER[b.bucket] ?? 9) || a.due_date.localeCompare(b.due_date)))
// 按合同聚合（2026-07-31 用户反馈：一个合同12期平铺会把别家淹了）——
// 组按"组内最急期次"排（sorted 已排好、Map 保序即组序）；默认折叠只看摘要，单期合同直接展开
const groups = computed(() => {
  const m = new Map<string, { contractId: string; client: string; project: string; rounds: typeof sorted.value }>()
  for (const r of sorted.value) {
    if (!m.has(r.contract_id)) m.set(r.contract_id, { contractId: r.contract_id, client: r.client, project: r.project || '', urgent: !!(r as any).urgent, rounds: [] } as any)
    m.get(r.contract_id)!.rounds.push(r)
  }
  return [...m.values()]
})
const expanded = ref<Record<string, boolean>>({})
const isOpen = (g: { contractId: string; rounds: any[] }) => expanded.value[g.contractId] ?? g.rounds.length === 1
// 组摘要：各状态数一眼看清
function grpSummary(g: { rounds: any[] }): string {
  const n: Record<string, number> = {}
  for (const r of g.rounds) n[stateOf(r)] = (n[stateOf(r)] || 0) + 1
  return (['todo', 'assigned', 'failed', 'rescheduled', 'done'] as const).filter(s => n[s]).map(s => `${stateLabel[s]} ${n[s]}`).join(' · ')
}
const alerts = computed(() => rounds.value.filter(r => r.bucket === 'overdue' || r.bucket === 'soon'))

const field = ref<FieldInfo>({})
// 方案里约定的点位（供现场记录参考，实际不同可改）
const plannedPoints = computed(() =>
  (detail.value?.contract?.scheme?.points || []).map((p: any) => p.point).filter(Boolean).join('、'))

// —— S4：本期基质 → 专项开关 + 采样单匹配 + 质控要求 ——
const roundMatrices = computed(() => [...new Set((detail.value?.planItems || []).map(p => p.matrix))])
const hasNoise = computed(() => roundMatrices.value.includes('噪声'))
const hasSolid = computed(() => roundMatrices.value.includes('固废'))
const swHint = computed(() => {
  const t = Number(field.value.tons)
  return isFinite(t) && t > 0 ? swMinPortions(t) : 0
})
const qcReqs = ref<QcRequirement[]>([])
const qcReqText = computed(() =>
  qcReqs.value.map(q => `${q.qcType}×${q.qty}（${q.matrix}）`).join('、'))
// 每个基质对应的采样单（open() 时已初始化，默认选第一张，可换）
function initSheets(matrices: string[]) {
  if (!field.value.sheets) field.value.sheets = {}
  if (!field.value.sheetCodes) field.value.sheetCodes = {}
  if (!field.value.sheetDrafts) field.value.sheetDrafts = {}
  for (const m of matrices) {
    const t = sheetsForMatrix(m)[0]
    field.value.sheetCodes[m] = initialSheetCodes(field.value, m, t?.code || '')
    if (!field.value.sheets[m]) field.value.sheets[m] = { code: t?.code || '', name: t?.name || '' }
  }
}
function selectedSheetCodes(matrix: string) {
  if (!field.value.sheetCodes?.[matrix]) initSheets([matrix])
  return field.value.sheetCodes![matrix]
}
function sheetDraft(code: string) {
  if (!field.value.sheetDrafts) field.value.sheetDrafts = {}
  if (!field.value.sheetDrafts[code]) field.value.sheetDrafts[code] = { code, name: tplOf(code)?.name || '', point: '', character: '', method: '', container: '', note: '' }
  return field.value.sheetDrafts[code]
}
async function pickSheets(matrix: string, codes: string[]) {
  if (!(await confirmIfDirty())) return   // 正填着的采样单没保存就换表？先拦一道
  field.value.sheetCodes![matrix] = [...new Set(codes.filter(Boolean))]
}
// 选中的采样单在模板库有精确版式的，现场直接填整张表（存 round_sheets）；没有的退回5格简化版
function tplOf(code: string) { return SAMPLING_SHEETS.find(x => x.code === code) }
function hasFullForm(code: string) { return !!FORMS[code] }
function roundSheetSeed(matrix: string) {
  const r = detail.value!.round
  return buildRoundSheetSeed({ plannedDate: r.plan_date || r.due_date, organization: detail.value!.contract?.client || '', projectNo: r.contract_id, planItems: detail.value!.planItems, matrix })
}
function roundSheetAttachmentId(code: string) { return `${detail.value!.round.id}::${code}` }

// 三段式：dispatch 排产派工 / field 现场采样 / stock 样品与质控；按状态自动展开当前段
const openStage = ref<StageKey | ''>('dispatch')
function toggleStage(k: StageKey) { openStage.value = openStage.value === k ? '' : k }

async function open(id: string) {
  if (detail.value && detail.value.round.id !== id && !(await confirmIfDirty())) return
  try {
    detail.value = await api.getRoundDetail(id)
    openStage.value = defaultStage(detail.value.round)
    assign.value = {
      samplers: [...(detail.value.round.sampler_ids || [])],
      planDate: detail.value.round.plan_date || detail.value.round.due_date || '',
    }
    field.value = { ...(detail.value.round.field_info || { date: detail.value.round.plan_date || detail.value.round.due_date }) }
    initSheets([...new Set(detail.value.planItems.map(p => p.matrix))])
    qcReqs.value = []
    api.roundQcReqs(id).then(r => { qcReqs.value = r }).catch(() => {})
    await loadQc()
    await loadPoints()
    await loadRoundCheckouts()
  } catch (e: any) { ElMessage.error(e?.message || e) }
}

// —— 本期质控（6.1.5）：密码样 / 平行样 / 加标回收 / 空白，自动判合格 ——
const QC_TYPES_ = QC_TYPES
const canQc = computed(() => can('qc_add'))
const canAssign = computed(() => can('round_assign'))
const canFlow = computed(() => can('round_flow'))     // 采不成/改期
const canField = computed(() => can('round_field'))   // 现场采样/收样入库
const qc = ref<QcRecord[]>([])
const qcForm = ref<any>({ qcType: '平行样', analyte: '', unit: 'mg/L' })
async function loadQc() {
  qc.value = []
  if (!detail.value) return
  try { qc.value = await api.listRoundQc(detail.value.round.id) } catch { /* */ }
}
const qcSaving = ref(false)
async function submitQc() {
  if (!detail.value || qcSaving.value) return
  // 测定值不该是负数（浓度/本底/加标量原始值都 ≥0）——拦负数，合法小数照常
  for (const k of ['v1', 'v2', 'background', 'spikedMeasured', 'spikeAdded', 'measured', 'assigned', 'limit']) {
    const v = (qcForm.value as any)[k]
    if (typeof v === 'number' && v < 0) return ElMessage.warning('测定值不能是负数，请检查输入')
  }
  qcSaving.value = true
  try {
    await api.addRoundQc(detail.value.round.id, { ...qcForm.value })
    ElMessage.success('已记录质控')
    qcForm.value = { qcType: qcForm.value.qcType, analyte: '', unit: 'mg/L' }
    await loadQc()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { qcSaving.value = false }
}
const nv = (v: any) => (v == null || v === '' ? '—' : v)   // 老空值记录别显示 undefined
function qcValues(r: QcRecord): string {
  const d = r.data || {}
  if (r.qc_type === '平行样') return `测定值 ${nv(d.v1)} / ${nv(d.v2)}`
  if (r.qc_type === '加标回收') return `本底 ${nv(d.background)}，加标后 ${nv(d.spikedMeasured)}，加标量 ${nv(d.spikeAdded)}`
  if (r.qc_type === '密码样') return `测定 ${nv(d.measured)}，标准值 ${nv(d.assigned)}`
  if (r.qc_type === '空白') return `测定 ${nv(d.measured)}`
  return ''
}
const fieldBusy = ref(false)
async function saveField() {
  if (!detail.value || fieldBusy.value) return
  fieldBusy.value = true
  try { await api.saveRoundField(detail.value.round.id, field.value); ElMessage.success('现场记录已保存'); await refresh() }
  catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { fieldBusy.value = false }
}

// —— 设备领用提示（PRD：领了设备登记才去采样）——本期关联的在外领用
const roundCheckouts = ref<{ instrument_id: string; instrument_name?: string }[]>([])
async function loadRoundCheckouts() {
  roundCheckouts.value = []
  if (!detail.value) return
  try {
    const all = await api.listCheckouts(true)
    roundCheckouts.value = all.filter((c: any) => c.round_id === detail.value!.round.id)
    if (!field.value.instrumentIds?.length && roundCheckouts.value.length) field.value.instrumentIds = roundCheckouts.value.map(c => c.instrument_id)
  } catch { /* */ }
}

// —— 点位档案（决策1）：核对实际位置 / 现场补点 ——
const points = ref<import('../api').MonitoringPoint[]>([])
const newPoint = ref({ name: '', actualDesc: '' })
async function loadPoints() {
  points.value = []
  const cid = detail.value?.round?.contract_id
  if (!cid) return
  try { points.value = await api.listContractPoints(cid) } catch { /* */ }
}
async function savePointActual(p: import('../api').MonitoringPoint, v: string) {
  if (!v.trim() || v === (p.actual_desc || p.planned_desc)) return
  try { await api.setPointActual(p.id, v.trim()); ElMessage.success(`点位 ${p.name} 实际位置已记录（留痕）`); await loadPoints() }
  catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
}
async function addPoint() {
  const cid = detail.value?.round?.contract_id
  if (!cid || !newPoint.value.name.trim()) return ElMessage.warning('点位名称必填')
  try {
    await api.addFieldPoint(cid, { name: newPoint.value.name.trim(), actualDesc: newPoint.value.actualDesc.trim() || undefined })
    ElMessage.success('已补点位（留痕）'); newPoint.value = { name: '', actualDesc: '' }; await loadPoints()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
}

// —— §8.3 两人采样双确认 ——
const confirmationUsers = computed(() => detail.value?.round?.field_info?.confirmation_users || [])
const canConfirmField = computed(() => {
  const me = currentUser.value?.username || ''
  const mine = confirmationUsers.value.find(x => x.user_id === me)
  return detail.value?.round?.status !== 'done' && !!mine && !mine.confirmed_at
})
async function doConfirmField() {
  if (!detail.value || fieldBusy.value) return
  fieldBusy.value = true
  try {
    // 先把现场登记存了再确认——确认的是已保存的内容
    await api.saveRoundField(detail.value.round.id, field.value)
    await api.confirmRoundField(detail.value.round.id)
    ElMessage.success('已确认采样表')
    await open(detail.value.round.id)
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { fieldBusy.value = false }
}
const assignBusy = ref(false)
async function doAssign() {
  if (!detail.value || assignBusy.value) return
  const list = assign.value.samplers.filter(Boolean)
  if (!list.length) return ElMessage.warning('选采样员')
  // CMA 要求现场采样至少 2 人：只选 1 人给提示，确认后放行
  if (list.length < 2) {
    const ok = await ElMessageBox.confirm('CMA 要求现场采样至少 2 人，现在只选了 1 人。确定只派 1 人？', '人数提示', { confirmButtonText: '确定只派1人', cancelButtonText: '回去加人', type: 'warning' }).then(() => true).catch(() => false)
    if (!ok) return
  }
  assignBusy.value = true
  try {
    await api.assignRound(detail.value.round.id, list, assign.value.planDate)
    const names = list.map(id => samplers.value.find(s => s.username === id)?.name || id)
    ElMessage.success(`已派工给 ${names.join('、')}`)
    await refresh()
    openStage.value = 'field'   // 派完工直接跳到现场采样段
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { assignBusy.value = false }
}
// 决策：采样日期可正常微调（留痕），不用谎报「采不成」
async function doAdjustDue() {
  if (!detail.value) return
  try {
    await api.adjustRoundDue(detail.value.round.id, assign.value.planDate)
    ElMessage.success('约定采样日已调整（留痕）')
    await open(detail.value.round.id); await refresh()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
}

// 状态机时序：到了约定采样日（或已逾期）才出现「采不成/改期」和「收样入库」
const dueReached = computed(() => {
  const r = detail.value?.round
  if (!r) return false
  const d = r.plan_date || r.due_date
  return !!d && d <= todayLocal()   // 本地日：采样日当天凌晨按钮就该出现，不能用 UTC 差 8 小时
})
async function doSampleIn() {
  if (!detail.value) return
  if (hasDirty()) {
    ElMessage.warning('还有未保存的采样表，请先保存后再收样入库')
    return
  }
  // 收样入库前先把现场登记存了——不能让"入库"这一下把没保存的登记内容丢掉
  try {
    await api.saveRoundField(detail.value.round.id, field.value)
  } catch (e: any) {
    ElMessage.error('收样入库已中止：现场记录保存失败，' + (e?.response?.data?.error || e?.message || e))
    return
  }
  const r = detail.value.round
  const total = detail.value.planItems.reduce((s, p) => s + p.qty, 0)
  const qcNote = qcReqs.value.length ? `\n同时按质控规则自动建质控样：${qcReqText.value}` : ''
  try {
    await ElMessageBox.confirm(`确认第 ${r.round_no} 期已现场采样，按方案把 ${total} 个普通样品收样入库（自动编号）？${qcNote}\n质控样会在这一步由系统自动建档，不需要先在采样单上手工生成。每个样品会自动生成「采样交接」记录。`, `第 ${r.round_no} 期 · 收样入库`, { confirmButtonText: '收样入库', cancelButtonText: '取消', type: 'info' })
    const made = await api.sampleRound(r.id)
    ElMessage.success(`已入库 ${made.length} 个样品（含系统生成的质控样）`)
    await refresh(); openStage.value = 'stock'
  } catch (e: any) {
    if (e === 'cancel' || e === 'close') return
    ElMessage.error('收样入库失败：' + (e?.response?.data?.error || e?.message || e))
  }
}
const reschedule = ref('')
async function doFail() {
  if (!detail.value) return
  const r = detail.value.round
  try {
    const { value } = await ElMessageBox.prompt(`第 ${r.round_no} 期这次没采成？填一下原因（企业停产、天气等）`, `第 ${r.round_no} 期 · 标记未采成`, { confirmButtonText: '标未采成', cancelButtonText: '取消', inputPlaceholder: '如：企业停产' })
    if (!value?.trim()) return ElMessage.warning('原因必填')
    await api.failRound(r.id, value.trim())
    ElMessage.success('已标记未采成，下方可改期')
    await refresh()
  } catch { /* 用户取消 */ }
}
async function doReschedule() {
  if (!detail.value) return
  if (!reschedule.value) return ElMessage.warning('选新采样日期')
  try {
    await api.rescheduleRound(detail.value.round.id, reschedule.value)
    ElMessage.success('已改期，回到待采')
    reschedule.value = ''
    await refresh()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
}
// 期次终止（不再补采）：只对未采成的期次；企业不做了/整年停产等，原因必填、全程留痕
async function doCancel() {
  if (!detail.value) return
  const r = detail.value.round
  try {
    const { value } = await ElMessageBox.prompt(
      `终止第 ${r.round_no} 期（不再补采）？终止后本期不再进待办，也不能再改期。填终止原因：`,
      `第 ${r.round_no} 期 · 终止本期`,
      { confirmButtonText: '终止本期', cancelButtonText: '取消', inputPlaceholder: '如：企业全年停产，客户确认本期不补采' })
    if (!value?.trim()) return ElMessage.warning('终止原因必填')
    await api.cancelRound(r.id, value.trim())
    ElMessage.success('本期已终止（留痕）')
    await refresh()
  } catch { /* 用户取消 */ }
}
function dueBadge(r: DueRound) {
  if (r.status === 'failed') return '未采成'
  if (r.status === 'cancelled') return '已终止'
  if (r.status === 'done') return '已采样'
  if (r.bucket === 'overdue') return '已逾期'
  if (r.bucket === 'soon') return '快到期'
  return '待采样'
}

// 派工下拉选人：在职采样员/技术负责人，不再手输名字
const samplers = ref<{ username: string; name: string }[]>([])
function samplerOptionLabel(s: { username: string; name: string }) {
  return samplers.value.filter(x => x.name === s.name).length > 1 ? `${s.name}（${s.username}）` : s.name
}
async function loadSamplers() {
  try { samplers.value = await api.listSamplers() } catch { samplers.value = [] }
}
onMounted(() => { refresh(); loadSamplers() })
</script>

<template>
  <div class="pagewrap wide">
    <div class="phead">
      <div>
        <h1 class="page">采样派工</h1>
        <p class="sub">按期次排产 · 现场采样 · 收样入库</p>
      </div>
      <span v-if="alerts.length" class="hcount num">{{ alerts.length }} 项监测该采样了</span>
    </div>

    <!-- 到期提醒：该采样的期次 -->
    <section v-if="alerts.length" class="alsec">
      <div class="sechead">
        <h2>到期提醒</h2>
        <span class="seccount num">{{ alerts.length }} 项</span>
      </div>
      <div class="card allist">
        <div v-for="r in alerts" :key="r.id" class="al" @click="open(r.id)">
          <span class="sdot" :class="bucketTone[r.bucket]"></span>
          <span class="al-client">{{ r.client }} · 第{{ r.round_no }}期</span>
          <span class="al-badge">{{ dueBadge(r) }}</span>
          <span class="al-meta mono">{{ r.due_date }}</span>
          <span class="al-c">›</span>
        </div>
      </div>
    </section>

    <div class="split">
      <!-- 左：期次列表（采样的活按期排） -->
      <section class="listsec">
        <div class="sechead">
          <h2>期次队列</h2>
          <span class="seccount num">{{ sorted.length }} 期</span>
        </div>
        <div class="left card">
          <div class="filters">
            <span class="chips"><span v-for="[v, l] in FILTERS" :key="v" class="chip" :class="{ on: filter === v }" @click="filter = v">{{ l }}</span></span>
            <input v-model="keyword" class="search" placeholder="搜单位 / 项目 / 委托号 / 采样员…" />
          </div>
          <div class="list" v-loading="loading">
            <!-- 按合同折叠分组：组头=单位+委托号+期数+状态汇总，点开看各期 -->
            <div v-for="g in groups" :key="g.contractId" class="grp">
              <div class="grp-head" @click="expanded[g.contractId] = !isOpen(g)">
                <span class="chev">{{ isOpen(g) ? '▾' : '▸' }}</span>
                <b class="pid">{{ g.client }}</b>
                <span v-if="(g as any).urgent" class="pill crit">加急</span>
                <span class="mono muted">{{ g.contractId }}</span>
                <span class="gcount num">{{ g.rounds.length }} 期</span>
                <span class="spacer"></span>
                <span class="gsum">{{ grpSummary(g) }}</span>
                <span class="due mono" :class="g.rounds[0].bucket">最近 {{ g.rounds[0].due_date }} {{ dueBadge(g.rounds[0]) }}</span>
              </div>
              <template v-if="isOpen(g)">
                <div v-for="r in g.rounds" :key="r.id" class="item ingrp" :class="{ on: detail?.round.id === r.id }" @click="open(r.id)">
                  <div class="itop">
                    <span class="pid"><b class="rno">第 {{ r.round_no }} 期</b></span>
                    <span class="pst"><span class="sdot" :class="stateTone[stateOf(r)]"></span>{{ stateLabel[stateOf(r)] }}</span>
                  </div>
                  <div class="imeta">
                    <span class="due mono" :class="r.bucket">{{ r.due_date }} {{ dueBadge(r) }}</span>
                    <span v-if="r.sampler"> · {{ r.sampler }}</span>
                    <span v-if="r.sample_count"> · <span class="num">{{ r.sample_count }}</span> 样品 {{ rollupLabel[r.rollup || 'pending'] }}</span>
                  </div>
                </div>
              </template>
            </div>
            <div v-if="!sorted.length && !loading" class="empty">没有期次——项目的监测方案审核通过后自动排出</div>
          </div>
        </div>
      </section>

      <!-- 右：期次详情 -->
      <div class="right card">
        <template v-if="detail">
          <div class="dhead">
            <div>
              <div class="dname">{{ detail.contract?.client }} · 第 {{ detail.round.round_no }} 期
                <span class="pill" :class="stateTone[stateOf(detail.round as any)]">{{ stateLabel[stateOf(detail.round as any)] }}</span>
              </div>
              <div class="dsub mono">{{ detail.round.contract_id }} · 计划采样 {{ detail.round.due_date }}<span v-if="detail.round.sampled_at"> · 实际入库 {{ detail.round.sampled_at.slice(0, 10) }}</span></div>
            </div>
          </div>
          <div class="dbody">
            <!-- ① 排产派工：待采清单 + 选人派工 -->
            <div class="stage" :class="{ open: openStage === 'dispatch' }">
              <div class="stage-head" @click="toggleStage('dispatch')">
                <span class="snum" :class="{ good: !!detail.round.sampler }">①</span>
                <b>排产派工</b>
                <span class="ssum">{{ detail.round.sampler ? `${detail.round.sampler} · ${detail.round.plan_date || detail.round.due_date}` : '待派工' }}</span>
                <span class="chev">{{ openStage === 'dispatch' ? '收起' : '展开' }}</span>
              </div>
              <div class="stage-body" v-show="openStage === 'dispatch'">
            <!-- 待采清单 -->
            <div class="sec">
              <div class="sechead"><h2>本期待采清单（按监测方案）</h2></div>
              <table class="ptab">
                <thead><tr><th>基质</th><th>检测项目</th><th>数量</th></tr></thead>
                <tbody><tr v-for="p in detail.planItems" :key="p.id"><td>{{ p.matrix }}</td><td>{{ p.items.join('、') }}</td><td class="num">× {{ p.qty }}</td></tr></tbody>
              </table>
            </div>

            <!-- 派工：多选采样员（CMA 现场采样≥2人）——只有登记员/质控员/技术负责人能派 -->
            <div class="sec" v-if="canAssign">
              <div class="sechead"><h2>选采样员</h2><span class="sec-note">现场采样至少 2 人（CMA）</span></div>
              <div class="assign">
                <!-- 不折叠标签：采样员就几个人，折叠成 +N 反而看不清派了谁 -->
                <el-select v-model="assign.samplers" multiple filterable placeholder="选采样员（可多选）" size="default" style="min-width:260px;max-width:460px">
                  <el-option v-for="s in samplers" :key="s.username" :label="samplerOptionLabel(s)" :value="s.username" />
                </el-select>
                <input v-model="assign.planDate" type="date" />
                <el-button size="small" type="primary" plain @click="doAssign">{{ detail.round.sampler ? '改派' : '派工' }}</el-button>
                <el-button v-if="assign.planDate && assign.planDate !== detail.round.due_date" size="small" plain title="客户要求改日子不用谎报采不成——直接微调，留痕" @click="doAdjustDue">把约定采样日改为 {{ assign.planDate }}</el-button>
              </div>
              <p v-if="!samplers.length" class="assign-hint">还没有在职采样员账号——先去「人员与权限」给同事挂上「采样员」角色</p>
            </div>
            <!-- 质控要求放派工区外：采样员没有派工权限也要看到现场带多少质控样 -->
            <div class="sec" v-if="qcReqs.length">
              <div class="qcreq">
                <b>本次现场要带的质控样：</b>
                <span v-for="q in qcReqs" :key="q.qcType + q.matrix" class="qcreq-pill" :title="q.basis">{{ q.qcType }} × {{ q.qty }}<i>{{ q.matrix }}</i></span>
                <span class="hint">收样入库时系统按此自动建质控样编号</span>
              </div>
            </div>
              </div>
            </div>

            <!-- ② 现场采样：登记 + 采样单 + 照片 + 采不成/改期 + 收样入库 -->
            <div class="stage" :class="{ open: openStage === 'field' }">
              <div class="stage-head" @click="toggleStage('field')">
                <span class="snum" :class="{ good: detail.round.status === 'done' }">②</span>
                <b>现场采样</b>
                <span class="ssum">{{ detail.round.status === 'done' ? '已完成 · 已收样入库' : (detail.round.sampler ? '采样员现场填表、传照片，采完点收样入库' : '先在 ① 里派工') }}</span>
                <span class="chev">{{ openStage === 'field' ? '收起' : '展开' }}</span>
              </div>
              <div class="stage-body" v-show="openStage === 'field'">
            <!-- 已终止：不再补采，只留提示（原因在留痕里可查） -->
            <div class="sec" v-if="detail.round.status === 'cancelled'">
              <div class="failnote">本期已终止（不再补采）。终止原因可在「数据留痕归档」按期次号查。</div>
            </div>
            <!-- 采不成 / 改期：派工后、到了约定采样日才出现（没人去现场谈不上采不成） -->
            <div class="sec" v-if="detail.round.status !== 'done' && detail.round.status !== 'cancelled' && (detail.round.status === 'failed' || (detail.round.sampler && dueReached))">
              <div class="sechead"><h2>采不成 / 改期</h2></div>
              <div v-if="['pending', 'rescheduled'].includes(detail.round.status) && canAssign" class="assign">
                <el-button size="small" text type="danger" @click="doCancel">终止本期（企业注销/停产，确认不采）</el-button>
              </div>
              <template v-if="detail.round.status === 'failed'">
                <div class="failnote">本期已标未采成：{{ detail.round.fail_reason }}<span v-if="detail.round.orig_due_date || detail.round.due_date">（原定 {{ detail.round.orig_due_date || detail.round.due_date }}）</span></div>
                <div class="assign">
                  <input v-model="reschedule" type="date" />
                  <el-button v-if="canFlow" size="small" type="primary" plain @click="doReschedule">改期到此日 · 重新排</el-button>
                  <el-button v-if="canAssign" size="small" text type="danger" @click="doCancel">终止本期（不再补采）</el-button>
                </div>
              </template>
              <template v-else>
                <el-button v-if="canFlow" size="small" plain @click="doFail">这次采不成（停产 / 天气…）</el-button>
                <span class="hint">去了没采到？标未采成并记原因，之后可改期重排</span>
              </template>
            </div>

            <!-- 现场采样登记（S4）：通用现场信息 + 按基质填采样单 + 噪声/固废专项 -->
            <div class="sec">
              <div class="sechead"><h2>现场采样登记</h2><span class="sec-note">采样员现场填，收样入库前保存</span></div>
              <!-- 非采样岗（质控员/登记员）能看不能填：CMA 要求现场记录由到场的人自己写 -->
              <p v-if="!canField" class="sp-hint">只读——现场记录只能由本期采样员本人填写，你的岗位没有这项权限。</p>
              <p v-if="canField && detail.round.status !== 'done' && !roundCheckouts.length" class="sp-hint">
                本期还没有设备领用记录——出发前先到「资源台账」领设备并选中本期（台账才能对上号）
              </p>
              <p v-else-if="roundCheckouts.length" class="sp-hint" style="color:var(--good)">
                已为本期领用：{{ roundCheckouts.map(c => c.instrument_id).join('、') }}
              </p>
              <div v-if="roundCheckouts.length" class="field-equipment">
                <label>本次实际使用的采样设备</label>
                <el-select v-model="field.instrumentIds" multiple filterable :disabled="!canField" placeholder="从本期已领用设备中选择" style="min-width:360px;max-width:720px">
                  <el-option v-for="c in roundCheckouts" :key="c.instrument_id" :value="c.instrument_id" :label="`${c.instrument_id} ${c.instrument_name || ''}`" />
                </el-select>
              </div>
              <div class="field" :class="{ ro: !canField }">
                <label>采样日期<input v-model="field.date" type="date" :disabled="!canField" /></label>
                <label>采样时刻<input v-model="field.time" placeholder="如 09:30（现场时间）" :disabled="!canField" /></label>
                <label>天气<input v-model="field.weather" placeholder="晴 / 多云 / 雨" :disabled="!canField" /></label>
                <label>气温<input v-model="field.temp" placeholder="如 26℃" :disabled="!canField" /></label>
                <template v-if="hasNoise">
                  <label>测前校准 dB<input v-model="field.calBefore" type="number" step="0.1" placeholder="93.8" :disabled="!canField" /></label>
                  <label>测后校准 dB<input v-model="field.calAfter" type="number" step="0.1" placeholder="93.9" :disabled="!canField" /></label>
                  <label>风速 m/s<input v-model="field.wind" type="number" step="0.1" placeholder="<5 才能测" :disabled="!canField" /></label>
                </template>
                <label v-if="hasSolid">固废堆存量 t<input v-model="field.tons" type="number" placeholder="按吨位查份样数" :disabled="!canField" /></label>
                <label class="wide">实际采样点位 / 地点
                  <input v-model="field.points" :disabled="!canField" :placeholder="plannedPoints ? `方案点位：${plannedPoints}（如与现场不一致请改成实际点位）` : '如 1#废水排口、厂界东南…'" />
                </label>
                <label class="wide">备注<input v-model="field.note" placeholder="点位情况 / 异常说明（可空）" :disabled="!canField" /></label>
              </div>
              <p v-if="hasNoise" class="sp-hint">噪声专项：测前测后校准偏差 &gt;0.5dB 结果无效不能入库；雨雪雷电不测、风速 ≥5m/s 不测。</p>
              <p v-if="hasSolid && swHint" class="sp-hint">固废 {{ field.tons }}t：按 HJ 298-2019 至少采 <b>{{ swHint }}</b> 个份样。</p>

              <!-- 按基质填采样单（模板库现场表） -->
              <div v-for="m in roundMatrices" :key="m" class="sheet" v-show="sheetsForMatrix(m).length">
                <div class="sheet-head">
                  <b>{{ m }} · 采样单（可多选）</b>
                  <el-select :model-value="selectedSheetCodes(m)" multiple filterable collapse-tags-tooltip placeholder="选择本次需要填写的采样单" style="min-width:420px;max-width:760px" @change="pickSheets(m, $event)">
                    <el-option v-for="t in sheetsForMatrix(m)" :key="t.code" :value="t.code" :label="`${t.code} ${t.name}`" />
                  </el-select>
                </div>
                <div v-if="!selectedSheetCodes(m).length" class="sp-hint">请至少选择一张本次要填写的采样单。</div>
                <div v-for="code in selectedSheetCodes(m)" :key="detail.round.id + code" class="sheet-instance">
                  <div class="sheet-instance-title"><b>{{ code }} {{ tplOf(code)?.name || '' }}</b><span>计划日期 {{ detail.round.plan_date || detail.round.due_date }}</span></div>
                  <!-- 模板库有精确版式的：现场直接填整张原始记录表（独立保存，存到本期次名下） -->
                  <StructuredSheet v-if="hasFullForm(code)"
                    :round-id="detail.round.id" :readonly="!canField" :initial-data="roundSheetSeed(m)"
                    :code="code" :sheet-type="tplOf(code)?.sheetType || '采样记录'"
                    :template-name="tplOf(code)?.name || ''"
                    :analyte="tplOf(code)?.analyte || ''" :method="tplOf(code)?.method || ''" :matrix="m" />
                  <!-- 没有精确版式的：每个表号独立一份简化登记 -->
                  <div v-else class="field" :class="{ ro: !canField }">
                    <label>采样点位<input v-model="sheetDraft(code).point" placeholder="本基质实际点位" :disabled="!canField" /></label>
                    <label>样品性状<input v-model="sheetDraft(code).character" placeholder="颜色 / 气味 / 状态" :disabled="!canField" /></label>
                    <label>采样方法<input v-model="sheetDraft(code).method" placeholder="如 瞬时采样 / 混合采样" :disabled="!canField" /></label>
                    <label>容器与保存<input v-model="sheetDraft(code).container" placeholder="系统建议后可修改" :disabled="!canField" /></label>
                    <label class="wide">备注<input v-model="sheetDraft(code).note" placeholder="可空" :disabled="!canField" /></label>
                  </div>
                  <div class="sheet-photo"><span>本采样单现场照片 / 扫描件</span><RecordAttachments type="round_sheet" :id="roundSheetAttachmentId(code)" :frozen="!canField" /></div>
                </div>
              </div>
              <el-button v-if="canField" size="small" @click="saveField">保存现场记录</el-button>

              <!-- 点位档案（决策1）：合同预设点位现场核对实际位置；可现场补点，改动全留痕 -->
              <div v-if="points.length || detail.round.status !== 'done'" class="sheet">
                <div class="sheet-head"><b>点位核对</b><span class="sec-note">实际采样位置与合同不一致要在这里改（留痕），报告如实体现</span></div>
                <div v-for="p in points" :key="p.id" class="pt-row">
                  <span class="mono pt-code">{{ p.code }}</span>
                  <span class="pt-name">{{ p.name }}<i v-if="p.source === 'field'" class="pt-field">现场补</i></span>
                  <input :value="p.actual_desc || p.planned_desc || ''" :disabled="detail.round.status === 'done' || !canField" placeholder="实际采样位置"
                         @change="savePointActual(p, ($event.target as HTMLInputElement).value)" />
                </div>
                <div v-if="canField && detail.round.status !== 'done'" class="pt-add">
                  <input v-model="newPoint.name" placeholder="现场补点：点位名称" />
                  <input v-model="newPoint.actualDesc" placeholder="实际位置描述" />
                  <el-button size="small" plain @click="addPoint">补一个点位</el-button>
                </div>
              </div>

              <!-- §8.3 两人采样双确认：每名采样员都确认采样表，才能收样入库 -->
              <div v-if="confirmationUsers.length" class="sheet">
                <div class="sheet-head"><b>采样表确认</b><span class="sec-note">两人采样：每名采样员都要在系统里确认（CMA）</span></div>
                <div class="confirm-row">
                  <span v-for="s in confirmationUsers" :key="s.user_id" class="confirm-pill" :data-confirm-user-id="s.user_id" :class="{ ok: !!s.confirmed_at }">
                    <span class="sdot" :class="s.confirmed_at ? 'good' : 'warn'"></span>{{ s.name }}<small class="mono">{{ s.user_id }}</small>
                    <i v-if="s.confirmed_at">已确认 {{ s.confirmed_at.slice(5, 16).replace('T', ' ') }}</i>
                    <i v-else>待确认</i>
                  </span>
                  <el-button v-if="canConfirmField" size="small" type="primary" plain @click="doConfirmField">我确认采样表无误</el-button>
                </div>
              </div>

              <!-- 本期公共现场照片：不属于某一张采样单的环境全景/补充证据 -->
              <div class="sheet">
                <div class="sheet-head"><b>本期公共现场照片</b><span class="sec-note">每张采样单的照片请在对应表单下上传</span></div>
                <RecordAttachments type="round" :id="detail.round.id" />
              </div>
            </div>

            <!-- 收样入库：派工后才能入库（状态机）；已终止的期次不再入库 -->
            <div class="sec" v-if="detail.round.status !== 'done' && detail.round.status !== 'cancelled'">
              <template v-if="detail.round.sampler">
                <el-button v-if="canField" type="primary" @click="doSampleIn">现场采样 · 收样入库 →</el-button>
                <span class="hint">采样员完成现场采样后点这里，系统按清单+质控规则自动建样品编号和采样交接</span>
              </template>
              <span v-else class="hint">先在上面「排产派工」选采样员，派工后才能收样入库</span>
            </div>
            <div class="sec fieldshow" v-else-if="detail.round.field_info">
              已记录现场：{{ detail.round.field_info.date || '' }} {{ detail.round.field_info.weather || '' }} {{ detail.round.field_info.temp || '' }}
              <span v-if="detail.round.field_info.blank" class="qcf"><span class="sdot good"></span>含全程序空白</span>
              <span v-if="detail.round.field_info.parallel" class="qcf"><span class="sdot good"></span>含现场平行</span>
              <div class="hint" style="margin:6px 0 0">每个样品已自动生成「采样交接」记录；现场照片/交接单扫描件在上方「现场采样登记」里挂在本期次名下</div>
            </div>
              </div>
            </div>

            <!-- ③ 样品与质控：收样入库后的结果 -->
            <div class="stage" :class="{ open: openStage === 'stock' }">
              <div class="stage-head" @click="toggleStage('stock')">
                <span class="snum" :class="{ good: detail.samples.length > 0 }">③</span>
                <b>样品与质控</b>
                <span class="ssum">{{ detail.samples.length ? `${detail.samples.length} 个样品已入库` : '收样入库后在这里看样品和质控记录' }}</span>
                <span class="chev">{{ openStage === 'stock' ? '收起' : '展开' }}</span>
              </div>
              <div class="stage-body" v-show="openStage === 'stock'">
            <div v-if="!detail.samples.length" class="sec"><span class="hint" style="margin:0">还没收样入库——在 ② 现场采样里完成后，样品编号和质控记录会自动出现在这里。</span></div>
            <!-- 已入库样品 -->
            <div class="sec" v-if="detail.samples.length">
              <div class="sechead">
                <h2>本期已入库样品</h2>
                <span class="seccount num">{{ detail.samples.length }} 个</span>
              </div>
              <div class="card slist">
                <div v-for="s in detail.samples" :key="s.id" class="srow" @click="router.push('/samples?sample=' + s.id)">
                  <span class="sdot" :class="rollupTone[s.rollup]"></span>
                  <span class="sc-id mono">{{ s.id }}</span>
                  <span v-if="s.qc_type" class="qcbadge">{{ s.qc_type }}</span>
                  <span class="sc-sub">{{ s.matrix }} · {{ s.items.join('、') }}</span>
                  <span class="sc-st">{{ rollupLabel[s.rollup] }}</span>
                  <span class="al-c">›</span>
                </div>
              </div>
            </div>

            <!-- 本期质控（6.1.5）：自动判合格 -->
            <div class="sec" v-if="detail.samples.length">
              <div class="sechead">
                <h2>本期质控记录</h2>
                <span class="sec-note">密码样 / 平行样 / 加标回收 / 空白，系统自动判合格</span>
              </div>
              <table class="qctab" v-if="qc.length">
                <thead><tr><th>类型</th><th>项目</th><th>数据</th><th>结果</th><th>判定</th><th>记录人</th></tr></thead>
                <tbody>
                  <template v-for="r in qc" :key="r.id">
                    <tr>
                      <td><span class="qcty">{{ r.qc_type }}</span></td>
                      <td>{{ r.analyte || '—' }}</td>
                      <td class="qcval">{{ qcValues(r) }} <span class="unit">{{ r.unit }}</span></td>
                      <td class="mono">{{ r.result != null ? r.result + (r.qc_type === '空白' ? '' : '%') : '—' }}<div class="crit">{{ r.criterion }}</div></td>
                      <td><span class="qcv"><span class="sdot" :class="r.verdict === '合格' ? 'good' : (r.verdict === '不合格' ? 'crit' : '')"></span>{{ r.verdict || '—' }}</span></td>
                      <td class="mono dim">{{ r.who }}</td>
                    </tr>
                    <tr class="qc-att-row"><td colspan="6"><RecordAttachments type="qc" :id="r.id" /></td></tr>
                  </template>
                </tbody>
              </table>
              <div v-else class="qc-empty">还没有质控记录。</div>

              <div v-if="canQc" class="qc-add">
                <select v-model="qcForm.qcType"><option v-for="t in QC_TYPES_" :key="t" :value="t">{{ t }}</option></select>
                <input v-model="qcForm.analyte" placeholder="检测项目 如 锌" class="w-item" />
                <!-- 测定值统一 min=0：负数没有物理意义；step=any 不拦小数 -->
                <template v-if="qcForm.qcType === '平行样'">
                  <input v-model.number="qcForm.v1" type="number" min="0" step="any" placeholder="测定值1" /><input v-model.number="qcForm.v2" type="number" min="0" step="any" placeholder="测定值2" />
                </template>
                <template v-else-if="qcForm.qcType === '加标回收'">
                  <input v-model.number="qcForm.background" type="number" min="0" step="any" placeholder="本底值" /><input v-model.number="qcForm.spikedMeasured" type="number" min="0" step="any" placeholder="加标后测定" /><input v-model.number="qcForm.spikeAdded" type="number" min="0" step="any" placeholder="加标量" />
                </template>
                <template v-else-if="qcForm.qcType === '密码样'">
                  <input v-model.number="qcForm.measured" type="number" min="0" step="any" placeholder="测定值" /><input v-model.number="qcForm.assigned" type="number" min="0" step="any" placeholder="标准值" />
                </template>
                <template v-else>
                  <input v-model.number="qcForm.measured" type="number" min="0" step="any" placeholder="空白测定值" /><input v-model.number="qcForm.limit" type="number" min="0" step="any" placeholder="检出限" />
                </template>
                <el-select v-model="qcForm.unit" filterable allow-create default-first-option placeholder="单位" size="small" class="w-unit" style="width:110px">
                  <el-option v-for="u in UNIT_OPTS" :key="u" :label="u" :value="u" />
                </el-select>
                <el-button size="small" type="primary" :loading="qcSaving" @click="submitQc">记一条</el-button>
              </div>
            </div>
              </div>
            </div>
          </div>
        </template>
        <div v-else class="rest">左侧选一个期次</div>
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
.hcount{color:var(--faint);font-size:12.5px;padding-top:9px}
.seccount{font-size:12px;color:var(--faint)}

/* 到期提醒：队列 */
.alsec{flex:none;margin-bottom:20px}
.allist{max-height:126px;overflow-y:auto}
.al{display:flex;align-items:center;gap:10px;padding:9px 16px;cursor:pointer;border-bottom:1px solid var(--line);font-size:12.5px;transition:background .12s ease}
.al:last-child{border-bottom:0}
.al:hover{background:var(--surface-2)}
.al-client{font-weight:600;color:var(--ink)}
.al-badge{color:var(--muted);font-size:12px}
.al-meta{color:var(--faint);font-size:11.5px;margin-left:auto}
.al-c{color:var(--faint);font-size:16px;line-height:1}

.split{flex:1;display:grid;grid-template-columns:380px 1fr;gap:16px;min-height:0}
.listsec{display:flex;flex-direction:column;min-height:0}

/* 左：期次队列 */
.left{flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden}
.filters{padding:12px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:8px;flex:none}
.chips{display:flex;gap:4px}
.chip{font-size:11.5px;padding:3px 10px;border-radius:20px;color:var(--muted);cursor:pointer;transition:background .12s ease,color .12s ease}
.chip:hover{background:var(--surface-2)}
.chip.on{background:var(--accent-soft);color:var(--accent-ink);font-weight:600}
.search{width:100%;border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:7px 10px;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--ink)}
.search:focus{outline:2px solid var(--accent);outline-offset:-1px}
.list{flex:1;overflow-y:auto}
/* 合同分组（2026-07-31：期次按合同折叠，别让一家12期淹了别家） */
.grp{border-bottom:1px solid var(--line)}
.grp-head{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;background:var(--surface-2);font-size:12.5px;flex-wrap:wrap}
.grp-head:hover{background:var(--accent-soft)}
.grp-head .chev{color:var(--faint);width:12px}
.grp-head .pid{font-size:13px}
.grp-head .muted{color:var(--faint);font-size:11.5px}
.gcount{font-size:11px;background:var(--accent-soft);color:var(--accent-ink);border-radius:10px;padding:1px 8px;font-weight:600}
.gsum{font-size:11.5px;color:var(--faint)}
.grp-head .spacer{flex:1}
.item.ingrp{padding-left:32px}
.item{padding:11px 16px;cursor:pointer;border-bottom:1px solid var(--line);border-left:2px solid transparent;transition:background .12s ease}
.item:last-child{border-bottom:0}
.item:hover{background:var(--surface-2)}
.item.on{background:var(--accent-soft);border-left-color:var(--accent)}
.itop{display:flex;align-items:center;justify-content:space-between;gap:8px}
.pid{font-size:13px;font-weight:600;color:var(--ink)}
.rno{color:var(--accent-ink);font-weight:600}
.pst{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--muted);white-space:nowrap;flex:none}
.isub{font-size:12px;color:var(--muted);margin-top:4px}
.imeta{font-size:11.5px;color:var(--faint);margin-top:3px}
.due.overdue{color:var(--crit);font-weight:600}
.due.soon{color:var(--warn);font-weight:600}
.empty{padding:26px 16px;color:var(--faint);font-size:13px;text-align:center;line-height:1.6}
.rest{padding:32px;color:var(--faint);font-size:13px;text-align:center}

/* 右：期次详情 */
.right{display:flex;flex-direction:column;min-height:0;overflow:hidden}
.dhead{padding:14px 18px;border-bottom:1px solid var(--line);flex:none}
.dname{font-size:15px;font-weight:650;display:flex;align-items:center;gap:10px}
.dsub{font-size:12.5px;color:var(--muted);margin-top:5px}
.dbody{flex:1;overflow-y:auto;padding:16px 18px}

/* 三段式：① 排产派工 → ② 现场采样 → ③ 样品与质控 */
.stage{border:1px solid var(--line);border-radius:var(--radius-sm);margin-bottom:12px;background:var(--surface)}
.stage.open{border-color:var(--line-strong)}
.stage-head{display:flex;align-items:center;gap:10px;padding:11px 14px;cursor:pointer;user-select:none;transition:background .12s ease}
.stage-head:hover{background:var(--surface-2)}
.stage-head b{font-size:13.5px;color:var(--ink);flex:none}
.snum{flex:none;width:22px;height:22px;border-radius:50%;background:var(--surface-2);color:var(--muted);font-size:12px;display:inline-flex;align-items:center;justify-content:center;font-weight:600}
.snum.good{background:var(--accent-soft);color:var(--accent-ink)}
.ssum{flex:1;min-width:0;font-size:12px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chev{flex:none;font-size:11.5px;color:var(--faint)}
.stage-body{padding:4px 14px 14px;border-top:1px solid var(--line)}
.stage-body .sec:first-child{margin-top:10px}

.sec{margin-bottom:20px}
.sec-note{font-weight:400;font-size:11.5px;color:var(--faint)}

.ptab{width:100%;border-collapse:collapse;font-size:12.5px}
.ptab th{text-align:left;padding:7px 10px;font-size:11px;font-weight:600;color:var(--muted);background:var(--surface-2);border-bottom:1px solid var(--line)}
.ptab td{padding:8px 10px;border-bottom:1px solid var(--line);color:var(--ink)}

.assign{display:flex;gap:8px;align-items:center}
.assign input{border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:7px 10px;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--ink)}
.assign input:focus{outline:2px solid var(--accent);outline-offset:-1px}
.assign-hint{font-size:12px;color:var(--warn);margin:6px 0 0}

/* S4：质控要求 / 专项提示 / 采样单 */
.qcreq{margin-top:10px;font-size:12.5px;color:var(--ink);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.qcreq-pill{display:inline-flex;align-items:center;gap:5px;background:var(--accent-soft);color:var(--accent-ink);border-radius:20px;padding:3px 10px;font-size:12px;font-weight:600}
.qcreq-pill i{font-style:normal;font-weight:400;color:var(--muted);font-size:11px}
.sp-hint{font-size:12px;color:var(--warn);margin:8px 0 0}
/* 点位核对 + 采样表确认 */
.pt-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px dashed var(--line)}
.pt-code{font-size:11.5px;color:var(--faint);flex:none}
.pt-name{font-size:12.5px;font-weight:600;flex:none;min-width:110px}
.pt-name .pt-field{font-style:normal;font-size:10px;background:var(--accent-soft);color:var(--accent-ink);padding:1px 6px;border-radius:8px;margin-left:6px}
.pt-row input{flex:1;border:1px solid var(--line);border-radius:6px;height:28px;padding:0 8px;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--ink)}
.pt-add{display:flex;gap:8px;margin-top:8px;align-items:center}
.pt-add input{border:1px solid var(--line);border-radius:6px;height:28px;padding:0 8px;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--ink)}
.confirm-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.confirm-pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:16px;padding:4px 12px;font-size:12.5px}
.confirm-pill.ok{border-color:var(--good);background:var(--good-soft)}
.confirm-pill i{font-style:normal;font-size:11px;color:var(--faint)}
.sheet{border:1px solid var(--line);border-radius:var(--radius-sm);padding:10px 12px;margin-top:10px}
.sheet-head{display:flex;align-items:center;gap:10px;margin-bottom:8px;font-size:12.5px}
.sheet-head select{border:1px solid var(--line-strong);border-radius:6px;padding:5px 8px;font-size:12px;font-family:inherit;background:var(--surface);color:var(--ink);max-width:320px}
.sheet-instance{border-top:1px solid var(--line);padding-top:12px;margin-top:12px}
.sheet-instance-title{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;font-size:12.5px;color:var(--muted)}
.sheet-instance-title b{color:var(--ink)}
.sheet-photo{margin-top:10px;padding:10px 12px;background:var(--surface-2);border-radius:var(--radius-sm);font-size:12.5px}
.field-equipment{display:flex;align-items:center;gap:12px;margin:10px 0 12px;font-size:12.5px}
.field-equipment>label{font-weight:600;color:var(--ink)}
.qcbadge{flex:none;font-size:10.5px;font-weight:600;color:var(--accent-ink);background:var(--accent-soft);border-radius:4px;padding:1px 6px}
.hint{font-size:11.5px;color:var(--faint);margin-left:10px}
.failnote{font-size:12.5px;color:var(--crit);background:var(--crit-soft);border-radius:7px;padding:7px 10px;margin-bottom:8px}

.field{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}
.field label{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--muted)}
.field label.chk{flex-direction:row;align-items:center;gap:6px;font-size:12.5px;color:var(--ink);align-self:center}
.field label.wide{flex:1;min-width:180px}
.field input:not([type=checkbox]){border:1px solid var(--line-strong);border-radius:6px;padding:6px 9px;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--ink)}
.field input:focus{outline:2px solid var(--accent);outline-offset:-1px}
.field input:disabled{background:var(--surface-2,#f6f7f9);color:var(--muted);cursor:not-allowed}
.field.ro{opacity:.85}
.fieldshow{font-size:12.5px;color:var(--muted)}
.fieldshow .qcf{display:inline-flex;align-items:center;gap:5px;margin-left:12px;font-size:12px;color:var(--muted)}

/* 已入库样品：队列 */
.slist{overflow:hidden}
.srow{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line);cursor:pointer;font-size:12.5px;transition:background .12s ease}
.srow:last-child{border-bottom:0}
.srow:hover{background:var(--surface-2)}
.sc-id{font-weight:600;color:var(--ink);flex:none}
.sc-sub{color:var(--muted);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sc-st{color:var(--faint);font-size:12px;white-space:nowrap}

/* 质控表 */
.qctab{width:100%;border-collapse:collapse;font-size:12.5px;margin-bottom:12px}
.qctab th,.qctab td{border-bottom:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}
.qctab th{color:var(--muted);font-weight:600;font-size:11px;background:var(--surface-2)}
.qcty{font-weight:600;color:var(--ink)}
.qcval{color:var(--muted)}
.qcval .unit{color:var(--faint)}
.crit{font-size:10.5px;color:var(--faint);margin-top:2px;font-weight:400}
.qcv{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--ink)}
.qctab .dim{color:var(--faint)}
.qc-empty{font-size:12.5px;color:var(--faint);padding:2px 0 10px}
.qc-add{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.qc-add input,.qc-add select{border:1px solid var(--line-strong);border-radius:6px;padding:6px 8px;font-size:12px;font-family:inherit;background:var(--surface);color:var(--ink);width:96px}
.qc-add .w-item{width:110px}
.qc-add .w-unit{width:64px}

@media (max-width:1100px){
  .hcount{display:none}
}

/* 手机：双栏堆叠 */
@media (max-width:760px){
  .split{grid-template-columns:1fr}
  .list{max-height:45vh}
}
</style>
