<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, UNIT_OPTS, type ProjectSummary, type Project } from '../api'
import { can, type PermAction } from '../permissions'
import { daysTo, todayLocal } from '../utils/date'
import { rmbUpper } from '../../../server/src/rmb'
import templatesJson from '../data/templates.json'

const router = useRouter()
const MATRICES = ['废水', '地表水', '地下水', '海水', '土壤', '固废', '环境空气', '有组织废气', '无组织废气', '废气', '生活饮用水', '大气降水', '噪声']
const rollupLabel: Record<string, string> = { pending: '待检测', testing: '检测中', review: '待审核', approved: '已审核' }

const projects = ref<ProjectSummary[]>([])
const current = ref<Project | null>(null)
const loading = ref(false)

// 项目列表搜索 + 状态筛选：单子一多靠肉眼翻会漏
const listKeyword = ref('')
const listStatus = ref('')
const shownProjects = computed(() => projects.value.filter(p => {
  if (listStatus.value && p.status !== listStatus.value) return false
  if (listKeyword.value) {
    const k = listKeyword.value.toLowerCase()
    if (!(p.id + p.client + (p.project || '') + (p.quote?.extNo || '')).toLowerCase().includes(k)) return false
  }
  return true
}))

async function refresh() {
  loading.value = true
  try {
    projects.value = await api.listProjects()
    if (current.value) { current.value = await api.getProject(current.value.contract.id); await loadRounds() }
  } catch (e: any) { ElMessage.error('后端未连接？' + (e?.message || e)) }
  finally { loading.value = false }
}
async function open(id: string) {
  try { current.value = await api.getProject(id); showCreate.value = false; await loadRounds() }
  catch (e: any) { ElMessage.error(e?.message || e) }
}
// 主线走到第几环 → 卡片细进度条（归档 = 100%）
function pipePct(p: ProjectSummary) {
  const n = p.pipeline.stages.length
  if (p.pipeline.activeIndex < 0) return 100
  return Math.round((p.pipeline.activeIndex / Math.max(1, n - 1)) * 100)
}
function projStatus(p: ProjectSummary) {
  if (p.status === 'terminated') return { k: 'term', t: '已终止' }
  if (p.pipeline.activeIndex < 0) return { k: 'done', t: '已完成' }
  if (p.pipeline.activeIndex === 0) return { k: 'draft', t: '待受理' }
  return { k: 'active', t: '进行中' }
}
// 主线当前环的显示文本：周期项目带上第几期
function stageText(p: ProjectSummary) {
  const pl = p.pipeline
  if (pl.activeIndex < 0) return null
  const s = pl.stages[pl.activeIndex]
  return pl.round?.no ? `第${pl.round.no}期 · ${s.label}` : s.label
}
function roundNoOf(s: { round_id: string | null }) {
  const m = s.round_id?.match(/-R(\d+)$/)
  return m ? Number(m[1]) : null
}

// —— 新建委托 ——
const showCreate = ref(false)
const createMode = ref<'quote' | 'simple'>('quote')   // 默认按合同模板填写（可打印、自动生成计划）
const thisYear = new Date().getFullYear()
// 快速登记的检测项目也从模板库选（决策7 同口径）：手打自由文本对不上模板，后面记录表带不出来
const blankForm = () => ({ client: '', contact: '', phone: '', project: '', periodStart: `${thisYear}-01-01`, periodEnd: `${thisYear}-12-31`, plan: [{ matrix: '废水', items: [] as string[], qty: 1, cycleMonths: 3 }] })
const form = ref(blankForm())
const submitting = ref(false)
function addPlan() { form.value.plan.push({ matrix: '废水', items: [] as string[], qty: 1, cycleMonths: 3 }) }
function delPlan(i: number) { if (form.value.plan.length > 1) form.value.plan.splice(i, 1) }
// allow-create 兜底：清单真缺项能现打，但当场提醒后果
function warnFreeItem(items: string[]) {
  const last = items[items.length - 1]
  if (last && !ITEM_SET.has(last)) ElMessage.warning(`「${last}」是手打的项目名，对不上模板库，后面记录表带不出来——尽量从下拉里选`)
}
async function createContract() {
  if (!form.value.client.trim()) return ElMessage.warning('请填写委托单位')
  submitting.value = true
  try {
    const plan = form.value.plan.map(p => ({ matrix: p.matrix, items: p.items.map(s => s.trim()).filter(Boolean), qty: Math.max(1, Number(p.qty) || 1), cycleMonths: p.cycleMonths }))
    const c = await api.createContract({ client: form.value.client, contact: form.value.contact, phone: form.value.phone, project: form.value.project, periodStart: form.value.periodStart, periodEnd: form.value.periodEnd, plan })
    ElMessage.success(`已建项目 ${c.id}`)
    form.value = blankForm()
    await refresh(); await open(c.id)
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { submitting.value = false }
}

// —— 按合同模板填写（报价单 → 自动生成检测计划，可打印） ——
const QUOTE_CATEGORIES = ['有组织废气', '无组织废气', '废水', '噪声', '地表水', '地下水', '土壤', '固废', '环境空气']
// 项目字典：来自 454 个记录表模板，勾选的项目系统认识、后续自动对上原始记录
const ITEM_DICT = [...new Set((templatesJson as any[]).map(t => t.analyte).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'))
const ITEM_SET = new Set(ITEM_DICT)
const blankQuoteRow = () => ({ category: '有组织废气', point: '', items: [] as string[], price: 0, points: 1, perDay: 1, perYear: 1, note: '' })
const blankQuoteForm = () => ({
  client: '', contact: '', phone: '', project: '', extNo: `TCHT${thisYear}`, signDate: todayLocal(),   // 签订日期默认今天（不是1月1日）
  periodStart: `${thisYear}-01-01`, periodEnd: `${thisYear}-12-31`, invoice: '',
  rows: [blankQuoteRow()], discount: null as number | null,
  // 甲方开票信息（选填）：打印合同「委托单位（盖章）」栏自动带出
  buyer: { addr: '', bank: '', account: '', taxNo: '', bankNo: '', legal: '' },
})
const qform = ref(blankQuoteForm())
function addQuoteRow() { qform.value.rows.push({ ...blankQuoteRow(), category: qform.value.rows.at(-1)?.category || '有组织废气' }) }
function delQuoteRow(i: number) { if (qform.value.rows.length > 1) qform.value.rows.splice(i, 1) }
function rowSubtotal(r: ReturnType<typeof blankQuoteRow>) {
  return Math.round((Number(r.price) || 0) * Math.max(1, Number(r.points) || 1) * Math.max(1, Number(r.perDay) || 1) * Math.max(1, Number(r.perYear) || 1) * 100) / 100
}
const quoteTotal = computed(() => Math.round(qform.value.rows.reduce((s, r) => s + rowSubtotal(r), 0) * 100) / 100)
const quoteDiscount = computed(() => qform.value.discount ?? quoteTotal.value)
const quoteUpper = computed(() => rmbUpper(quoteDiscount.value))
// 勾选框允许现打字新增（allow-create）；不在字典里的就是"手写项目"，提交时拆出来标注待确认
function splitRowItems(items: string[]) {
  const dict = items.filter(i => ITEM_SET.has(i))
  const extra = items.filter(i => !ITEM_SET.has(i))
  return { items: dict, extraItems: extra.join('、') }
}
async function createByQuote() {
  const f = qform.value
  if (!f.client.trim()) return ElMessage.warning('请填写委托单位')
  if (f.rows.some(r => !r.point.trim() || !r.items.length)) return ElMessage.warning('每行报价都要填点位名称并选检测项目')
  submitting.value = true
  try {
    const rows = f.rows.map(r => ({
      category: r.category, point: r.point.trim(), ...splitRowItems(r.items),
      price: Number(r.price) || 0, points: Math.max(1, Number(r.points) || 1),
      perDay: Math.max(1, Number(r.perDay) || 1), perYear: Math.max(0, Number(r.perYear) || 0), note: r.note,
    }))
    const c = await api.createContract({
      client: f.client, contact: f.contact, phone: f.phone, project: f.project || `${f.client}  检测项目`,
      periodStart: f.periodStart, periodEnd: f.periodEnd,
      quote: { extNo: f.extNo, signDate: f.signDate, invoice: f.invoice, discount: f.discount ?? undefined, buyer: f.buyer, rows },
    })
    ElMessage.success(`已建项目 ${c.id}，检测计划已按报价单生成；「确认受理」做完合同评审后即可打印合同`)
    qform.value = blankQuoteForm()
    await refresh(); await open(c.id)
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { submitting.value = false }
}
function printContract() {
  if (!current.value) return
  const url = router.resolve({ name: 'contract-print', params: { id: current.value.contract.id } }).href
  window.open(url, '_blank')
}

// —— 项目详情动作 ——
async function genSamples() {
  if (!current.value) return
  const c = current.value.contract
  const total = c.plan.reduce((s, p) => s + p.qty, 0)
  await ElMessageBox.confirm(`将按计划生成 ${total} 个样品，确认？`, '一键生成样品', { confirmButtonText: '生成', cancelButtonText: '取消', type: 'info' }).catch(() => Promise.reject())
    .then(async () => {
      const res = await api.generateSamples(c.id)
      // 后端新版会带 hint（生成的样品要先登记交接、质控签收后才能录数据）——弹出来当下一步指引
      const hint = res && !Array.isArray(res) ? res.hint : ''
      ElMessage.success('已生成样品')
      if (hint) await ElMessageBox.alert(hint, '下一步', { confirmButtonText: '知道了' }).catch(() => {})
      await refresh()
    }).catch(() => {})
}
const genRptBusy = ref(false)
async function genReport(sampleId: string) {
  if (genRptBusy.value) return
  genRptBusy.value = true
  try { await api.generateReport(sampleId); ElMessage.success('已生成报告'); await refresh() }
  catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { genRptBusy.value = false }
}
const canReport = computed(() => current.value && current.value.stats.samples > 0 && current.value.stats.approved === current.value.stats.samples)

// —— 委托受理（合同评审 · 照 QTCYT/JL141 评审记录表填） ——
const reviewDlg = ref(false)
const PURPOSES = ['委托检测', '环评检测', '验收监测', '送样检测', '其他']
const blankReview = () => ({
  purpose: '委托检测',                                      // 监测目的
  manpower: true, instruments: true, environment: true, method: true,   // 四项资源确认 是/否
  subcontract: false, subFee: '',                           // 是否分包 + 分包费用
  conclusion: '',                                           // 评审结论/意见
  // 兼容旧字段（详情条和老数据用）
  demand: true, ability: true, risk: true, note: '',
})
const review = ref(blankReview())
function doAccept() { review.value = blankReview(); reviewDlg.value = true }
// 合同评审签批（拍板7）：同意=生效凭据（打印正本门禁）；不同意留意见。人选未定，权限暂挂管理员
const techReviewBusy = ref(false)
async function doTechReview(decision: 'approve' | 'reject') {
  if (!current.value?.contract || techReviewBusy.value) return
  // 签批是合同生效的签名动作，和三级审核「通过」同规格——先确认
  const ok = await ElMessageBox.confirm(
    decision === 'approve' ? `签批同意 ${current.value.contract.id}？同意后合同生效、可打印正本，签名留痕。` : `记录「不同意签订」${current.value.contract.id}？签名留痕。`,
    '签批确认', { confirmButtonText: decision === 'approve' ? '同意签订' : '不同意签订', cancelButtonText: '取消', type: 'warning' },
  ).catch(() => null)
  if (!ok) return
  techReviewBusy.value = true
  try {
    const c = await api.techReviewContract(current.value.contract.id, decision)
    current.value.contract = { ...current.value.contract, ...c }
    ElMessage.success(decision === 'approve' ? '已签批同意，合同可打印正本' : '已记录「不同意签订」')
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { techReviewBusy.value = false }
}
const acceptBusy = ref(false)   // 防连点：连点会重复受理报错吓人
async function confirmAccept() {
  if (!current.value || acceptBusy.value) return
  const r = review.value
  r.ability = r.manpower && r.instruments && r.environment && r.method   // 四项全是 → 能力满足
  r.note = r.conclusion
  acceptBusy.value = true
  try { await api.acceptContract(current.value.contract.id, r); ElMessage.success('已受理·合同评审通过'); reviewDlg.value = false; await refresh() }
  catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { acceptBusy.value = false }
}

// —— 监测方案 编制 / 审核 ——
const CYCLES = [{ v: 0, t: '单次（不重复）' }, { v: 1, t: '每月一次' }, { v: 3, t: '每季度一次' }, { v: 6, t: '每半年一次' }, { v: 12, t: '每年一次' }]
function cycleLabel(m: number) { return CYCLES.find(c => c.v === m)?.t || `每 ${m} 个月` }
function dueText(due: string) { const d = daysTo(due); return d < 0 ? '已逾期' : d <= 14 ? `${d} 天后到期` : '待采样' }
function dueClass(due: string, status: string) { if (status === 'done') return 'done'; if (status === 'cancelled') return 'cancelled'; const d = daysTo(due); return d < 0 ? 'overdue' : d <= 14 ? 'soon' : 'later' }
const schemeEditing = ref(false)
// S2 频次结构化：编辑态用「每天N次 perDay + 监测周期 cycleMonths」两个下拉，存盘时合成 freq 规范文本
type PtRow = { element: string; point: string; items: string[]; perDay: number; cycleMonths: number; standard: string }
// 决策7：检测项目必须从模板库选（手打自由文本会与模板对不上号，后续自动带出全失效）
const ANALYTES_BY_MATRIX = (() => {
  const m = new Map<string, string[]>()
  for (const t of templatesJson as any[]) {
    if (!t.analyte) continue
    const arr = m.get(t.matrix) || []
    if (!arr.includes(t.analyte)) arr.push(t.analyte)
    m.set(t.matrix, arr)
  }
  for (const arr of m.values()) arr.sort((a, b) => a.localeCompare(b, 'zh'))
  return m
})()
function analyteOpts(matrix: string): string[] { return ANALYTES_BY_MATRIX.get(matrix) || [] }
// 决策：执行标准从标准库(596条)选；挂了被替代的标准要红字警告
import { resolveStandard, lookupStandard } from '../data/standardLink'
import standardsRaw from '../data/standards.json'
const ALL_STANDARDS = Object.values(standardsRaw as Record<string, { code: string; name: string; current: boolean }>)
// 596 条标准塞原生 datalist 会把下拉卡死——改 el-select-v2 虚拟滚动，只渲染可见几行；搜索按「编号+名称」匹配
const STD_OPTS = ALL_STANDARDS.map(s => ({ value: s.code, label: `${s.code}  ${s.name}${s.current ? '' : '（已被替代）'}` }))
function stdWarn(code: string): string {
  const st = resolveStandard(code)
  if (st.kind === 'outdated') {
    const cur = st.info.currentCode ? lookupStandard(st.info.currentCode) : null
    return `「${st.info.code}」已被替代${cur ? `，现行为 ${cur.code}` : ''}——评审会扣分，请换现行标准`
  }
  return ''
}
const schemePoints = ref<PtRow[]>([])
const schemeLimits = ref<{ analyte: string; op: '≤' | '≥' | 'range'; value: string; value2: string; unit: string }[]>([])
const schemeCycle = ref(3)
const schemeStart = ref('')
const schemeEnd = ref('')
const PERDAY_OPTS = [1, 2, 3, 4, 6, 8]
// 常用执行标准目录（下拉可搜，亦可手填补充）—— 排放/质量标准
// 前端频次解析（与后端 parseFreq 同一套规则），把已存 freq 还原成两个下拉的值
function freqParse(freq: string): { perDay: number; cm: number } {
  const s = String(freq || '')
  const perDay = Math.max(1, Number(s.match(/每天\s*(\d+)\s*次/)?.[1] || s.match(/(\d+)\s*次\s*[\/／]\s*天/)?.[1] || 1))
  let cm = 3
  const py = s.match(/(\d+)\s*次\s*[\/／]\s*年/), pm = s.match(/(\d+)\s*次\s*[\/／]\s*月/), en = s.match(/每\s*(\d+)\s*个月/)
  if (en) cm = Number(en[1])
  else if (py) { const n = Number(py[1]); cm = n >= 1 ? Math.max(1, Math.round(12 / n)) : 0 }
  else if (pm) cm = 1
  else if (/单次/.test(s)) cm = 0
  else if (/半年/.test(s)) cm = 6
  else if (/季/.test(s)) cm = 3
  else if (/年/.test(s)) cm = 12
  else if (/月/.test(s)) cm = 1
  return { perDay, cm }
}
// 合成 freq 规范文本：「每天N次 · 每季度」——后端 parseFreq 据此拆回结构
function freqCompose(perDay: number, cm: number): string {
  const n = Math.max(1, Math.floor(Number(perDay) || 1))
  const t = cm === 0 ? '单次' : (CYCLES.find(c => c.v === cm)?.t.replace('（不重复）', '') || `每${cm}个月`)
  return `每天${n}次 · ${t}`
}
function openScheme() {
  const c = current.value!.contract
  const sc = c.scheme
  if (sc && sc.points.length) schemePoints.value = sc.points.map(p => { const f = freqParse(p.freq); return { element: p.element, point: p.point, items: [...p.items], perDay: f.perDay, cycleMonths: f.cm, standard: p.standard } })
  else if (c.quote?.rows.length) schemePoints.value = c.quote.rows.flatMap(r => {   // 报价单直带点位名/频次/周期，方案不用重填
    // 样品数口径=点位数×每天次数：报价「3 点位」就铺 3 行方案（每行一个点位），别缩成 1 行
    const n = Math.max(1, Math.floor(Number(r.points) || 1))
    return Array.from({ length: n }, (_, i) => ({
      element: r.category,
      point: n > 1 ? `${r.point}${i + 1}号` : r.point,   // 多点位先自动编号占位，名字可在方案里改
      items: [...r.items, ...(r.extraItems ? r.extraItems.split(/[,，、\s]+/).filter(Boolean) : [])],
      perDay: Math.max(1, Number(r.perDay) || 1),
      cycleMonths: r.perYear >= 1 ? Math.max(1, Math.round(12 / r.perYear)) : 0,
      standard: '',
    }))
  })
  else schemePoints.value = c.plan.length
    ? c.plan.map(p => ({ element: p.matrix, point: (p as any).point || '', items: [...p.items], perDay: Math.max(1, p.qty || 1), cycleMonths: p.cycle_months ?? 3, standard: '' }))
    : [{ element: '废水', point: '', items: [], perDay: 1, cycleMonths: 3, standard: '' }]
  schemeLimits.value = (sc?.limits ?? []).map(l => ({ analyte: l.analyte, op: l.op, value: l.value == null ? '' : String(l.value), value2: l.value2 == null ? '' : String(l.value2), unit: l.unit }))
  schemeCycle.value = sc?.cycle_months ?? c.cycle_months ?? 3
  const y = new Date().getFullYear()
  schemeStart.value = sc?.period_start || c.period_start || `${y}-01-01`
  schemeEnd.value = sc?.period_end || c.period_end || `${y}-12-31`
  if (!schemeLimits.value.length) syncLimits()
  schemeEditing.value = true
}
function addPoint() { schemePoints.value.push({ element: '废水', point: '', items: [], perDay: 1, cycleMonths: 3, standard: '' }) }
// 已批准方案的修改入口：提醒改完要重新审核 + 期次重排（后端 createScheme 会置回 draft、批准后重排）
async function openSchemeMaybeApproved() {
  if (current.value?.contract.scheme?.status === 'approved') {
    const ok = await ElMessageBox.confirm(
      '方案已批准。修改会让方案回到「待审核」，重新批准后未派工的期次将按新方案重排（已派工/已采的保留并提示人工确认）。继续修改？',
      '修改已批准的方案', { confirmButtonText: '继续修改', cancelButtonText: '取消', type: 'warning' }).catch(() => null)
    if (!ok) return
  }
  openScheme()
}
function delPoint(i: number) { if (schemePoints.value.length > 1) schemePoints.value.splice(i, 1) }
// 把上面点位里的检测项目自动列进限值表（缺的补上，不动已填的）
function syncLimits() {
  const have = new Set(schemeLimits.value.map(l => l.analyte))
  for (const p of schemePoints.value) {
    for (const a of p.items.map(s => s.trim()).filter(Boolean)) {
      if (!have.has(a)) { schemeLimits.value.push({ analyte: a, op: '≤', value: '', value2: '', unit: p.element.includes('气') ? 'mg/m³' : 'mg/L' }); have.add(a) }
    }
  }
}
function addLimit() { schemeLimits.value.push({ analyte: '', op: '≤', value: '', value2: '', unit: 'mg/L' }) }
function delLimit(i: number) { schemeLimits.value.splice(i, 1) }
const schemeSaving = ref(false)   // 防连点
async function saveSchemeFn() {
  if (!current.value || schemeSaving.value) return
  const points = schemePoints.value.map(p => ({ element: p.element, point: p.point, items: p.items.map(s => s.trim()).filter(Boolean), freq: freqCompose(p.perDay, p.cycleMonths), standard: p.standard }))
  const limits = schemeLimits.value.filter(l => l.analyte.trim()).map(l => ({
    analyte: l.analyte.trim(), op: l.op,
    value: l.value === '' ? null : Number(l.value),
    value2: l.value2 === '' ? null : Number(l.value2),
    unit: l.unit,   // standard 交后端按点位归属推断（各项目各挂本点位标准），不再全挂第一行
  }))
  schemeSaving.value = true
  try {
    // 监测周期已下放到每个点位（同步进 c.plan 各行），方案级周期不再兜底覆盖——传 0，避免「单次」点位被误当季度排
    await api.saveScheme(current.value.contract.id, { points, limits, cycleMonths: 0, periodStart: schemeStart.value, periodEnd: schemeEnd.value })
    ElMessage.success('方案已保存，待审核'); schemeEditing.value = false; await refresh()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { schemeSaving.value = false }
}

// 排出的监测期次（方案批准后）
const rounds = ref<import('../api').Round[]>([])
async function loadRounds() {
  if (!current.value || current.value.contract.scheme?.status !== 'approved') { rounds.value = []; return }
  try { rounds.value = await api.listRounds(current.value.contract.id) } catch { rounds.value = [] }
}
// 达标限值展示：没填数值的不显示成 null
function limitText(l: { op?: string; value?: any; value2?: any; unit?: string }) {
  const has = (v: any) => v !== null && v !== undefined && v !== ''
  if (l.op === 'range') return has(l.value) && has(l.value2) ? `${l.value}~${l.value2}${l.unit || ''}` : '未填'
  return has(l.value) ? `${l.op || ''}${l.value}${l.unit || ''}` : '未填'
}
const schemeRevBusy = ref(false)
async function reviewSchemeFn(op: 'approve' | 'reject') {
  if (!current.value || schemeRevBusy.value) return
  const id = current.value.contract.id
  schemeRevBusy.value = true
  try {
    if (op === 'reject') {
      const { value } = await ElMessageBox.prompt('填写打回原因', '方案打回', { confirmButtonText: '打回', cancelButtonText: '取消', inputPlaceholder: '如：点位不全、缺执行标准…' }).catch(() => ({ value: null }))
      if (value == null) return
      await api.reviewScheme(id, 'reject', undefined, value || '（未填原因）')
      ElMessage.success('方案已打回')
    } else {
      const s: any = await api.reviewScheme(id, 'approve')
      const rs = s?._reschedule
      if (rs && (rs.rescheduled || rs.manual)) {
        const parts = []
        if (rs.rescheduled) parts.push(`已按新周期重排 ${rs.rescheduled} 期`)
        if (rs.manual) parts.push(`另有 ${rs.manual} 期已派工/未采成，请人工确认是否调整`)
        ElMessage.warning(`方案已批准 · ${parts.join('；')}`)
      } else ElMessage.success('方案已批准')
    }
    await refresh()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { schemeRevBusy.value = false }
}

// —— 主线「下一步」——
const NEXT_BTN: Record<string, string> = { accept: '确认受理', scheme: '编制 / 审核方案', dispatch: '去派工', sampleIn: '去收样入库', testing: '去录入', review: '去审核', report: '生成报告', archive: '' }
// 每个环节的动作权限：没权限的人「下一步」按钮置灰并说明该谁干（纯跳转的环节不拦）
const NEXT_PERM: Partial<Record<string, PermAction>> = { accept: 'contract_accept', scheme: 'scheme_edit', report: 'report_generate' }
const nextAllowed = computed(() => {
  const st = nextStage.value; if (!st) return true
  const p = NEXT_PERM[st.key]
  if (st.key === 'scheme') return can('scheme_edit') || can('scheme_review')
  return p ? can(p) : true
})
// 报告进度文字（列表卡片 + 下一步按钮共用）
const REPORT_STATE: Record<string, string> = { none: '待出', draft: '编制中', checked: '待签发', issued: '已签发' }
const nextStage = computed(() => {
  const pl = current.value?.pipeline
  if (!pl || pl.activeIndex < 0) return null
  return pl.stages[pl.activeIndex]
})
// 下一步按钮文字：报告阶段若已生成草稿/待签发，改成「去审核/去签发」，不再误导重复「生成报告」
const nextBtnLabel = computed(() => {
  const st = nextStage.value; if (!st) return ''
  if (st.key === 'report') {
    const rs = current.value?.stats.reportStatus
    if (rs === 'draft') return '去审核报告'
    if (rs === 'checked') return '去签发报告'
  }
  return NEXT_BTN[st.key]
})
async function runNext() {
  const st = nextStage.value; if (!st) return
  if (st.key === 'accept') return doAccept()
  if (st.key === 'scheme') return openScheme()
  if (st.key === 'dispatch' || st.key === 'sampleIn') return router.push('/plans')
  if (st.key === 'testing') return router.push('/samples')
  if (st.key === 'review') return router.push('/review')
  if (st.key === 'report') {
    // 报告已生成（编制中/待签发）：直接去报告页处理，别再重复生成
    if (current.value?.stats.reportStatus === 'draft' || current.value?.stats.reportStatus === 'checked') return router.push('/reports')
    // 周期项目：出「本期」汇总报告；散样走单样报告
    const rno = current.value!.pipeline.round?.no
    if (rno) {
      const r = rounds.value.find(x => x.round_no === rno)
      if (r) {
        try { const rep = await api.generateRoundReport(r.id); ElMessage.success(`已生成第 ${rno} 期报告 ${rep.id}`); await refresh() }
        catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
        return
      }
    }
    const s = current.value!.samples.find(x => x.rollup === 'approved')
    if (s) return genReport(s.id)
    return router.push('/reports')
  }
}

// —— 合同编辑（决策8：能改、字段级留痕；改有效期自动重排未派工期次）——
const editDlg = ref(false)
const editForm = ref({ client: '', contact: '', phone: '', project: '', note: '', periodStart: '', periodEnd: '' })
function openEdit() {
  const c = current.value!.contract
  editForm.value = {
    client: c.client || '', contact: c.contact || '', phone: (c as any).phone || '', project: c.project || '',
    note: c.note || '', periodStart: c.period_start || '', periodEnd: c.period_end || '',
  }
  editDlg.value = true
}
const editSaving = ref(false)   // 防连点
async function saveEdit() {
  if (!current.value || editSaving.value) return
  if (!editForm.value.client.trim()) return ElMessage.warning('客户名称必填')
  editSaving.value = true
  try {
    const r = await api.updateContract(current.value.contract.id, { ...editForm.value })
    editDlg.value = false
    if (!r.changes.length) { ElMessage.info('没有改动'); return }
    let msg = `已保存 ${r.changes.length} 处改动（全部留痕）`
    if (r.reschedule) msg += `；有效期变更：重排了 ${r.reschedule.rescheduled} 期${r.reschedule.manual ? `，${r.reschedule.manual} 期已派工需人工确认` : ''}`
    ElMessage.success(msg)
    await refresh()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { editSaving.value = false }
}

// 合同终止（决策：只对已确认合同）：客户中途不做了，原因必填、全程留痕
// 加急：客户催单的系统抓手——采样派工列表置顶+红标，通知单时限自然收紧
async function toggleUrgent() {
  if (!current.value) return
  try {
    const to = !current.value.contract.urgent
    await api.updateContract(current.value.contract.id, { urgent: to })
    current.value.contract = { ...current.value.contract, urgent: to ? 1 : 0 }
    ElMessage.success(to ? '已标记加急（派工列表置顶）' : '已取消加急')
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
}
async function doTerminate() {
  if (!current.value) return
  const c = current.value.contract
  try {
    const { value } = await ElMessageBox.prompt(
      `终止合同 ${c.id}？终止后不再排新期次；已出的报告和已有记录不受影响。填终止原因：`,
      '终止合同', { confirmButtonText: '确认终止', cancelButtonText: '取消', inputPlaceholder: '如：客户中止合作 / 企业关停' })
    if (!value?.trim()) return ElMessage.warning('终止原因必填')
    await api.terminateContract(c.id, value.trim())
    ElMessage.success('合同已终止（留痕）')
    await refresh(); await open(c.id)
  } catch { /* 用户取消 */ }
}

// —— 合同原件上传/预览 ——
const docInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
function pickDoc() { docInput.value?.click() }
async function onDocPicked(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file || !current.value) return
  uploading.value = true
  try {
    await api.uploadContractDoc(current.value.contract.id, file)
    ElMessage.success('合同原件已上传')
    await refresh()
  } catch (err: any) { ElMessage.error('上传失败：' + (err?.response?.data?.error || err?.message || err)) }
  finally { uploading.value = false; if (docInput.value) docInput.value.value = '' }
}
const docIsPdf = computed(() => (current.value?.contract.doc_name || '').toLowerCase().endsWith('.pdf'))

// ⌘K 直达：/contracts?open=WT2026-XXXX 进来直接展开那一单（含已在本页时再次搜索）
const route = useRoute()
onMounted(async () => {
  await refresh()
  if (route.query.open) await open(String(route.query.open))
})
watch(() => route.query.open, async v => { if (v) await open(String(v)) })
</script>

<template>
  <div class="pagewrap wide">
    <div class="phead">
      <div>
        <h1 class="page">委托项目</h1>
        <p class="sub">从委托受理到报告签发，一单一条主线</p>
      </div>
      <el-button v-if="can('contract_edit')" type="primary" @click="showCreate = !showCreate; current = null">新建委托</el-button>
    </div>

    <div class="proj">
    <!-- 左：项目列表 -->
    <section class="col">
      <div class="sechead">
        <h2>全部项目</h2>
        <span class="seccount num">{{ listKeyword || listStatus ? shownProjects.length + ' / ' : '' }}{{ projects.length }} 单</span>
      </div>
      <div class="left card">
      <div class="lfilters">
        <input v-model="listKeyword" class="lsearch" placeholder="搜合同号 / 客户名 / 项目名…" />
        <select v-model="listStatus" class="lstatus" title="按状态筛选">
          <option value="">全部状态</option>
          <option value="draft">草稿</option>
          <option value="confirmed">已确认</option>
          <option value="terminated">已终止</option>
        </select>
      </div>
      <div class="list" v-loading="loading">
        <div v-for="p in shownProjects" :key="p.id" class="pjrow" :class="{ on: current?.contract.id === p.id }" @click="open(p.id)">
          <div class="pc-top">
            <span class="sdot" :class="{ good: projStatus(p).k === 'done', warn: projStatus(p).k === 'draft', accent: projStatus(p).k === 'active' }"></span>
            <span class="pc-name">{{ p.client }}<span v-if="p.project" class="pc-proj"> · {{ p.project }}</span><span v-else class="pc-noproj"> · 未填项目名</span></span>
            <span class="pc-st">{{ projStatus(p).t }}</span>
          </div>
          <div class="pc-no mono">{{ p.id }}<span v-if="p.created_at" class="pc-date"> · 委托 {{ p.created_at.slice(0, 10) }}</span></div>
          <div class="pc-stage">
            <span v-if="p.pipeline.activeIndex < 0" class="fin">{{ p.pipeline.round ? `${p.pipeline.round.total} 期全部完成 · 已归档` : '已完成 · 已归档' }}</span>
            <span v-else>当前 <em>{{ stageText(p) }}</em><i> → {{ p.pipeline.stages[p.pipeline.activeIndex].who }}</i></span>
          </div>
          <div class="pc-prog num">
            <span>样品 {{ p.stats.samples }}</span><i>·</i>
            <span>检测 {{ p.stats.tested }}/{{ p.stats.samples }}</span><i>·</i>
            <span>审核 {{ p.stats.approved }}/{{ p.stats.samples }}</span><i>·</i>
            <span class="rp"><span v-if="p.stats.reportStatus === 'issued'" class="sdot good"></span>报告 {{ REPORT_STATE[p.stats.reportStatus] }}</span>
          </div>
          <div class="prog pc-bar"><i :style="{ width: pipePct(p) + '%' }"></i></div>
        </div>
        <div v-if="!projects.length && !loading" class="empty">还没有项目。点右上「新建委托」建第一单。</div>
        <div v-else-if="!shownProjects.length && !loading" class="empty">没有匹配的项目——换个关键词或状态试试</div>
      </div>
      </div>
    </section>

    <!-- 右：新建 或 项目详情 -->
    <section class="col">
      <div class="sechead">
        <h2>{{ showCreate ? '新建委托' : '项目详情' }}</h2>
      </div>
      <div class="right card">
      <!-- 新建委托 -->
      <template v-if="showCreate">
        <div class="dhead">
          <div class="dname">新建委托项目</div>
          <div class="dsub">{{ createMode === 'quote' ? '照纸质合同模板填一遍：能打印盖章，检测计划自动生成' : '填委托单位与样品计划，创建后进入受理 · 合同评审' }}</div>
        </div>
        <div class="dbody">
          <div class="modeswitch">
            <span :class="{ on: createMode === 'quote' }" @click="createMode = 'quote'">按合同模板填写（推荐）</span>
            <span :class="{ on: createMode === 'simple' }" @click="createMode = 'simple'">快速登记</span>
          </div>

          <!-- 模式一：按示例合同模板填（委托信息 + 附件1报价单 + 附件2评审记录表，三张分区卡） -->
          <div v-if="createMode === 'quote'" class="qform">
            <!-- 分区1 · 委托信息 -->
            <section class="qf-sec">
              <div class="qf-sec-h"><span class="qf-badge">1</span><h4>委托信息</h4><span class="qf-hint">合同封面 · 甲乙双方与有效期</span></div>
              <div class="qf-grid">
                <label class="qf-f"><span class="qf-lab">委托单位（甲方）<em>*</em></span><input v-model="qform.client" placeholder="如：蓬莱海存数控模具有限公司" /></label>
                <label class="qf-f">业务联系人<input v-model="qform.contact" placeholder="如：张工" /></label>
                <label class="qf-f">联系电话<input v-model="qform.phone" placeholder="如：138…" /></label>
                <label class="qf-f">合同编号<input v-model="qform.extNo" placeholder="如：TCHT2026002" /></label>
                <label class="qf-f">签订日期<input type="date" v-model="qform.signDate" /></label>
                <label class="qf-f qf-span2">项目名称<input v-model="qform.project" :placeholder="(qform.client || '××单位') + '  检测项目（可空，自动带）'" /></label>
                <div class="qf-f qf-span2">
                  <span class="qf-lab">合同有效期</span>
                  <div class="qf-daterange"><input type="date" v-model="qform.periodStart" /><span class="qf-tilde">~</span><input type="date" v-model="qform.periodEnd" /></div>
                </div>
              </div>
              <details class="qf-buyer">
                <summary>甲方开票信息（选填 · 打印合同自动带出，不填留白手写）</summary>
                <div class="qf-grid">
                  <label class="qf-f qf-span2">地址<input v-model="qform.buyer.addr" placeholder="甲方注册地址" /></label>
                  <label class="qf-f">开户银行<input v-model="qform.buyer.bank" placeholder="如：工商银行××支行" /></label>
                  <label class="qf-f">银行账号<input v-model="qform.buyer.account" /></label>
                  <label class="qf-f">税号<input v-model="qform.buyer.taxNo" placeholder="统一社会信用代码" /></label>
                  <label class="qf-f">行号<input v-model="qform.buyer.bankNo" /></label>
                  <label class="qf-f">企业法人<input v-model="qform.buyer.legal" /></label>
                </div>
              </details>
            </section>

            <!-- 分区2 · 附件1 报价单 -->
            <section class="qf-sec">
              <div class="qf-sec-h"><span class="qf-badge">2</span><h4>附件1 · 报价单</h4><span class="qf-hint">项目从字典勾选才能自动排计划；打不出来的直接打字回车补上</span></div>
              <div class="qf-qt">
                <div class="qf-qt-head"><span>类别</span><span>点位名称</span><span>检测项目</span><span>单价(元)</span><span title="有几个采样点位">点位数</span><span title="每个点位一天采几次">每天几次</span><span title="一年来几轮：12=每月、4=每季度、1=一年一次、0=只做一次">每年几轮</span><span title="单价 × 点位数 × 每天几次 × 每年几轮">小计</span><span></span></div>
                <div v-for="(r, i) in qform.rows" :key="i" class="qf-qt-row">
                  <select v-model="r.category"><option v-for="cg in QUOTE_CATEGORIES" :key="cg" :value="cg">{{ cg }}</option></select>
                  <input v-model="r.point" placeholder="如：熔炉废气排气筒" />
                  <el-select v-model="r.items" multiple filterable allow-create default-first-option collapse-tags collapse-tags-tooltip :max-collapse-tags="2" placeholder="勾选或打字" size="small">
                    <el-option v-for="it in ITEM_DICT" :key="it" :label="it" :value="it" />
                  </el-select>
                  <input v-model.number="r.price" type="number" min="0" />
                  <input v-model.number="r.points" type="number" min="1" />
                  <input v-model.number="r.perDay" type="number" min="1" />
                  <input v-model.number="r.perYear" type="number" min="0" title="0=单次" />
                  <span class="qf-subt mono">{{ rowSubtotal(r).toLocaleString() }}</span>
                  <button class="qf-del" @click="delQuoteRow(i)" title="删除这行">×</button>
                </div>
              </div>
              <button class="qf-addrow" @click="addQuoteRow">＋ 加一行报价</button>
              <div class="qf-sum">
                <span>费用合计（含税）<b class="mono">¥{{ quoteTotal.toLocaleString() }}</b></span>
                <span class="qf-sum-disc">折后价 <input v-model.number="qform.discount" type="number" min="0" :placeholder="String(quoteTotal)" /> 元</span>
                <span class="qf-sum-upper">大写 <b>{{ quoteUpper }}</b></span>
              </div>
              <label class="qf-f">开票备注<input v-model="qform.invoice" placeholder="如：6%增值税专用发票（可空）" /></label>
              <p class="qf-tip">怎么填：一个排口一天测 3 次、每季度来一轮 → 点位数1 · 每天几次3 · 每年几轮4；小计=单价×点位数×每天几次×每年几轮。每年几轮：12=每月 · 4=每季度 · 2=每半年 · 1=一年一次 · 0=只做一次</p>
            </section>

            <button class="qf-submit" :disabled="submitting" @click="createByQuote">
              {{ submitting ? '创建中…' : '创建项目 · 自动生成检测计划' }}
            </button>
            <p class="qf-tip" style="text-align:center">建单后由技术负责人在「确认受理」里做合同评审（QTCYT/JL141），评审通过才能打印合同</p>
          </div>

          <!-- 模式二：快速登记（原有） -->
          <div v-else class="reg">
            <label>委托单位 *<input v-model="form.client" placeholder="如：山东甲厂" /></label>
            <label>联系人<input v-model="form.contact" placeholder="如：张工" /></label>
            <label>联系电话<input v-model="form.phone" placeholder="如：138…" /></label>
            <label class="wide">项目名称<input v-model="form.project" placeholder="如：总排口例行监测（可空）" /></label>
            <div class="wide">
              <div class="plabel">合同有效期 <span class="hint">例行监测多为包年</span></div>
              <div class="cycrow">
                <input type="date" v-model="form.periodStart" />
                <span class="tilde">~</span>
                <input type="date" v-model="form.periodEnd" />
              </div>
            </div>
            <div class="wide">
              <div class="plabel">样品计划 <span class="hint">每行 = 基质 + 检测项目 + 数量 + <b>各自的监测周期</b>（废水可每月、废气可每季）</span></div>
              <div class="prow-head"><span>基质</span><span>检测项目</span><span>数量</span><span>监测周期</span><span></span></div>
              <div v-for="(p, i) in form.plan" :key="i" class="prow">
                <select v-model="p.matrix"><option v-for="m in MATRICES" :key="m" :value="m">{{ m === '废气' ? '废气（历史未区分）' : m }}</option></select>
                <!-- 决策7 同口径：项目从模板库勾选才对得上记录表；实在缺项可现打（会提醒） -->
                <el-select v-model="p.items" multiple filterable allow-create default-first-option collapse-tags collapse-tags-tooltip :max-collapse-tags="2" placeholder="从模板库选项目（可搜）" size="small" class="items" @change="warnFreeItem">
                  <el-option v-for="it in ITEM_DICT" :key="it" :label="it" :value="it" />
                </el-select>
                <input v-model.number="p.qty" type="number" min="1" class="qty" />
                <select v-model.number="p.cycleMonths" class="cyc"><option v-for="c in CYCLES" :key="c.v" :value="c.v">{{ c.t }}</option></select>
                <span class="del" @click="delPlan(i)">×</span>
              </div>
              <span class="addrow" @click="addPlan">＋ 加一种样品</span>
            </div>
            <el-button type="primary" class="wide" :loading="submitting" @click="createContract">创建项目</el-button>
          </div>
        </div>
      </template>

      <!-- 项目详情 -->
      <template v-else-if="current">
        <div class="dhead">
          <div>
            <div class="dname"><el-icon class="fi2"><Folder /></el-icon>{{ current.contract.client }}<span v-if="current.contract.project" class="dproj"> · {{ current.contract.project }}</span><span v-if="current.contract.status === 'terminated'" class="pill crit">已终止</span><span v-if="current.contract.urgent" class="pill crit">加急</span>
              <el-button v-if="can('contract_edit') && current.contract.status !== 'terminated'" size="small" text @click="toggleUrgent">{{ current.contract.urgent ? '取消加急' : '标记加急' }}</el-button></div>
            <div class="dsub mono">{{ current.contract.id }}<span v-if="current.contract.quote?.extNo"> · 合同 {{ current.contract.quote.extNo }}</span><span v-if="current.contract.contact"> · {{ current.contract.contact }}</span><span v-if="current.contract.phone"> {{ current.contract.phone }}</span></div>
          </div>
          <el-button v-if="can('contract_edit')" size="small" @click="openEdit">编辑合同</el-button>
          <el-button v-if="current.contract.quote && current.contract.accepted_at && current.contract.tech_approved_at" size="small" @click="printContract">打印合同</el-button>
          <span v-else-if="current.contract.quote && current.contract.accepted_at" class="print-wait">待技术负责人签批后可打印合同</span>
          <span v-else-if="current.contract.quote" class="print-wait">合同评审（确认受理）通过后可打印合同</span>
        </div>
        <div class="dbody">
          <!-- 主线一条龙：每环带编号，当前环点亮；周期项目显示当前是第几期 -->
          <div v-if="current.pipeline.round?.no" class="roundline">
            正在走 <em>第 {{ current.pipeline.round.no }} 期</em> / 共 <span class="num">{{ current.pipeline.round.total }}</span> 期
            <span v-if="current.pipeline.round.due" class="mono rl-due"> · 本期采样截止 {{ current.pipeline.round.due }}</span>
          </div>
          <div class="pipe">
            <div v-for="s in current.pipeline.stages" :key="s.key" class="pstep" :class="s.status">
              <span class="pk">{{ s.label }}</span>
              <span class="pcode mono">{{ s.code }}</span>
            </div>
          </div>

          <!-- 下一步：该谁点什么，一键推进 -->
          <div v-if="nextStage" class="nextbar">
            <div class="nb-l">
              <span class="nb-tag">下一步</span>
              <b>{{ nextStage.label }}</b>
              <span class="nb-who">{{ nextStage.who }} · {{ nextStage.action }}</span>
            </div>
            <el-button type="primary" size="small" :disabled="!nextAllowed" :title="nextAllowed ? '' : `此环节由「${nextStage.who}」操作`" @click="runNext">{{ nextBtnLabel }} →</el-button>
          </div>
          <div v-else class="nextbar ok">
            <span class="sdot good"></span>
            <span>{{ current.pipeline.round ? `${current.pipeline.round.total} 期监测全部完成并归档` : '全流程已完成并归档' }}，全链路可追溯</span>
          </div>

          <!-- 合同评审结论（受理时留）＋ 签批（拍板7）：签批是评审的落笔，同一条横条左结论右签字。技术负责人人选未定，权限暂挂管理员 -->
          <div v-if="current.contract.review_info || current.contract.accepted_at" class="reviewbar">
            <span class="rv-tag">合同评审</span>
            <template v-if="current.contract.review_info">
              <span class="rv-i" :class="{ no: !current.contract.review_info.demand }">
                <span class="sdot" :class="current.contract.review_info.demand ? 'good' : 'crit'"></span>客户需求明确
              </span>
              <span class="rv-i" :class="{ no: !current.contract.review_info.ability }">
                <span class="sdot" :class="current.contract.review_info.ability ? 'good' : 'crit'"></span>检测能力满足
              </span>
              <span class="rv-i sub" v-if="current.contract.review_info.subcontract">
                <span class="sdot warn"></span>含分包
              </span>
              <span class="rv-i" :class="{ no: !current.contract.review_info.risk }">
                <span class="sdot" :class="current.contract.review_info.risk ? 'good' : 'crit'"></span>风险可控
              </span>
              <span v-if="current.contract.review_info.note" class="rv-note">· {{ current.contract.review_info.note }}</span>
            </template>
            <span v-if="current.contract.accepted_at" class="rv-sign">
              <template v-if="current.contract.tech_approved_at">
                <span class="sdot good"></span>已签批同意 · {{ current.contract.tech_approved_by }}
              </template>
              <template v-else-if="current.contract.tech_review_result === 'reject'">
                <span class="sdot crit"></span>签批不同意 · {{ current.contract.tech_approved_by }}
              </template>
              <template v-else-if="can('contract_tech_review')">
                <el-button size="small" type="primary" @click="doTechReview('approve')">签批 · 同意签订</el-button>
                <el-button size="small" text type="danger" @click="doTechReview('reject')">不同意</el-button>
              </template>
              <template v-else>
                <span class="sdot warn"></span>待技术负责人签批
              </template>
            </span>
          </div>

          <!-- 合同原件 -->
          <div class="sec">
            <div class="sec-h">合同原件 / 委托单
              <span v-if="can('contract_edit')" class="link" @click="pickDoc">{{ current.contract.doc_name ? '重新上传' : '上传文件' }}</span>
            </div>
            <input ref="docInput" type="file" accept=".pdf,.png,.jpg,.jpeg,.doc,.docx" style="display:none" @change="onDocPicked" />
            <template v-if="current.contract.doc_name">
              <div class="docbar">
                <el-icon><Document /></el-icon>
                <span class="docname">{{ current.contract.doc_name }}</span>
                <a :href="api.contractDocUrl(current.contract.id)" target="_blank" class="link">在新标签打开 →</a>
              </div>
              <iframe v-if="docIsPdf" :src="api.contractDocUrl(current.contract.id)" class="docframe" title="合同原件"></iframe>
            </template>
            <div v-else class="muted">还没上传委托单/合同文件。点右上「上传文件」，支持 PDF / 图片 / Word。</div>
          </div>

          <!-- 监测方案（受理后编制→审核） -->
          <div class="sec" v-if="current.contract.accepted_at">
            <div class="sec-h">监测方案
              <span class="mono acc">已受理 · {{ current.contract.accepted_by }}</span>
              <!-- 已批准的方案也能改（§8.4 合同变更）：改后回到待审核、重新批准后未派工期次自动重排 -->
              <span v-if="!schemeEditing && can('scheme_edit')" class="link" @click="openSchemeMaybeApproved">{{ current.contract.scheme ? '修改方案' : '编制方案' }}</span>
            </div>

            <!-- 编辑态 -->
            <template v-if="schemeEditing">
              <div class="sch-cyc">
                <label>有效期起<input type="date" v-model="schemeStart" /></label>
                <label>有效期止<input type="date" v-model="schemeEnd" /></label>
                <span class="cyc-note">监测周期在下面每个点位单独选（废水/废气可不同）；保存即同步「样品计划」与采样排期</span>
              </div>
              <div class="sch-head"><span>要素/基质</span><span>点位</span><span>检测项目</span><span>每天次数</span><span>监测周期</span><span>执行标准</span><span></span></div>
              <template v-for="(p, i) in schemePoints" :key="i">
                <div class="sch-row">
                  <select v-model="p.element"><option v-for="m in MATRICES" :key="m" :value="m">{{ m === '废气' ? '废气（历史未区分）' : m }}</option></select>
                  <input v-model="p.point" placeholder="总排口 / 厂界（必填）" />
                  <!-- 决策7：项目只能从模板库选（454张表的项目名录），不能手打——手打对不上模板，后面全乱 -->
                  <el-select v-model="p.items" multiple filterable collapse-tags collapse-tags-tooltip placeholder="从模板库选项目" size="small" class="sch-items">
                    <el-option v-for="a in analyteOpts(p.element)" :key="a" :label="a" :value="a" />
                  </el-select>
                  <select v-model.number="p.perDay" title="每天采样次数（= 本期样品数量）"><option v-for="n in PERDAY_OPTS" :key="n" :value="n">每天{{ n }}次</option></select>
                  <select v-model.number="p.cycleMonths" title="监测周期（与采样排期同一份数据）"><option v-for="c in CYCLES" :key="c.v" :value="c.v">{{ c.t }}</option></select>
                  <el-select-v2 v-model="p.standard" :options="STD_OPTS" filterable allow-create clearable placeholder="搜标准库（596条）" size="small" class="sch-std" popper-class="sch-std-pop" :fit-input-width="false" />
                  <span class="del" @click="delPoint(i)">×</span>
                </div>
                <div v-if="stdWarn(p.standard)" class="std-warn"><span class="sdot crit"></span>{{ stdWarn(p.standard) }}</div>
              </template>
              <div class="addrow-line"><span class="addrow" @click="addPoint">＋ 加点位</span><span class="sch-tip">频次拆成「每天次数 + 监测周期」，与采样排期同一份数据；执行标准每个点位各记各的</span></div>

              <!-- 达标限值：报告带出限值供人工对照（系统不自动判，限值随标准/企业类别变，自动判易错） -->
              <div class="lim-h">达标限值 <span class="hint2">填了限值，报告里会带出限值列供人工比对判定；系统不自动判</span>
                <span class="link" @click="syncLimits">按上面项目自动列出</span>
              </div>
              <div class="lim-head"><span>检测项目</span><span>判定</span><span>限值</span><span>单位</span><span></span></div>
              <div v-for="(l, i) in schemeLimits" :key="i" class="lim-row">
                <input v-model="l.analyte" placeholder="锌" />
                <select v-model="l.op"><option value="≤">≤ 不超过</option><option value="≥">≥ 不低于</option><option value="range">范围</option></select>
                <span class="lim-val">
                  <input v-model="l.value" type="number" step="any" :placeholder="l.op === 'range' ? '下限' : '限值'" />
                  <template v-if="l.op === 'range'"><i>~</i><input v-model="l.value2" type="number" step="any" placeholder="上限" /></template>
                </span>
                <!-- 单位从常用目录选（mg/m³ 的 ³、μg 的 μ 键盘打不出来）；也能手打自定义 -->
                <el-select v-model="l.unit" filterable allow-create default-first-option placeholder="mg/L" size="small" class="lim-unit">
                  <el-option v-for="u in UNIT_OPTS" :key="u" :label="u" :value="u" />
                </el-select>
                <span class="del" @click="delLimit(i)">×</span>
              </div>
              <div class="addrow-line"><span class="addrow" @click="addLimit">＋ 加限值</span></div>

              <div class="sch-acts">
                <span style="flex:1"></span>
                <el-button size="small" @click="schemeEditing = false">取消</el-button>
                <el-button size="small" type="primary" :loading="schemeSaving" :disabled="schemeSaving" @click="saveSchemeFn">保存方案（待审核）</el-button>
              </div>
            </template>

            <!-- 展示态 -->
            <template v-else-if="current.contract.scheme">
              <div class="sch-bar">
                <span class="mono">{{ current.contract.scheme.id }}</span>
                <span class="pill" :class="current.contract.scheme.status === 'approved' ? 'good' : current.contract.scheme.status === 'rejected' ? 'crit' : 'warn'">{{ current.contract.scheme.status === 'approved' ? '已批准 · ' + current.contract.scheme.reviewer : current.contract.scheme.status === 'rejected' ? '已打回' : '待审核' }}</span>
                <template v-if="current.contract.scheme.status === 'draft' && can('scheme_review')">
                  <span style="flex:1"></span>
                  <el-button size="small" @click="reviewSchemeFn('reject')">打回</el-button>
                  <el-button size="small" type="primary" @click="reviewSchemeFn('approve')">方案审核通过</el-button>
                </template>
              </div>
              <div v-if="current.contract.scheme.status === 'rejected'" class="sch-rej">打回原因：{{ current.contract.scheme.reject_reason }}</div>
              <div class="sch-cyc-show">
                <span v-if="current.contract.period_start" class="cyc-period mono">有效期 {{ current.contract.period_start }} ~ {{ current.contract.period_end }}</span>
                <span v-for="(p, i) in current.contract.plan" :key="i" class="cyc-item">{{ p.matrix }}·{{ p.items.join('、') }} <em>{{ cycleLabel(p.cycle_months) }}</em></span>
              </div>
              <div class="sch-head show"><span>要素/基质</span><span>点位</span><span>检测项目</span><span>频次</span><span>执行标准</span></div>
              <div v-for="(p, i) in current.contract.scheme.points" :key="i" class="sch-row show">
                <span>{{ p.element }}</span><span>{{ p.point || '—' }}</span><span>{{ p.items.join('、') }}</span><span>{{ p.freq || '—' }}</span><span class="mono">{{ p.standard || '—' }}</span>
              </div>
              <div v-if="current.contract.scheme.limits && current.contract.scheme.limits.length" class="lim-show">
                <span class="lim-tag">达标限值</span>
                <span v-for="(l, i) in current.contract.scheme.limits" :key="i" class="lim-item">
                  {{ l.analyte }} <em class="mono">{{ limitText(l) }}</em>
                </span>
              </div>

              <!-- 排出的监测期次 + 到期提醒 + 去采样 -->
              <div v-if="rounds.length" class="rounds">
                <div class="rounds-h">监测排期 · <span class="num">{{ rounds.length }}</span> 期（到期自动提醒 · 可逐期采样）</div>
                <div class="round" v-for="r in rounds" :key="r.id" :class="dueClass(r.due_date, r.status)">
                  <span class="sdot" :class="{ good: dueClass(r.due_date, r.status) === 'done', crit: dueClass(r.due_date, r.status) === 'overdue', warn: dueClass(r.due_date, r.status) === 'soon' }"></span>
                  <span class="r-no">第 {{ r.round_no }} 期</span>
                  <span class="r-date mono">{{ r.due_date }}</span>
                  <span class="r-samp" :class="{ todo: !r.sampler }">{{ r.sampler ? '采样员 ' + r.sampler : '待派工' }}</span>
                  <template v-if="r.status === 'done'">
                    <span class="r-st">已采 <span class="num">{{ r.sample_count }}</span> 样品</span>
                  </template>
                  <template v-else-if="r.status === 'cancelled'">
                    <span class="r-st">已终止 · 不再补采</span>
                  </template>
                  <template v-else>
                    <span class="r-st">{{ dueText(r.due_date) }}</span>
                    <span class="r-go" @click="router.push('/plans')">{{ r.sampler ? '去采样 →' : '去派工 →' }}</span>
                  </template>
                </div>
              </div>
            </template>

            <div v-else class="muted">受理后请编制监测方案（点位·项目·频次·执行标准），审核通过才能排采样。<span v-if="can('scheme_edit')" class="link" @click="openScheme"> 编制方案 →</span></div>
          </div>

          <!-- 样品 -->
          <div class="sec">
            <div class="sec-h">这一单的样品（{{ current.samples.length }}）
              <el-button v-if="current.contract.status === 'draft' && !rounds.length && can('contract_edit')" size="small" @click="genSamples">免采样 · 直接建样</el-button>
            </div>
            <div v-if="current.samples.length" class="rows">
              <div v-for="s in current.samples" :key="s.id" class="srow" @click="router.push('/samples?sample=' + s.id)">
                <span class="sdot" :class="{ good: s.rollup === 'approved', accent: s.rollup === 'testing', warn: s.rollup === 'review' }"></span>
                <span class="sc-id mono">{{ s.id }}</span>
                <span v-if="roundNoOf(s)" class="sc-round num">第 {{ roundNoOf(s) }} 期</span>
                <span class="sc-sub">{{ s.matrix }} · {{ s.items.join('、') }}</span>
                <span class="sc-st" :class="s.rollup">{{ rollupLabel[s.rollup] }}</span>
                <span class="sc-go">›</span>
              </div>
            </div>
            <div v-else class="muted">还没有样品。正常走「采样派工 → 现场采样收样入库」生成；赶时间可点上面「免采样·直接建样」。</div>
          </div>

          <!-- 报告 -->
          <div class="sec">
            <div class="sec-h">检测报告
              <el-button v-if="canReport && !current.reports.length && can('report_generate')" size="small" type="primary" @click="genReport(current.samples[0].id)">生成报告</el-button>
            </div>
            <div v-if="current.reports.length" class="rows">
              <div v-for="r in current.reports" :key="r.id" class="srow" @click="router.push('/reports')">
                <span class="sdot" :class="{ good: r.status === 'issued' }"></span>
                <span class="sc-id mono">{{ r.id }}</span>
                <span class="sc-sub"></span>
                <span class="sc-st" :class="r.status">{{ r.status === 'issued' ? '已签发' : '草稿' }}</span>
                <span class="sc-go">›</span>
              </div>
            </div>
            <div v-else class="muted">{{ canReport ? '所有样品已审核，可生成报告。' : '样品全部走完三级审核后可出报告。' }}</div>
          </div>

          <!-- 终止合同：低频危险操作，放最底下不显眼处；未终止都可用（周期线合同一直是 draft） -->
          <div v-if="can('contract_edit') && current.contract.status !== 'terminated'" class="sec termsec">
            <el-button text type="danger" size="small" @click="doTerminate">终止合同（中途不做了）</el-button>
          </div>
        </div>
      </template>

      <div v-else class="empty pad">左侧选一个项目，或点右上「新建委托」。</div>
      </div>
    </section>
    </div>

    <!-- 合同评审 → 受理 -->
    <!-- 合同编辑（决策8）：改动全部字段级留痕；改有效期自动重排未派工期次 -->
    <el-dialog v-model="editDlg" title="编辑合同（改动留痕）" width="460px">
      <div class="editgrid">
        <label>客户名称<input v-model="editForm.client" /></label>
        <label>联系人<input v-model="editForm.contact" /></label>
        <label>联系电话<input v-model="editForm.phone" /></label>
        <label>项目名称<input v-model="editForm.project" /></label>
        <label>备注<input v-model="editForm.note" /></label>
        <label>有效期起<input v-model="editForm.periodStart" type="date" /></label>
        <label>有效期止<input v-model="editForm.periodEnd" type="date" /></label>
      </div>
      <p class="qf-tip">改有效期会自动重排未派工的期次；已派工/已采的期次保留、提示人工确认。所有改动逐字段留痕可查。</p>
      <template #footer>
        <el-button @click="editDlg = false">取消</el-button>
        <el-button type="primary" :loading="editSaving" :disabled="editSaving" @click="saveEdit">保存改动</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="reviewDlg" title="合同评审 · 确认受理（QTCYT/JL141）" width="500px">
      <div class="rvform">
        <p class="rvhint">照《检测业务合同评审记录表》填，填完打印合同时自动带进评审表</p>
        <div class="rvrow">
          <span class="rvlab">监测目的</span>
          <select v-model="review.purpose" class="rvsel"><option v-for="p in PURPOSES" :key="p" :value="p">{{ p }}</option></select>
        </div>
        <label class="rvck"><input type="checkbox" v-model="review.manpower" />人力物质资源满足</label>
        <label class="rvck"><input type="checkbox" v-model="review.instruments" />仪器设备满足</label>
        <label class="rvck"><input type="checkbox" v-model="review.environment" />环境条件满足</label>
        <label class="rvck"><input type="checkbox" v-model="review.method" />检测方法满足</label>
        <label class="rvck"><input type="checkbox" v-model="review.subcontract" />需分包（需委托方书面同意）</label>
        <input v-if="review.subcontract" v-model="review.subFee" class="rvnote" placeholder="分包费用 / 分包项目说明" />
        <input v-model="review.conclusion" class="rvnote" placeholder="评审结论（如：同意受理，可空）" />
        <p class="rvhint">评审人员 / 日期自动记当前账号；技术负责人意见在打印件上手签</p>
      </div>
      <template #footer>
        <el-button @click="reviewDlg = false">取消</el-button>
        <el-button type="primary" :loading="acceptBusy" :disabled="acceptBusy" @click="confirmAccept">评审通过 · 确认受理</el-button>
      </template>
    </el-dialog>
  </div>
</template>


<style scoped>
/* ——— 页头 ——— */
.phead{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px}
.page{font-size:22px;font-weight:650;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--muted);margin:0;font-size:13px}
.seccount{font-size:12px;color:var(--faint)}

/* ——— 两栏：左列表 右详情 ——— */
.proj{display:grid;grid-template-columns:380px 1fr;gap:14px;height:calc(100vh - 58px - 44px - 72px)}
.col{display:flex;flex-direction:column;min-height:0}
.col > .card{flex:1;min-height:0;display:flex;flex-direction:column}

/* ——— 左：项目列表（行式，不做卡中卡） ——— */
.lfilters{display:flex;gap:8px;padding:12px;border-bottom:1px solid var(--line);flex:none}
.lsearch{flex:1;min-width:0;border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:7px 10px;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--ink)}
.lsearch:focus{outline:2px solid var(--accent);outline-offset:-1px}
.lstatus{flex:none;border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:0 8px;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--ink)}
.list{flex:1;overflow-y:auto}
.pjrow{padding:12px 16px;cursor:pointer;border-bottom:1px solid var(--line);border-left:2px solid transparent;transition:background .12s ease,border-color .12s ease}
.pjrow:hover{background:var(--surface-2)}
.pjrow.on{background:var(--accent-soft);border-left-color:var(--accent)}
.pc-top{display:flex;align-items:center;gap:8px}
.pc-name{font-size:13.5px;font-weight:600;color:var(--ink);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pc-proj{font-weight:400;color:var(--muted)}
.pc-noproj{font-weight:400;color:var(--faint)}
.pc-st{font-size:11.5px;color:var(--faint);flex:none}
.pc-date{color:var(--faint)}
.pc-no{font-size:11px;color:var(--faint);margin:4px 0 5px}
.pc-stage{font-size:11.5px;color:var(--faint);margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pc-stage em{font-style:normal;color:var(--accent-ink);font-weight:600}
.pc-stage i{font-style:normal;color:var(--faint)}
.pc-stage .fin{color:var(--muted)}
.pc-prog{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted);flex-wrap:wrap}
.pc-bar{margin-top:9px}
.pc-prog i{color:var(--faint);font-style:normal}
.pc-prog .rp{display:inline-flex;align-items:center;gap:5px}
.empty{padding:26px 18px;color:var(--faint);font-size:13px;text-align:center}
.empty.pad{padding:48px 18px}

/* ——— 右：项目详情 ——— */
.dhead{padding:14px 18px;border-bottom:1px solid var(--line);flex:none}
.dname{font-size:16px;font-weight:650;display:flex;align-items:center;gap:8px}
.fi2{color:var(--faint)}
.dproj{font-weight:400;color:var(--muted);font-size:14px}
.dsub{font-size:12.5px;color:var(--muted);margin-top:4px}
.dbody{padding:18px;overflow-y:auto;flex:1;min-height:0}

/* ——— 流程管线：色轨表示进度，不用底色块 ——— */
.roundline{font-size:12.5px;color:var(--muted);margin-bottom:12px}
.roundline em{font-style:normal;color:var(--accent-ink);font-weight:600}
.roundline .rl-due{color:var(--faint)}
.pipe{display:flex;gap:6px;margin-bottom:18px}
.pstep{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:2px;padding:9px 2px 0;border-top:2px solid var(--line)}
.pstep .pk{font-size:12px;font-weight:500;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pstep .pcode{font-size:10px;color:var(--faint)}
.pstep.done{border-top-color:var(--good)}
.pstep.done .pk{color:var(--muted)}
.pstep.active{border-top-color:var(--accent)}
.pstep.active .pk{color:var(--accent-ink);font-weight:650}
.pstep.active .pcode{color:var(--accent-ink)}

/* ——— 下一步 ——— */
.nextbar{display:flex;align-items:center;gap:12px;padding:11px 15px;border-radius:var(--radius);margin-bottom:18px;
  background:var(--surface-2);border:1px solid var(--line)}
.nextbar .nb-l{display:flex;align-items:center;gap:9px;flex-wrap:wrap;flex:1;min-width:0}
.nextbar .nb-tag{font-size:11px;font-weight:600;color:var(--accent-ink);background:var(--accent-soft);padding:2px 8px;border-radius:5px}
.nextbar .nb-l b{font-size:14px;color:var(--ink)}
.nextbar .nb-who{font-size:12px;color:var(--muted)}
.nextbar .el-button{flex:none}
.nextbar.ok{color:var(--muted);font-size:12.5px}

/* ——— 合同评审结论 ——— */
.reviewbar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:11.5px;margin-bottom:18px;padding:9px 14px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm)}
.rv-tag{font-weight:600;color:var(--faint)}
.rv-i{display:inline-flex;align-items:center;gap:6px;color:var(--ink);font-weight:500}
.rv-i.no{color:var(--muted)}
.rv-i.sub{color:var(--ink)}
.rv-note{color:var(--faint);font-weight:400}
.rv-sign{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-weight:500;color:var(--ink)}
.rvform{display:flex;flex-direction:column;gap:11px}
.rvhint{font-size:12px;color:var(--muted);margin:0 0 4px}
.rvck{display:flex;align-items:center;gap:9px;font-size:13.5px;color:var(--ink);cursor:pointer}
.rvnote{border:1px solid var(--line-strong);border-radius:7px;padding:8px 10px;font-size:13px;font-family:inherit;background:var(--surface);color:var(--ink);margin-top:4px}
.rvrow{display:flex;align-items:center;gap:10px}
.rvlab{font-size:13px;color:var(--muted);width:60px}
.rvsel{flex:1;border:1px solid var(--line-strong);border-radius:7px;padding:8px 10px;font-size:13px;font-family:inherit;background:var(--surface);color:var(--ink)}

/* ——— 分区 ——— */
.sec{margin-bottom:20px;padding-top:16px;border-top:1px solid var(--line)}
.sec-h{font-size:12.5px;font-weight:600;color:var(--muted);letter-spacing:.03em;margin-bottom:10px;display:flex;align-items:center;gap:12px;min-height:26px}
.sec-h .link{font-size:12px;font-weight:500;color:var(--accent);cursor:pointer;margin-left:auto}
.sec-h .link:hover{text-decoration:underline}
.sec-h .el-button{margin-left:auto}
.muted{font-size:12.5px;color:var(--faint)}
.muted .link{color:var(--accent);cursor:pointer}

/* ——— 方案编辑 / 展示 ——— */
.acc{font-size:11px;color:var(--faint);font-weight:500}
.sch-head,.sch-row{display:grid;grid-template-columns:84px 1fr 1.1fr 78px 104px 1.1fr 20px;gap:6px;align-items:center}   /* 编辑态 7 列：基质/点位/项目/每天次数/监测周期/标准/删 */
.sch-head{font-size:11px;color:var(--faint);margin-bottom:5px;padding:0 2px}
.sch-row{margin-bottom:6px}
.sch-row input,.sch-row select{width:100%;min-width:0;box-sizing:border-box;border:1px solid var(--line-strong);border-radius:6px;padding:6px 8px;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--ink)}
.sch-head.show,.sch-row.show{grid-template-columns:88px 1fr 1.2fr 128px 1.3fr}   /* 展示态 5 列：频次已是「每天N次·周期」整串 */
.sch-row.show{font-size:12.5px;color:var(--ink);padding:6px 2px;border-bottom:1px solid var(--line)}
.sch-tip{font-size:11px;color:var(--faint);margin-left:12px}
.sch-row.show span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sch-row .del{color:var(--faint);cursor:pointer;font-size:15px;text-align:center}
.sch-row .del:hover{color:var(--crit)}
.sch-acts{display:flex;align-items:center;gap:8px;margin-top:8px}
.sch-bar{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.sch-bar .mono{font-weight:600;font-size:13px}
.sch-rej{font-size:12px;color:var(--crit);background:var(--crit-soft);padding:6px 10px;border-radius:var(--radius-sm);margin-bottom:10px}
.sch-cyc{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px;padding:10px 12px;background:var(--surface-2);border-radius:var(--radius-sm)}
.sch-cyc label{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--muted)}
.sch-cyc select,.sch-cyc input{border:1px solid var(--line-strong);border-radius:6px;padding:6px 8px;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--ink)}
.sch-cyc .cyc-note{align-self:center;font-size:11px;color:var(--faint)}
.prow-head span:nth-child(4){font-weight:600;color:var(--accent-ink)}
.addrow-line{margin:6px 0 4px}
.lim-h{font-size:12px;font-weight:600;color:var(--ink);margin:14px 0 8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.lim-h .hint2{font-weight:400;font-size:11px;color:var(--faint)}
.lim-h .link{margin-left:auto;font-size:11.5px;color:var(--accent);cursor:pointer;font-weight:500}
.lim-head,.lim-row{display:grid;grid-template-columns:1.1fr 1fr 1.3fr 110px 20px;gap:6px;align-items:center}
.lim-head{font-size:11px;color:var(--faint);margin-bottom:5px;padding:0 2px}
.lim-row{margin-bottom:6px}
.lim-row input,.lim-row select{width:100%;min-width:0;box-sizing:border-box;border:1px solid var(--line-strong);border-radius:6px;padding:6px 8px;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--ink)}
.lim-val{display:flex;align-items:center;gap:4px}
.lim-val i{color:var(--faint)}
.lim-row .del{color:var(--faint);cursor:pointer;font-size:15px;text-align:center}
.lim-row .del:hover{color:var(--crit)}
.lim-show{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:10px}
.lim-tag{font-size:11px;font-weight:600;color:var(--faint)}
.lim-item{font-size:11.5px;color:var(--muted)}
.lim-item em{font-style:normal;color:var(--ink);font-weight:600}
.sch-cyc-show{display:flex;align-items:center;gap:14px;margin-bottom:10px;flex-wrap:wrap}
.cyc-item{font-size:11.5px;color:var(--muted)}
.cyc-item em{font-style:normal;color:var(--accent-ink);font-weight:600}
.cyc-period{font-size:12px;color:var(--faint)}

/* ——— 监测排期 ——— */
.rounds{margin-top:14px;border-top:1px solid var(--line);padding-top:12px}
.rounds-h{font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px}
.round{display:flex;align-items:center;gap:12px;padding:9px 2px;font-size:12.5px;border-bottom:1px solid var(--line);transition:background .12s ease}
.round:last-child{border-bottom:0}
.round .r-no{font-weight:600;color:var(--ink);min-width:52px}
.round .r-date{color:var(--muted);flex:1}
.round .r-st{font-size:11.5px;color:var(--faint)}
.round.overdue .r-st{color:var(--crit);font-weight:600}
.round.soon .r-st{color:var(--warn);font-weight:600}
.round .r-go{font-size:11.5px;color:var(--accent);cursor:pointer;font-weight:500}
.round .r-go:hover{text-decoration:underline}
.round .r-samp{font-size:11.5px;color:var(--ink);background:var(--surface-2);border:1px solid var(--line);border-radius:999px;padding:1px 8px}
.round .r-samp.todo{color:var(--warn);background:transparent;border-style:dashed}
.print-wait{font-size:12px;color:var(--faint)}
/* 甲方开票信息（折叠） */
.qf-buyer{margin-top:12px;border-top:1px dashed var(--line);padding-top:10px}
.qf-buyer summary{font-size:12px;color:var(--muted);cursor:pointer;user-select:none;margin-bottom:8px}
.qf-buyer summary:hover{color:var(--accent)}
.round .el-button{padding:5px 11px;height:auto}

/* ——— 合同原件 ——— */
.docbar{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--ink);margin-bottom:10px}
.docbar .el-icon{color:var(--faint)}
.docbar .docname{font-weight:500}
.docbar .link{margin-left:auto}
.docframe{width:100%;height:420px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface)}
.planrow{display:flex;gap:10px;font-size:13px;color:var(--muted);align-items:center}
.planrow .mono{font-weight:600;color:var(--ink)}

/* ——— 样品 / 报告：行式队列 ——— */
.rows{border-top:1px solid var(--line)}
.srow{display:flex;align-items:center;gap:10px;padding:10px 2px;border-bottom:1px solid var(--line);cursor:pointer;font-size:12.5px;transition:background .12s ease}
.srow:last-child{border-bottom:0}
.srow:hover{background:var(--surface-2)}
.sc-id{font-size:12.5px;font-weight:600;color:var(--ink);flex:none}
.sc-round{font-size:11px;color:var(--faint);flex:none}
.sc-sub{font-size:12px;color:var(--muted);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sc-st{font-size:11.5px;color:var(--faint);flex:none}
.sc-st.testing{color:var(--accent-ink);font-weight:500}
.sc-st.approved,.sc-st.issued{color:var(--muted)}
.sc-go{color:var(--faint);font-size:15px;line-height:1;flex:none}

/* ——— 新建委托表单 ——— */
.reg{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.reg label{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--muted);min-width:0}
.reg .wide{grid-column:1 / -1}
.reg input,.reg select{width:100%;min-width:0;box-sizing:border-box;border:1px solid var(--line-strong);border-radius:6px;padding:7px 9px;font-size:13px;font-family:inherit;background:var(--surface);color:var(--ink)}
.plabel{font-size:12px;color:var(--muted);font-weight:600;margin-bottom:7px}
.cycrow{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.cycrow select,.cycrow input{border:1px solid var(--line-strong);border-radius:6px;padding:7px 9px;font-size:13px;font-family:inherit;background:var(--surface);color:var(--ink)}
.cycrow select{flex:none;width:140px}
.cycrow input{flex:1;min-width:0}
.cycrow .tilde{color:var(--faint)}
.plabel .hint{font-weight:400;color:var(--faint)}
.prow-head{display:grid;grid-template-columns:96px 1fr 56px 120px 20px;gap:6px;font-size:11px;color:var(--faint);margin-bottom:5px;padding:0 2px}
.prow{display:grid;grid-template-columns:96px 1fr 56px 120px 20px;gap:6px;align-items:center;margin-bottom:7px}
.prow select{min-width:0}
.prow .items{min-width:0}
/* 终止合同：不显眼的底部危险区 */
.termsec{border-top:1px dashed var(--line);text-align:right}
.prow .qty{text-align:center}
.prow .cyc{min-width:0}
.prow .del{color:var(--faint);cursor:pointer;font-size:16px}
.prow .del:hover{color:var(--crit)}
.addrow{font-size:12px;color:var(--accent);cursor:pointer}
.addrow:hover{text-decoration:underline}

/* ——— 按合同模板填写 · 模式切换 ——— */
.modeswitch{display:inline-flex;gap:0;margin-bottom:18px;border:1px solid var(--line-strong);border-radius:9px;overflow:hidden;background:var(--surface-2);padding:3px}
.modeswitch span{padding:7px 16px;font-size:12.5px;cursor:pointer;color:var(--muted);border-radius:6px;transition:all .13s ease}
.modeswitch span.on{background:var(--surface);color:var(--accent);font-weight:600;box-shadow:var(--shadow-sm)}

/* ——— 新建委托表单：分区卡 ——— */
.qform{display:flex;flex-direction:column;gap:16px}
.qf-sec{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:18px 20px;box-shadow:var(--shadow-sm)}
.qf-sec-h{display:flex;align-items:center;gap:10px;margin-bottom:16px}
.qf-badge{width:22px;height:22px;flex:none;border-radius:6px;background:var(--accent-soft);color:var(--accent);font-size:12px;font-weight:700;display:grid;place-items:center}
.qf-sec-h h4{margin:0;font-size:15px;font-weight:650;color:var(--ink)}
.qf-hint{font-size:11.5px;color:var(--faint);line-height:1.4}

/* 字段网格 + 单字段 */
.qf-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.qf-f{display:flex;flex-direction:column;gap:6px;font-size:12.5px;color:var(--muted);min-width:0}
.qf-f em{color:var(--crit);font-style:normal;margin-left:3px}
.qf-f>.qf-lab,.qf-lab{font-size:12.5px;color:var(--muted)}
.qf-f input,.qf-f select{width:100%;min-width:0;box-sizing:border-box;border:1px solid var(--line-strong);border-radius:8px;padding:9px 11px;font-size:13.5px;font-family:inherit;background:var(--surface);color:var(--ink);transition:border-color .13s ease,box-shadow .13s ease}
.qf-f input:focus,.qf-f select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.qf-span2{grid-column:1 / -1}
.qf-daterange{display:flex;align-items:center;gap:10px}
.qf-daterange input{flex:1;min-width:0;box-sizing:border-box;border:1px solid var(--line-strong);border-radius:8px;padding:9px 11px;font-size:13.5px;font-family:inherit;background:var(--surface);color:var(--ink)}
.qf-daterange input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.qf-tilde{color:var(--faint)}

/* 报价单表格 */
.qf-qt{border:1px solid var(--line);border-radius:9px;overflow:hidden}
.qf-qt-head,.qf-qt-row{display:grid;grid-template-columns:92px 1fr 1.25fr 62px 42px 46px 46px 66px 24px;gap:6px;align-items:center}
.qf-qt-head{background:var(--surface-2);padding:8px 10px;font-size:11px;color:var(--muted);font-weight:600;letter-spacing:.02em}
.qf-qt-row{padding:8px 10px;border-top:1px solid var(--line)}
.qf-qt-row select,.qf-qt-row>input{min-width:0;box-sizing:border-box;border:1px solid var(--line-strong);border-radius:7px;padding:7px 8px;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--ink);transition:border-color .13s ease,box-shadow .13s ease}
.qf-qt-row select:focus,.qf-qt-row>input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
.qf-qt-row input[type=number]{text-align:center;padding:7px 4px}
.qf-subt{text-align:right;font-size:12.5px;color:var(--ink);font-weight:600}
.qf-del{border:none;background:none;color:var(--faint);cursor:pointer;font-size:17px;line-height:1;padding:0;border-radius:5px}
.qf-del:hover{color:var(--crit);background:var(--crit-soft)}
.qf-addrow{margin-top:10px;background:none;border:1px dashed var(--line-strong);border-radius:8px;padding:8px 0;width:100%;font-size:12.5px;color:var(--accent);cursor:pointer;font-family:inherit;transition:border-color .13s,background .13s}
.qf-addrow:hover{border-color:var(--accent);background:var(--accent-soft)}
.qf-sum{display:flex;align-items:center;gap:20px;flex-wrap:wrap;margin:14px 0 6px;padding:12px 14px;background:var(--surface-2);border-radius:9px;font-size:12.5px;color:var(--muted)}
.qf-sum b{color:var(--ink);font-size:15px}
.qf-sum-disc input{width:96px;border:1px solid var(--line-strong);border-radius:7px;padding:6px 9px;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--ink);text-align:right;margin:0 2px}
.qf-sum-disc input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
.qf-sum-upper{margin-left:auto}
.qf-sum-upper b{color:var(--accent);font-size:13.5px}
.qf-tip{margin:12px 0 0;font-size:11.5px;color:var(--faint);line-height:1.6}
.std-warn{display:flex;align-items:center;gap:6px;grid-column:1 / -1;font-size:11.5px;color:var(--crit);padding:2px 0 6px 4px}
.sch-items{min-width:0}
.editgrid{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px}
.editgrid label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)}
.editgrid input{border:1px solid var(--line-strong);border-radius:6px;height:30px;padding:0 9px;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--ink)}
.qf-sec .qf-f{margin-top:14px}
.qf-sec .qf-grid .qf-f,.qf-sec .qf-qt .qf-f{margin-top:0}

/* 评审：资源确认 chip 式勾选 */
.qf-checkrow{display:flex;gap:9px;flex-wrap:wrap;margin-top:2px}
.qf-check{display:inline-flex;align-items:center;gap:7px;font-size:13px;color:var(--muted);cursor:pointer;white-space:nowrap;border:1px solid var(--line-strong);border-radius:8px;padding:8px 12px;transition:all .13s ease;user-select:none}
.qf-check input{margin:0;accent-color:var(--accent)}
.qf-check.on{border-color:var(--accent);background:var(--accent-soft);color:var(--accent-ink);font-weight:600}
.qf-subrow{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:14px}
.qf-subfee{flex:1;min-width:180px;border:1px solid var(--line-strong);border-radius:8px;padding:8px 11px;font-size:13px;font-family:inherit;background:var(--surface);color:var(--ink)}
.qf-subfee:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}

/* 提交按钮 */
.qf-submit{width:100%;border:none;border-radius:10px;background:var(--accent);color:#fff;font-size:15px;font-weight:600;padding:13px 0;cursor:pointer;font-family:inherit;box-shadow:var(--shadow-sm);transition:background .13s ease}
.qf-submit:hover{background:var(--accent-2)}
.qf-submit:disabled{opacity:.6;cursor:default}

@media (max-width:1100px){
  .proj{grid-template-columns:320px 1fr}
}
@media (max-width:760px){
  .qf-grid{grid-template-columns:1fr}
}

/* 手机：左右两栏改上下堆叠，列表限高，详情随页滚 */
@media (max-width:760px){
  .proj{grid-template-columns:1fr;height:auto}
  .col > .card{flex:none}
  .list{max-height:45vh}
}
</style>

<style>
/* 执行标准下拉的弹层（teleport 到 body，scoped 样式够不着）：撑开到能看清「编号+全名」 */
.sch-std-pop{min-width:520px !important;max-width:640px}
.sch-std-pop .el-select-v2-item, .sch-std-pop li{white-space:normal;line-height:1.4}
</style>
