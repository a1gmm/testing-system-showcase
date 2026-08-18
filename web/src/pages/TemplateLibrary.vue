<script setup lang="ts">
import { computed, ref } from 'vue'
import templates from '../data/templates.json'
import StructuredSheet from '../components/StructuredSheet.vue'
import { resolveStandard, lookupStandard, type StandardStatus } from '../data/standardLink'
import optimizedList from '../data/optimizedCodes.json'
import { templatePhase, PHASE_ORDER, type Phase } from '../data/phase'

const view = ref<'original' | 'system' | 'standard' | 'revised'>('original')
// 已做"标准驱动优化"的表（有修订说明+修订版原表页面的）：自动读列表，有文档的自动开入口
const optimizedCodes = new Set(optimizedList as string[])

type Tpl = { code: string; name: string; analyte: string; matrix: string; method: string; sheetType: string; raw: string; file: string; meta?: Record<string, any>; retired?: boolean; retiredReason?: string }
const all = templates as Tpl[]

const keyword = ref('')
const phase = ref<'全部' | Phase>('全部')
const sheetType = ref('全部')
const matrix = ref('全部')
const method = ref('全部')
const stdFilter = ref('全部')
const selected = ref<Tpl | null>(null)

// ---- 标准状态 ----
type Dot = 'good' | 'warn' | 'crit' | 'accent' | ''
type Badge = { kind: string; dot: Dot; label: string }
function statusOf(t: Tpl): StandardStatus {
  return resolveStandard((t.meta || {}).basis)
}
// 停用的表不再参与标准状态判定：本所已不开展该项目，标准现行与否与它无关
function kindOf(t: Tpl): string {
  return t.retired ? 'retired' : statusOf(t).kind
}
function badgeOf(t: Tpl): Badge {
  if (t.retired) return { kind: 'retired', dot: '', label: '已停用' }
  const s = statusOf(t)
  switch (s.kind) {
    case 'ok': return { kind: 'ok', dot: 'good', label: '已入库' }
    case 'outdated': return { kind: 'outdated', dot: 'crit', label: `旧版·应换 ${s.info.currentCode || ''}` }
    case 'missing': return { kind: 'missing', dot: 'warn', label: '未入库' }
    case 'gb': return { kind: 'gb', dot: 'accent', label: 'GB需人工' }
    default: return { kind: 'none', dot: '', label: '无依据' }
  }
}
// 标准栏要展示的 PDF：优先用表所引标准；若引的是旧版且未下，退回现行版并提示
function stdPane(t: Tpl): { pdf: string | null; info: any; usedOutdated: boolean } {
  const s = statusOf(t)
  if (s.kind === 'none') return { pdf: null, info: null, usedOutdated: false }
  if (s.info.crawled && s.info.pdf) return { pdf: s.info.pdf, info: s.info, usedOutdated: false }
  if (s.kind === 'outdated' && s.info.currentCode) {
    const cur = lookupStandard(s.info.currentCode)
    if (cur && cur.crawled && cur.pdf) return { pdf: cur.pdf, info: cur, usedOutdated: true }
  }
  return { pdf: null, info: s.info, usedOutdated: false }
}
const selStatus = computed(() => selected.value ? statusOf(selected.value) : null)
const selBadge = computed(() => selected.value ? badgeOf(selected.value) : null)
const selPane = computed(() => selected.value ? stdPane(selected.value) : null)

function counts(field: keyof Tpl, base: Tpl[]) {
  const m: Record<string, number> = {}
  for (const t of base) { const v = (t[field] as string) || '（未标注）'; m[v] = (m[v] || 0) + 1 }
  return Object.entries(m).sort((a, b) => b[1] - a[1])
}
// 作业环节：现场 / 交接 / 实验室（跟 sheetType 是两根轴，见 data/phase.ts）
function phaseOf(t: Tpl): Phase { return templatePhase(t) }
const phases = computed(() => {
  const m: Record<string, number> = { 现场: 0, 交接: 0, 实验室: 0 }
  for (const t of all) m[phaseOf(t)]++
  return [['全部', all.length], ...PHASE_ORDER.map(p => [p, m[p]])] as [string, number][]
})
const phaseDot: Record<Phase, Dot> = { 现场: 'accent', 交接: 'warn', 实验室: 'good' }

const typeOrder = ['原始记录', '校准曲线', '采样记录', '样品交接', '前处理']
const sheetTypes = computed(() => {
  const c = Object.fromEntries(counts('sheetType', all))
  return [['全部', all.length], ...typeOrder.filter(t => c[t]).map(t => [t, c[t]])] as [string, number][]
})
const matrices = computed(() => [['全部', all.length] as [string, number], ...counts('matrix', all).filter(([k]) => k !== '（未标注）')])
const methods = computed(() => [['全部', all.length] as [string, number], ...counts('method', all).filter(([k]) => k !== '（未标注）')])

// ---- 标准覆盖统计 ----
const stdBuckets: { key: string; dot: Dot; label: string }[] = [
  { key: 'ok', dot: 'good', label: '已入库' },
  { key: 'outdated', dot: 'crit', label: '旧版' },
  { key: 'missing', dot: 'warn', label: '未入库' },
  { key: 'gb', dot: 'accent', label: 'GB需人工' },
  { key: 'none', dot: '', label: '无依据' },
  { key: 'retired', dot: '', label: '已停用' },
]
const stdCounts = computed(() => {
  const m: Record<string, number> = { ok: 0, outdated: 0, missing: 0, gb: 0, none: 0, retired: 0 }
  for (const t of all) m[kindOf(t)]++
  return m
})

const filtered = computed(() =>
  all.filter(t => {
    if (phase.value !== '全部' && phaseOf(t) !== phase.value) return false
    if (sheetType.value !== '全部' && t.sheetType !== sheetType.value) return false
    if (matrix.value !== '全部' && t.matrix !== matrix.value) return false
    if (method.value !== '全部' && t.method !== method.value) return false
    if (stdFilter.value !== '全部' && kindOf(t) !== stdFilter.value) return false
    if (keyword.value) {
      const k = keyword.value.toLowerCase()
      if (!(t.name + t.code + t.raw + t.analyte).toLowerCase().includes(k)) return false
    }
    return true
  })
)
function reset() { phase.value = '全部'; sheetType.value = '全部'; matrix.value = '全部'; method.value = '全部'; keyword.value = ''; stdFilter.value = '全部' }
</script>

<template>
  <div class="pagewrap wide lib">
    <div class="phead">
      <div>
        <h1 class="page">模板库</h1>
        <p class="sub">{{ all.length }} 张检测记录表 1:1 入库 · 原文件 / 系统还原 / 依据标准三向对照</p>
      </div>
      <span class="hcount num">{{ filtered.length }} / {{ all.length }} 张</span>
    </div>

    <!-- 标准覆盖：中性胶囊 + 状态点，可点筛选 -->
    <div class="sechead">
      <h2>标准覆盖</h2>
      <span class="hint">点选可筛选</span>
    </div>
    <div class="card cvbar">
      <button v-for="b in stdBuckets" :key="b.key" class="pill cv" :class="{ on: stdFilter === b.key }"
        @click="stdFilter = stdFilter === b.key ? '全部' : b.key">
        <span class="sdot" :class="b.dot"></span>{{ b.label }}<i class="num">{{ stdCounts[b.key] }}</i>
      </button>
    </div>

    <!-- 筛选 -->
    <div class="card filters">
      <div class="frow">
        <el-input v-model="keyword" placeholder="搜检测项目 / 表号 / 关键词…" clearable class="search">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <div class="seg">
          <button v-for="[t, n] in sheetTypes" :key="t" :class="{ on: sheetType === t }" @click="sheetType = t">
            {{ t }}<i class="num">{{ n }}</i>
          </button>
        </div>
        <el-button text @click="reset">重置</el-button>
      </div>
      <div class="frow chips">
        <span class="flabel">作业环节</span>
        <span v-for="[p, n] in phases" :key="p" class="chip" :class="{ on: phase === p }" @click="phase = p as any">
          <span v-if="p !== '全部'" class="sdot" :class="phaseDot[p as Phase]"></span>{{ p }}<i class="num">{{ n }}</i>
        </span>
      </div>
      <div class="frow chips">
        <span class="flabel">样品类型</span>
        <span v-for="[m, n] in matrices" :key="m" class="chip" :class="{ on: matrix === m }" @click="matrix = m">{{ m }}<i class="num">{{ n }}</i></span>
      </div>
      <div class="frow chips">
        <span class="flabel">检测方法</span>
        <span v-for="[m, n] in methods" :key="m" class="chip" :class="{ on: method === m }" @click="method = m">{{ m }}<i class="num">{{ n }}</i></span>
      </div>
    </div>

    <!-- 列表 + 预览 -->
    <div class="body">
      <div class="card list">
        <div v-for="t in filtered" :key="t.file" class="item" :class="{ on: selected?.file === t.file, retired: t.retired }" @click="selected = t">
          <div class="rawname">{{ t.raw }}</div>
          <div class="isub">
            <span class="ptag" :class="'p-' + phaseOf(t)">{{ phaseOf(t) }}</span>
            <span class="stype">{{ t.sheetType }}</span>
            <span v-if="t.matrix" class="idim"> · {{ t.matrix }}</span>
            <span v-if="t.method" class="idim"> · {{ t.method }}</span>
            <span class="sdot" :class="badgeOf(t).dot" :title="badgeOf(t).label"></span>
            <span class="code mono">{{ t.code }}</span>
          </div>
        </div>
        <div v-if="!filtered.length" class="empty">没有匹配的表格</div>
      </div>

      <div class="card preview">
        <div v-if="selected" class="viewer">
          <div class="vhead">
            <div style="min-width:0">
              <div class="vname">{{ selected.raw }}</div>
              <div class="vsub">
                <span class="mono">{{ selected.code }}</span> · {{ selected.sheetType }}<span v-if="selected.method"> · {{ selected.method }}</span>
                <span v-if="selBadge" class="pill vbadge">
                  <span class="sdot" :class="selBadge.dot"></span>
                  {{ (selected.meta || {}).basis || '无依据' }}<template v-if="selBadge.kind==='outdated'"> → {{ selStatus?.kind==='outdated' ? selStatus.info.currentCode : '' }}</template> · {{ selBadge.label }}
                </span>
              </div>
            </div>
            <div class="vtoggle">
              <button :class="{ on: view === 'standard' }" @click="view = 'standard'">国家标准</button>
              <button :class="{ on: view === 'original' }" @click="view = 'original'">原文件</button>
              <button :class="{ on: view === 'system' }" @click="view = 'system'">系统样子</button>
              <button v-if="optimizedCodes.has(selected.code)" :class="{ on: view === 'revised' }" @click="view = 'revised'">
                <el-icon><Edit /></el-icon>修订版
              </button>
            </div>
          </div>

          <div v-if="selected.retired" class="note">
            <b>本表已停用</b>——{{ selected.retiredReason }}。保留在库内仅供历史记录追溯，请勿用于新的检测记录。
          </div>

          <!-- 国家标准 -->
          <template v-if="view === 'standard'">
            <div v-if="selPane && selPane.usedOutdated" class="note warn">
              原表标注的是旧版；下方展示的是<b>现行版</b>标准全文，供对照。
            </div>
            <iframe v-if="selPane && selPane.pdf" class="frame" :src="`/standards/${selPane.pdf}`" title="国家标准"></iframe>
            <div v-else class="gap">
              <el-icon class="gapicon"><Document /></el-icon>
              <div class="gaptitle">此标准尚未入库</div>
              <div class="gapbody">
                <div v-if="(selected.meta || {}).basis">依据标准：<b>{{ (selected.meta || {}).basis }}</b></div>
                <div v-else>该表暂未标注方法依据。</div>
                <div v-if="selStatus?.kind==='gb'" class="gapline"><span class="sdot accent"></span>GB 国标官网只读不可下载，需人工获取正版。</div>
                <div v-else-if="selStatus?.kind==='missing'" class="gapline"><span class="sdot warn"></span>HJ 标准，官网可下载，尚未爬取入库。</div>
                <a v-if="selStatus && selStatus.kind!=='none' && selStatus.info.detail" :href="selStatus.info.detail" target="_blank" class="gaplink">查看官网 →</a>
              </div>
            </div>
          </template>

          <iframe v-if="view === 'revised'" class="frame revframe" :src="`/优化/${selected.code}.html`" title="修订版"></iframe>
          <iframe v-show="view === 'original'" class="frame" :src="`/sheets/${selected.file}?v=3`" title="记录表预览"></iframe>
          <StructuredSheet v-if="view === 'system'" :key="selected.file" :analyte="selected.analyte" :method="selected.method" :matrix="selected.matrix" :code="selected.code" :sheet-type="selected.sheetType" :tpl-meta="selected.meta" />
        </div>
        <div v-else class="empty tall">左侧选一张表查看还原效果</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lib{display:flex;flex-direction:column;height:calc(100vh - 58px - 44px)}

.phead{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px}
.page{font-size:22px;font-weight:650;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--muted);margin:0;font-size:13px}
.hcount{color:var(--faint);font-size:12.5px;padding-top:9px}
.hint{font-size:12px;color:var(--faint)}

/* 标准覆盖：胶囊一律中性底，语义只由状态点承担 */
.cvbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px;margin-bottom:12px}
.cv{border:1px solid var(--line);cursor:pointer;font-family:inherit;padding:4px 11px;transition:background .13s ease,border-color .13s ease}
.cv:hover{border-color:var(--line-strong)}
.cv.on{background:var(--accent-soft);border-color:var(--accent);color:var(--accent-ink)}
.cv i{font-style:normal;font-weight:500;color:var(--faint);margin-left:2px}
.cv.on i{color:var(--accent-ink)}

/* 筛选：搜索 + 表类型为主，样品/方法为次 */
.filters{padding:12px 16px;margin-bottom:12px}
.frow{display:flex;align-items:center;gap:10px}
.frow + .frow{margin-top:8px}
.search{max-width:280px}
.chips{flex-wrap:wrap}
.flabel{font-size:12px;color:var(--faint);width:56px;flex:none}

/* 表类型：分段控件（主筛选） */
.seg{display:inline-flex;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);padding:3px;flex-wrap:wrap}
.seg button{border:0;background:transparent;padding:5px 12px;border-radius:6px;font-size:12.5px;font-weight:600;color:var(--muted);cursor:pointer;font-family:inherit;transition:background .13s ease,color .13s ease}
.seg button:hover{color:var(--ink)}
.seg button.on{background:var(--surface);color:var(--ink);box-shadow:var(--shadow-sm)}
.seg button i{font-style:normal;font-weight:500;color:var(--faint);margin-left:4px}

/* 样品/方法：纯文字次级筛选 */
.chip{font-size:12px;padding:2px 8px;border-radius:6px;color:var(--muted);cursor:pointer;transition:background .13s ease,color .13s ease}
.chip:hover{background:var(--surface-2);color:var(--ink)}
.chip.on{background:var(--accent-soft);color:var(--accent-ink);font-weight:600}
.chip i{font-style:normal;color:var(--faint);margin-left:3px}
.chip.on i{color:var(--accent-ink)}

.body{flex:1;display:grid;grid-template-columns:320px 1fr;gap:12px;min-height:0}

/* 左列表：行式，1px 分隔，hover 只变底色 */
.list{overflow-y:auto}
.item{padding:11px 14px;cursor:pointer;border-bottom:1px solid var(--line);transition:background .12s ease}
.item:last-of-type{border-bottom:0}
.item:hover{background:var(--surface-2)}
.item.on{background:var(--accent-soft);box-shadow:inset 2px 0 0 var(--accent)}
.rawname{font-size:13px;font-weight:600;color:var(--ink);line-height:1.4}
.isub{display:flex;align-items:center;gap:0;margin-top:5px;font-size:12px;color:var(--faint)}
.stype{color:var(--muted);font-weight:600}
.ptag{flex:none;margin-right:6px;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600;line-height:1.5;border:1px solid transparent}
.ptag.p-现场{color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);border-color:color-mix(in srgb,var(--accent) 30%,transparent)}
.ptag.p-交接{color:var(--warn);background:color-mix(in srgb,var(--warn) 12%,transparent);border-color:color-mix(in srgb,var(--warn) 30%,transparent)}
.ptag.p-实验室{color:var(--muted);background:var(--surface-2,rgba(127,127,127,.1));border-color:color-mix(in srgb,var(--muted) 22%,transparent)}
.idim{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-left:5px}
.isub .sdot{margin-left:auto}
.isub .code{color:var(--faint);margin-left:7px;flex:none}
.item.retired{opacity:.55}
.item.retired .rawname{text-decoration:line-through;color:var(--muted)}

/* 右预览 */
.preview{overflow:hidden}
.viewer{height:100%;display:flex;flex-direction:column}
.vhead{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 18px;border-bottom:1px solid var(--line)}
.vhead>div:first-child{min-width:0}
.vname{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vsub{font-size:12px;color:var(--faint);margin-top:3px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.vbadge{font-weight:500}
.vtoggle{display:inline-flex;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);padding:3px;flex:none}
.vtoggle button{display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;padding:6px 13px;border-radius:6px;font-size:13px;font-weight:600;color:var(--muted);cursor:pointer;font-family:inherit;transition:background .13s ease,color .13s ease}
.vtoggle button:hover{color:var(--ink)}
.vtoggle button.on{background:var(--accent);color:#fff}
.frame{flex:1;width:100%;border:0;background:#fff}
.revframe{overflow:auto}

/* 提示条：左侧色条，无图标 */
.note{margin:10px 18px;padding:8px 12px;border-radius:var(--radius-sm);background:var(--surface-2);color:var(--muted);font-size:12px;line-height:1.7;border-left:3px solid var(--line-strong)}
.note b{color:var(--ink)}
.note.warn{background:var(--warn-soft);color:var(--warn);border-left-color:var(--warn)}
.note.warn b{color:var(--warn)}

/* 标准缺口 */
.gap{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;padding:30px;color:var(--muted)}
.gapicon{font-size:26px;color:var(--faint)}
.gaptitle{font-size:15px;font-weight:600;color:var(--ink)}
.gapbody{font-size:13px;line-height:1.9}
.gapline{display:inline-flex;align-items:center;gap:6px;color:var(--muted)}
.gaplink{display:inline-block;margin-top:8px;color:var(--accent);font-weight:600}

.empty{padding:22px;text-align:center;color:var(--faint);font-size:13px}
.empty.tall{height:100%;display:flex;align-items:center;justify-content:center}

@media (max-width:760px){
  .body{grid-template-columns:1fr}
  .list{max-height:40vh}
}
@media (max-width:1100px){
  .body{grid-template-columns:280px 1fr}
  .hcount{display:none}
}
</style>
