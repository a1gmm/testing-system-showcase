<script setup lang="ts">
// 「系统里的样子」数据驱动渲染：按 schema 自动渲染任意表原型
// 两种模式：预览模式(模板库,假数据本地留痕) / 持久化模式(传 sampleId,连后端存取真留痕)
import { reactive, ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import katex from 'katex'
import { ElMessage, ElMessageBox } from 'element-plus'
import { roundGB } from '../data/schemas'
import { resolveSchema } from '../data/schemas'
import { normalizeComponents } from '../data/multiComponent'
import { api, currentUser, type Audit, type RecordData } from '../api'
import { markDirty, clearDirty } from '../utils/dirty'
import { todayLocal } from '../utils/date'
import { auditText, actionLabel } from '../utils/auditText'
import KvBlock from './sections/KvBlock.vue'
import ChecksGroup from './sections/ChecksGroup.vue'
import MatrixGrid from './sections/MatrixGrid.vue'
import RowTable from './sections/RowTable.vue'
import NoteBlock from './sections/NoteBlock.vue'
import DiagramSlot from './sections/DiagramSlot.vue'
import RecordAttachments from './RecordAttachments.vue'

// —— layout 分区渲染：schema.layout 存在时按分区顺序渲染，取代旧的单一表格 ——
const SEC: Record<string, any> = { kv: KvBlock, checks: ChecksGroup, matrix: MatrixGrid, table: RowTable, note: NoteBlock, diagram: DiagramSlot }
function secComp(t: string) { return SEC[t] }

const props = defineProps<{
  analyte: string; method: string; matrix: string; code: string; sheetType: string
  sampleId?: string; templateName?: string
  roundId?: string                // 期次模式：采样员现场填，存 round_sheets（无三级审核链）
  tplMeta?: Record<string, any>   // 每张表从原件抽出的页脚元数据(方法依据/仪器编号/波长/狭缝/检出限等)
  readonly?: boolean              // 无该表填写权限的岗位（如质控员看采样表）：能看不能改
  lockText?: string               // 只读时的锁提示，按场景传（采样表/检测记录说法不一样）
}>()

const persist = computed(() => !!props.sampleId)
const roundPersist = computed(() => !props.sampleId && !!props.roundId)
// 演示模式 = 模板库预览。真实录入（样品/期次）绝不预填演示数据——
// 假编号/假吸光值只改一半就保存，假数据就成了正式原始记录
const isDemo = !props.sampleId && !props.roundId
const schema = resolveSchema(props.sheetType, props.method, props.code, props.tplMeta?.methodFull)
// 真实录入用与演示同结构的空行（保留行数和列键，值全清空）
function blankRowsFrom(seedRows: Record<string, any>[]): Record<string, any>[] {
  return seedRows.map(r => { const o: Record<string, any> = {}; for (const k in r) o[k] = ''; return o })
}
const rows = reactive<Record<string, any>[]>(isDemo ? schema.seed() : blankRowsFrom(schema.seed()))
// layout 的 table 分区靠 seedRows 提供初始空行（schema.seed() 对 layout 表返回空）
if (rows.length === 0 && schema.layout) {
  const tbl = schema.layout.find(s => s.type === 'table') as any
  if (tbl?.seedRows) {
    for (let i = 0; i < tbl.seedRows; i++) {
      const blank: Record<string, any> = {}
      tbl.columns.forEach((c: any) => (blank[c.key] = ''))
      rows.push(blank)
    }
  }
}

// 元数据
const meta = reactive<Record<string, any>>({})
schema.meta.forEach(f => (meta[f.key] = f.key === 'analyte' ? (props.analyte || f.value || '') : (f.value ?? '')))
// 先用仪器型号缺省猜测兜底(原件多数只印编号不印型号)
if (schema.id === 'photometric') {
  meta.instrument = props.method === '原子吸收' ? 'WFX-130B 原子吸收分光光度计'
    : props.method === '原子荧光' ? 'AFS-9700 原子荧光光度计' : 'UV-1801 紫外可见分光光度计'
}
// 再用每张表从原件抽出的真实页脚数据覆盖(方法依据/仪器编号/波长/狭缝/检出限/测量方法)
if (props.tplMeta) {
  for (const k in props.tplMeta) { if (props.tplMeta[k]) meta[k] = props.tplMeta[k] }
}
meta.date = meta.date || todayLocal()   // 本地日：凌晨录数据不能默认成昨天
// 签名栏：直接读写 meta.signer——默认值真正写进 meta（预览模式在 setup、持久化模式在加载完成后），
// 不做「显示时兜底当前登录人」：那样签名从不落盘，谁打开显示谁，原始记录签名不可信
const signer = computed({
  get: () => meta.signer ?? '',
  set: (v: string) => { meta.signer = v },
})
meta.analyte = meta.analyte || props.analyte || ''   // layout 表 schema.meta 为空，兜底填测量项目
// 预览模式（模板库）没有加载环节，签名默认值此刻就写；持久化模式等加载完再写（见 finishLoad）
if (!props.sampleId && !props.roundId && !meta.signer) meta.signer = (currentUser as any)?.value?.name || ''
const cells = reactive<Record<string, any>>({})

// —— 多组分（如苯系物一张表 8 个组分，各存一套曲线，隔离在开关后，不影响单组分表）——
const normalizedComps = normalizeComponents((meta as any).components)
if (normalizedComps.error) ElMessage.warning(`${props.code}：${normalizedComps.error}，该表按单曲线渲染`)
const componentsList: string[] = normalizedComps.list
const isMulti = componentsList.length > 0 && !schema.layout
const activeComp = ref(componentsList[0] || '')
const compRows = reactive<Record<string, Record<string, any>[]>>({})
if (isMulti) for (const c of componentsList) compRows[c] = isDemo ? schema.seed() : blankRowsFrom(schema.seed())
// 当前生效的行：多组分时取活动组分那套，否则用共用 rows
const activeRows = computed<Record<string, any>[]>(() => (isMulti ? compRows[activeComp.value] : rows))
// 曲线核查按组分分键存，避免组分间串数据
const ccKey = (k: string) => (isMulti ? `cc_${activeComp.value}_${k}` : `cc_${k}`)

// 演示模式给示例系数；真实录入必须自己填（0.002/0.045 是演示值——拿它算样品浓度=出假数据）
const manualReg = reactive<{ a: number | undefined; b: number | undefined }>(
  isDemo ? { a: 0.002, b: 0.045 } : { a: undefined, b: undefined })
const manualRegValid = computed(() => typeof manualReg.a === 'number' && isFinite(manualReg.a) && typeof manualReg.b === 'number' && isFinite(manualReg.b))
const fitted = computed(() => (schema.fit ? schema.fit(activeRows.value, { reg: { a: 0, b: 0 }, meta }) : null))
const effReg = computed<{ a: number; b: number; r: number | null } | null>(() =>
  fitted.value ?? (manualRegValid.value ? { a: manualReg.a as number, b: manualReg.b as number, r: null } : null))
// 相关系数合格判据（来自 meta.corrThreshold，如 "≥0.995"）；有拟合 r 时给出合格/不合格
const corrThreshold = computed<string | null>(() => (meta as any).corrThreshold || null)
const corrPass = computed<boolean | null>(() => {
  const t = corrThreshold.value
  const r = fitted.value?.r
  if (!t || r == null) return null
  const m = t.match(/([\d.]+)/)
  return m ? r >= parseFloat(m[1]) : null
})
// 曲线核查（新标准质控）：中间点相对误差 = (实测−标准)/标准×100%，|RE|≤10% 合格
const midRE = computed<number | null>(() => {
  const s = parseFloat(cells[ccKey('midStd')]), m = parseFloat(cells[ccKey('midMeasured')])
  if (!isFinite(s) || !isFinite(m) || s === 0) return null
  return Math.round(((m - s) / s) * 1000) / 10
})
const midPass = computed<boolean | null>(() => (midRE.value == null ? null : Math.abs(midRE.value) <= 10))
function autoVals(row: Record<string, any>): Record<string, any> {
  if (!schema.compute) return {}
  // 需要回归的表没有有效系数（既没拟合也没手填）→ 不算，空着；绝不用演示系数编一个"看着合理"的浓度
  if (schema.regression && !effReg.value) return {}
  return schema.compute(row, { reg: effReg.value ?? { a: 0, b: 0 }, meta })
}
// 国标/方法定死的常量 —— 一律只读参考值，禁止编辑（改了会算错），系统内所有分析表统一生效
const READONLY_META = new Set(['methodFull', 'basis', 'detectionLimit', 'wavelength', 'slit', 'vdef'])
const WIDE_META = new Set(['detectionLimit'])
function metaFixed(f: { key: string; fixed?: boolean }) { return f.fixed || READONLY_META.has(f.key) }
function metaWide(f: { key: string; wide?: boolean }) { return f.wide || WIDE_META.has(f.key) }

// ——— 持久化模式：连后端存/取 ———
const recordId = ref<string | null>(null)
const saving = ref(false)
const recStatus = ref<string>('draft')
const recReject = ref<string>('')
const persistedAudit = ref<Audit[]>([])
const loaded = ref(false)
const instruments = ref<{ id: string; name: string; model: string; cert_until?: string | null }[]>([])
// 标物/试剂批号认领（量值溯源）：存 meta.refMaterials=[台账编号]；过期批号保存时后端警告
const refOpts = ref<{ id: string; name: string; kind: string }[]>([])
const refSel = computed<string[]>({
  get: () => (Array.isArray(meta.refMaterials) ? meta.refMaterials : []),
  set: v => { meta.refMaterials = v; markDirty(dirtyKey) },
})
async function loadRefOpts() {
  try {
    const [rms, rgs] = await Promise.all([api.listRefMaterials(), api.listReagents()])
    refOpts.value = [
      ...rms.map((r: any) => ({ id: r.id, name: r.name, kind: '标物' })),
      ...rgs.map((r: any) => ({ id: r.id, name: r.name, kind: '试剂' })),
    ]
  } catch { refOpts.value = [] }
}
const instrumentId = ref<string>('')
// 决策10：检定过期只警告不拦——但要让检测员看得见
const instWarn = computed(() => {
  const i = instruments.value.find(x => x.id === instrumentId.value)
  if (!i?.cert_until) return ''
  return i.cert_until < todayLocal() ? `⚠ 该仪器检定已于 ${i.cert_until} 过期，出的数据评审有风险` : ''
})

const recStatusLabel: Record<string, string> = { draft: '草稿', submitted: '待复核', reviewed: '待审核', approved: '已通过', rejected: '已打回' }
// 锁死 = 已提交进审核链 或 调用方判定当前岗位无填写权（后端同样会拦，这里只是别让人白填一场）
const locked = computed(() => !!props.readonly || ['submitted', 'reviewed', 'approved'].includes(recStatus.value))

// 模板组分改名后，老记录里旧组分名下的数据界面上不显示，但保存时必须原样带回去——不能因为改了个名就把人家的曲线丢了
const legacyCompRows: Record<string, any[]> = {}
function applyData(d: any) {
  if (isMulti && d.compRows) {
    for (const c of componentsList) if (Array.isArray(d.compRows[c])) compRows[c] = reactive(d.compRows[c])
    for (const k of Object.keys(d.compRows)) if (!componentsList.includes(k)) legacyCompRows[k] = d.compRows[k]
  } else if (Array.isArray(d.rows)) {
    // 本表改成多组分之前存的老记录只有 rows。多组分下 activeRows 只读 compRows，
    // 不归位的话老数据在界面上凭空消失，一保存就被空种子覆盖。先落到首个组分让分析员看得见、能改。
    if (isMulti) compRows[activeComp.value] = reactive(d.rows)
    else rows.splice(0, rows.length, ...d.rows)
  }
  if (d.meta) Object.assign(meta, d.meta)
  if (d.cells) Object.assign(cells, d.cells)
  if (d.reg && (d.reg.a != null || d.reg.b != null)) { manualReg.a = d.reg.a ?? manualReg.a; manualReg.b = d.reg.b ?? manualReg.b }
}

// 乐观锁基线：打开时的 updated_at；保存成功后跟着最新走
const baseUpdatedAt = ref('')
// 脏检查：本组件实例的登记键（同页可能多张表）
const dirtyKey = `sheet:${props.sampleId || props.roundId || 'preview'}:${props.code}`

onMounted(async () => {
  loadRefOpts()
  if (roundPersist.value) {
    try {
      const s = await api.getRoundSheet(props.roundId!, props.code)
      if (s) { applyData(s.data || {}); roundSavedAt.value = s.updated_at || ''; baseUpdatedAt.value = s.updated_at || '' }
    } catch (e: any) {
      ElMessage.error('读取现场表单失败：' + (e?.message || e))
    } finally { finishLoad() }
    return
  }
  if (!persist.value) { loaded.value = true; return }
  try {
    api.listInstruments().then(list => (instruments.value = list)).catch(() => {})
    const rec = await api.getRecord(props.sampleId!, props.code)
    if (rec) {
      recordId.value = rec.id
      recStatus.value = rec.status
      recReject.value = (rec as any).reject_reason || ''
      instrumentId.value = (rec as any).instrument_id || ''
      applyData(rec.data || {})
      baseUpdatedAt.value = (rec as any).updated_at || ''
      await loadAudit()
    }
  } catch (e: any) {
    ElMessage.error('读取记录失败：' + (e?.message || e))
  } finally { finishLoad() }
})
function finishLoad() {
  // 签名默认值真正写进 meta（会随保存落盘）；已有签名/已锁定的不动
  if (!meta.signer && !locked.value) meta.signer = (currentUser as any)?.value?.name || ''
  loaded.value = true
  // 加载完成后再挂脏检查：加载本身引起的变化不算“没保存”
  watch([rows, meta, cells, compRows, manualReg, instrumentId], () => { if (loaded.value) markDirty(dirtyKey) }, { deep: true })
}
onBeforeUnmount(() => clearDirty(dirtyKey))

// 哪一列是「最终结果」，用于出报告 + 冻结留档
const RESULT_KEY: Record<string, string> = { photometric: 'rho', titration: 'rho', gravimetric: 'rho', ic: 'rho', micro: 'result', generic: 'result' }
function resultSummary() {
  const key = RESULT_KEY[schema.id]
  if (!key) return null
  const col = schema.columns.find(c => c.key === key)
  const vals: number[] = []
  for (const r of activeRows.value) {
    if (String(r.note ?? '').includes('空白')) continue
    const v = col?.kind === 'auto' ? autoVals(r)[key] : r[key]
    if (v != null && v !== '' && !isNaN(+v)) vals.push(+v)
  }
  if (!vals.length) return null
  const value = roundGB(vals.reduce((s, v) => s + v, 0) / vals.length, 4)
  return { analyte: meta.analyte || props.analyte || '', value, unit: col?.unit || '' }
}
// 把自动算的值也烤进每行（冻结留档），供报告与防篡改
function bakedRows() {
  return activeRows.value.map(r => ({ ...r, ...autoVals(r) }))
}
// 多组分：把每个组分那套曲线各自烤存（回归按组分单独拟合）；改名前的旧组分数据原样保留
function bakedCompRows() {
  const out: Record<string, any[]> = { ...legacyCompRows }
  for (const c of componentsList) {
    const rs = compRows[c] || []
    const reg = schema.fit ? schema.fit(rs, { reg: { a: 0, b: 0 }, meta }) : null
    out[c] = rs.map(r => ({ ...r, ...(schema.compute ? schema.compute(r, { reg: reg ?? { a: 0, b: 0 }, meta }) : {}) }))
  }
  return out
}

async function loadAudit() {
  if (!recordId.value) return
  try { persistedAudit.value = await api.getAudit(recordId.value) } catch { /* 忽略 */ }
}

// 期次模式：最后保存时间（现场表单没有三级审核链，只显示存过没有）
const roundSavedAt = ref('')
async function saveRound() {
  if (!roundPersist.value) return
  saving.value = true
  try {
    const data: Record<string, any> = { rows: bakedRows(), meta: { ...meta }, cells: { ...cells } }
    if (isMulti) data.compRows = bakedCompRows()
    const s: any = await api.saveRoundSheet(props.roundId!, props.code, data, baseUpdatedAt.value)
    roundSavedAt.value = s?.updated_at || ''
    baseUpdatedAt.value = s?.updated_at || ''
    clearDirty(dirtyKey)
    ElMessage.success('现场表单已保存')
  } catch (e: any) {
    ElMessage.error('保存失败：' + (e?.response?.data?.error || e?.message || e))
  } finally { saving.value = false }
}

// 提交后发现录错：本人可撤回（复核开始前）；非本人后端会拦
async function withdraw() {
  if (!recordId.value) return
  const ok = await ElMessageBox.confirm('撤回这次提交？记录回到草稿，可继续修改（留痕）。', '撤回提交', { confirmButtonText: '撤回', cancelButtonText: '取消' }).catch(() => null)
  if (!ok) return
  try {
    const rec = await api.withdrawRecord(recordId.value)
    recStatus.value = rec.status
    baseUpdatedAt.value = (rec as any).updated_at || ''
    ElMessage.success('已撤回，可继续修改')
    await loadAudit()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
}
async function save(submit = false) {
  if (!persist.value) return
  saving.value = true
  try {
    const data: RecordData = { rows: bakedRows(), meta: { ...meta }, cells: { ...cells }, resultSummary: resultSummary(), ...(effReg.value ? { reg: { ...effReg.value } } : {}) }
    if (isMulti) data.compRows = bakedCompRows()
    const rec = await api.saveRecord({
      sampleId: props.sampleId!, code: props.code, name: props.templateName || '',
      sheetType: props.sheetType, method: props.method, analyte: props.analyte, matrix: props.matrix,
      instrumentId: instrumentId.value, data, submit,
      baseUpdatedAt: baseUpdatedAt.value,   // 乐观锁：打开时的基线（没有记录=''，别人抢先建了也会被拦）
    })
    recordId.value = rec.id
    recStatus.value = rec.status
    recReject.value = (rec as any).reject_reason || ''
    baseUpdatedAt.value = (rec as any).updated_at || ''
    clearDirty(dirtyKey)
    await loadAudit()
    ElMessage.success(submit ? '已提交，进入复核' : '已保存')
    // 后端软警告（仪器过期/日期穿帮）：保存成功但要当面提醒，不能无声吞掉
    for (const w of [(rec as any).instrument_warning, (rec as any).date_warning, (rec as any).ref_warning].filter(Boolean)) {
      ElMessage({ type: 'warning', message: w, duration: 8000, showClose: true })
    }
  } catch (e: any) {
    ElMessage.error('保存失败：' + (e?.response?.data?.error || e?.message || e))
  } finally { saving.value = false }
}

function fmtTime(iso: string) { return iso ? iso.slice(0, 19).replace('T', ' ') : '' }

// 日期栏改日历选择（存 YYYY-MM-DD）；老记录存过「2026.7.1 / 7月1日」这类自由文本——
// 不是标准格式就退回文本框原样显示，老数据不丢不崩
function isDateish(v: any) { return v == null || v === '' || /^\d{4}-\d{2}-\d{2}$/.test(String(v)) }

const formulaHtml = computed(() => {
  if (!schema.latex) return ''
  try { return katex.renderToString(schema.latex, { throwOnError: false }) } catch { return schema.latex }
})

const audit = ref<{ who: string; what: string }[]>([])
function logEdit(row: Record<string, any>, label: string) {
  const idv = row.id || row.no || row.point || '(行)'
  // 预览留痕也用真实登录人——不能不管谁登录都显示同一个名字
  audit.value.unshift({ who: (currentUser as any)?.value?.name || '（未登录）', what: `${idv} 改「${label}」` })
}
</script>

<template>
  <div class="ssheet">
    <div v-if="persist" class="savebar">
      <div class="sb-left">
        <span class="sb-sample">样品 <b>{{ sampleId }}</b></span>
        <span class="sb-status" :class="recStatus">{{ recordId ? recStatusLabel[recStatus] : '未录入' }}</span>
        <span class="sb-inst">认领仪器
          <select v-model="instrumentId" :disabled="locked">
            <option value="">未认领</option>
            <option v-for="i in instruments" :key="i.id" :value="i.id">{{ i.id }} {{ i.name }}</option>
          </select>
          <em v-if="instWarn" class="inst-warn">{{ instWarn }}</em>
        </span>
        <span v-if="refOpts.length" class="sb-inst">标物/试剂
          <el-select v-model="refSel" multiple collapse-tags size="small" :disabled="locked" style="min-width:150px" placeholder="批号（可多选）">
            <el-option v-for="o in refOpts" :key="o.id" :value="o.id" :label="`${o.kind} ${o.id} ${o.name}`" />
          </el-select>
        </span>
      </div>
      <div class="sb-right">
        <template v-if="!locked">
          <el-button size="small" :loading="saving" @click="save(false)">保存草稿</el-button>
          <el-button size="small" type="primary" :loading="saving" @click="save(true)">提交复核</el-button>
        </template>
        <span v-else-if="readonly" class="sb-lock"><el-icon><Lock /></el-icon>{{ lockText || '当前岗位没有填写权限，只能查看' }}</span>
        <span v-else class="sb-lock"><el-icon><Lock /></el-icon>已提交，交由复核/审核处理
          <el-button v-if="recStatus === 'submitted'" size="small" text type="primary" @click="withdraw">撤回修改</el-button></span>
      </div>
    </div>
    <div v-if="roundPersist" class="savebar">
      <div class="sb-left">
        <span class="sb-status" :class="roundSavedAt ? 'draft' : ''">{{ roundSavedAt ? '已保存 ' + roundSavedAt.slice(0, 16).replace('T', ' ') : '未保存' }}</span>
      </div>
      <div class="sb-right">
        <el-button v-if="!readonly" size="small" type="primary" :loading="saving" @click="saveRound">保存现场表单</el-button>
        <span v-else class="sb-lock"><el-icon><Lock /></el-icon>{{ lockText || '只有采样员能填这张表' }}</span>
      </div>
    </div>
    <div v-if="persist && recStatus === 'rejected' && recReject" class="reject-banner">
      被打回：{{ recReject }}　—— 请修改后重新提交
    </div>
    <div v-else class="tip">
      <el-icon><MagicStick /></el-icon>
      <span>「系统里能填能算」草案：<b>白底格子都能手填</b>，<span class="g">绿色格子</span>是系统自动算的。版式跟原表一致。</span>
    </div>

    <div class="sheet">
      <div class="shead"><span class="mono">{{ code }}</span><span class="mono">原始记录</span></div>
      <div class="stitle">{{ schema.title(method) }}</div>

      <template v-if="schema.layout">
        <component
          v-for="sec in schema.layout" :key="sec.id"
          :is="secComp(sec.type)" :section="sec" :meta="meta" :cells="cells" :locked="locked"
          :columns="sec.type === 'table' ? sec.columns : undefined"
          :rows="sec.type === 'table' ? rows : undefined"
          :autoVals="sec.type === 'table' ? autoVals : undefined"
          @edit="logEdit" />
      </template>
      <template v-else>
        <div v-if="isMulti" class="comptabs">
          <span class="ctlabel">组分（各存一条曲线）</span>
          <button v-for="c in componentsList" :key="c" class="ctab" :class="{ on: activeComp === c }" @click="activeComp = c">{{ c }}</button>
        </div>
        <RowTable :key="isMulti ? activeComp : 'single'" :columns="schema.columns" :rows="activeRows" :autoVals="autoVals" :locked="locked" @edit="logEdit" />

        <div class="meta">
          <div v-for="f in schema.meta" :key="f.key" :class="{ wide2: metaWide(f) }">
            <b>{{ f.label }}：</b>
            <span v-if="metaFixed(f)" class="fixed">{{ meta[f.key] || '—' }}</span>
            <label v-else class="growwrap" :data-v="meta[f.key] || ''"><textarea v-model="meta[f.key]" rows="1" class="f grow" :disabled="locked"></textarea></label>
          </div>
          <div v-if="schema.latex" class="wide2"><b>计算公式：</b><span class="katex-wrap" v-html="formulaHtml"></span></div>
          <div v-if="schema.regression && fitted"><b>回归方程：</b><span class="reg auto-reg">a={{ fitted.a }}　b={{ fitted.b }}　r={{ fitted.r }}<i class="autotag">自动拟合</i></span><span v-if="corrThreshold" class="corr" :class="{ pass: corrPass === true, fail: corrPass === false }">（应 {{ corrThreshold }}<template v-if="corrPass === true"> · 合格</template><template v-else-if="corrPass === false"> · 不合格，需重绘</template>）</span></div>
          <div v-else-if="schema.regression"><b>回归方程：</b><span class="reg">a=<input v-model.number="manualReg.a" class="f tiny" :disabled="locked" placeholder="必填" /> b=<input v-model.number="manualReg.b" class="f tiny" :disabled="locked" placeholder="必填" /></span><span v-if="!isDemo && !manualRegValid" class="reg-warn">未填回归系数，浓度不计算——请先绘制/录入本次曲线</span></div>
        </div>

        <!-- 曲线核查（新标准质控要求：零点＜检出限、中间点相对误差≤±10%） -->
        <div v-if="schema.curveCheck" class="curvecheck">
          <div class="cchead">曲线核查 <small>（现行标准质控要求，绘制曲线后核查并留痕<template v-if="isMulti">；每个组分各自核查</template>）</small></div>
          <div class="ccgrid">
            <label>核查日期
              <input v-if="isDateish(cells[ccKey('date')])" v-model="cells[ccKey('date')]" type="date" class="f" :disabled="locked" />
              <input v-else v-model="cells[ccKey('date')]" class="f" :disabled="locked" />
            </label>
            <label>零浓度点测定值<input v-model="cells[ccKey('zero')]" class="f" :disabled="locked" /><i class="hint" v-if="meta.detectionLimit">应＜检出限 {{ meta.detectionLimit }}</i></label>
            <label>中间点标准值<input v-model="cells[ccKey('midStd')]" class="f" :disabled="locked" /></label>
            <label>中间点实测值<input v-model="cells[ccKey('midMeasured')]" class="f" :disabled="locked" /></label>
            <label>相对误差<span class="reo" :class="{ pass: midPass === true, fail: midPass === false }">{{ midRE == null ? '—' : midRE + '%' }}<template v-if="midPass === true"> 合格</template><template v-else-if="midPass === false"> 不合格（应≤±10%）</template></span></label>
            <label>核查人<input v-model="cells[ccKey('by')]" class="f" :disabled="locked" /></label>
          </div>
        </div>
      </template>

      <div class="sign">
        <span>日期：<template v-if="isDateish(meta.date)"><input v-model="meta.date" type="date" class="f" :disabled="locked" /></template><template v-else><input v-model="meta.date" class="f" :disabled="locked" /></template></span>
        <span v-for="(role, i) in schema.signRoles" :key="role">
          {{ role }}：<template v-if="i === 0"><b v-if="signer" class="ok"><i class="sdot good"></i></b><input v-model="signer" class="f signer" placeholder="签名" :disabled="locked" /></template><i v-else>待{{ role }}</i>
        </span>
      </div>
    </div>

    <!-- 记录附件：照片/小票，选填；定稿后锁定 -->
    <RecordAttachments v-if="persist && recordId" type="record" :id="recordId" :frozen="recStatus === 'approved'" />

    <!-- 持久化模式：后端真留痕 -->
    <div v-if="persist && persistedAudit.length" class="audit">
      <div class="ahead"><el-icon><Finished /></el-icon> 数据留痕（防篡改·全程记录，符合 2026 合规）</div>
      <div v-for="a in persistedAudit" :key="a.id" class="arow">
        <b>{{ a.who }}</b>
        <span class="atag" :class="a.action">{{ actionLabel[a.action] || a.action }}</span>
        {{ auditText(a) }}
        <span class="mono t">{{ fmtTime(a.at) }}</span>
      </div>
    </div>
    <!-- 预览模式：本地示意留痕 -->
    <div v-else-if="!persist && audit.length" class="audit">
      <div class="ahead"><el-icon><Finished /></el-icon> 数据留痕（示意·连上样品后为真实记录）</div>
      <div v-for="(a, i) in audit" :key="i" class="arow"><b>{{ a.who }}</b> {{ a.what }} <span class="mono t">刚刚</span></div>
    </div>
  </div>
</template>

<style scoped>
.ssheet{padding:18px;overflow:auto;height:100%}
.tip{display:flex;gap:9px;align-items:center;background:var(--accent-soft);color:var(--accent-ink);border:1px dashed var(--accent);border-radius:9px;padding:9px 13px;font-size:12.5px;margin-bottom:16px}
.tip .g{color:var(--good);font-weight:600}
.sheet{border:1.5px solid var(--ink);border-radius:8px;overflow:hidden;font-size:12.5px;max-width:960px}
.shead{display:flex;justify-content:space-between;padding:7px 11px;border-bottom:1px solid var(--ink);color:var(--muted);font-size:11.5px;background:var(--surface-2)}
.stitle{text-align:center;font-size:15px;font-weight:700;padding:9px;border-bottom:1.5px solid var(--ink);letter-spacing:1px}
input.f{width:100%;min-width:56px;height:30px;border:0;background:transparent;text-align:center;font-family:var(--font-mono);font-size:12.5px;color:var(--ink);padding:0 2px}
input.f:hover{background:#fafbff}
input.f:focus{outline:2px solid var(--accent);outline-offset:-2px;background:var(--accent-soft);border-radius:3px}
.meta{display:grid;grid-template-columns:1fr 1fr;gap:2px 24px;padding:11px 13px;border-bottom:1px solid var(--ink);font-size:12px}
.meta div{display:flex;gap:8px;align-items:flex-start;min-height:28px}
.meta .wide2{grid-column:1 / -1}
.meta b{color:var(--muted);font-weight:500;white-space:nowrap;padding-top:5px;flex:none}
.meta .fixed{font-weight:600;color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere;padding-top:4px;line-height:1.6}
.meta input.f{border-bottom:1px solid var(--line-strong);text-align:left;height:26px;border-radius:0;min-width:0}
.meta input.f.grow{flex:1}
/* 纯 CSS 自适应高度：::after 镜像内容撑高，textarea 覆盖其上，长文本必换行、永不截断，不依赖 JS/新特性 */
.meta .growwrap{display:inline-grid;flex:1;min-width:0}
.meta .growwrap::after{content:attr(data-v) ' ';visibility:hidden;white-space:pre-wrap;overflow-wrap:anywhere;grid-area:1/1;font-family:var(--font-mono);font-size:12.5px;line-height:1.6;padding:3px 2px;min-height:20px}
.meta .growwrap>textarea.f.grow{grid-area:1/1;width:100%;border:0;border-bottom:1px solid var(--line-strong);background:transparent;font-family:var(--font-mono);font-size:12.5px;color:var(--ink);text-align:left;line-height:1.6;padding:3px 2px;resize:none;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}
.meta .growwrap>textarea.f.grow:focus{outline:2px solid var(--accent);outline-offset:-2px;background:var(--accent-soft);border-radius:3px}
.meta input.f.tiny{width:66px;text-align:center;border:1px solid var(--line-strong);border-radius:4px;margin:0 3px;height:24px}
.reg{display:flex;align-items:center}
.auto-reg{color:var(--good);font-family:var(--font-mono);font-weight:600}
.autotag{font-style:normal;font-size:10px;background:var(--good-soft);color:var(--good);padding:1px 6px;border-radius:10px;margin-left:8px}
.corr{font-size:12px;color:var(--muted);margin-left:8px}
.corr.pass{color:var(--good)}
.corr.fail{color:#c0341a;font-weight:600}
.reg-warn{font-size:11.5px;color:#c07a1a;margin-left:10px}
.inst-warn{font-style:normal;font-size:11px;color:#c0341a}
input.f:disabled,textarea.f:disabled{opacity:.85;cursor:not-allowed}
.comptabs{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.ctlabel{font-size:12px;color:var(--muted);margin-right:4px}
.ctab{border:1px solid var(--line);background:var(--surface);color:var(--muted);font-size:12px;padding:4px 12px;border-radius:16px;cursor:pointer;font-family:inherit;transition:.15s}
.ctab:hover{border-color:var(--accent)}
.ctab.on{background:var(--accent);color:#fff;border-color:var(--accent);font-weight:600}
.curvecheck{margin-top:10px;border:1px solid var(--line);border-radius:8px;padding:10px 12px;background:var(--surface-2)}
.cchead{font-size:13px;font-weight:600;margin-bottom:8px}
.cchead small{font-weight:400;color:var(--faint);font-size:11px}
.ccgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 14px}
.ccgrid label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--muted)}
.ccgrid .f{border:1px solid var(--line);border-radius:5px;height:28px;padding:0 6px;background:var(--surface);font-family:var(--font-mono)}
.ccgrid .hint{font-style:normal;font-size:10.5px;color:var(--faint)}
.reo{font-family:var(--font-mono);font-weight:600;padding:4px 0}
.reo.pass{color:var(--good)}
.reo.fail{color:#c0341a}
.katex-wrap{font-size:15px;color:var(--ink)}
.sign{display:flex;justify-content:space-between;gap:10px;padding:8px 13px;font-size:12px;color:var(--muted);align-items:center;flex-wrap:wrap}
.sign input.f{width:110px;border-bottom:1px solid var(--line-strong);height:24px}
.sign input.f[type=date]{width:136px;font-family:var(--font-mono)}
.sign .ok{color:var(--good)} .sign i{color:var(--faint)}
.sign .ok .sdot{margin-right:4px;vertical-align:1px;print-color-adjust:exact;-webkit-print-color-adjust:exact}
.savebar{display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:10px 14px;margin-bottom:16px;box-shadow:var(--shadow-sm)}
.sb-left{display:flex;align-items:center;gap:12px;font-size:13px;color:var(--muted)}
.sb-sample b{color:var(--ink);font-family:var(--font-mono)}
.sb-status{font-size:11.5px;font-weight:600;padding:2px 9px;border-radius:20px;background:var(--surface-2);color:var(--muted)}
.sb-status.submitted{background:#eaf1ff;color:#2457d6}
.sb-status.reviewed{background:#f3ecfb;color:#7c4dcf}
.sb-status.approved{background:var(--good-soft);color:var(--good)}
.sb-status.rejected{background:var(--crit-soft,#fdecec);color:var(--crit,#c0392b)}
.sb-inst{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
.sb-inst select{border:1px solid var(--line-strong);border-radius:6px;padding:4px 7px;font-size:12px;font-family:inherit;color:var(--ink);background:var(--surface);max-width:220px}
.sb-lock{font-size:12px;color:var(--muted);display:inline-flex;align-items:center;gap:5px}
.reject-banner{background:var(--crit-soft,#fdecec);color:var(--crit,#c0392b);border:1px solid var(--crit,#e6a5a5);border-radius:8px;padding:9px 13px;font-size:12.5px;margin-bottom:14px;font-weight:500}
.atag{font-size:10.5px;font-weight:600;padding:1px 7px;border-radius:10px;margin:0 6px;background:var(--surface);border:1px solid var(--line);color:var(--muted)}
.atag.create{background:var(--accent-soft);color:var(--accent-ink)}
.atag.update{background:#fdf0e2;color:#c07a1a}
.atag.submit{background:var(--good-soft);color:var(--good)}
.audit{margin-top:16px;border:1px solid var(--line);border-radius:9px;padding:12px 14px;background:var(--surface-2)}
.ahead{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:600;margin-bottom:8px}
.arow{font-size:12.5px;color:var(--muted);padding:4px 0;border-bottom:1px dashed var(--line)}
.arow .t{color:var(--faint);margin-left:6px}
</style>
