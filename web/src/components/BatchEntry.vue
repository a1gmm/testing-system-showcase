<script setup lang="ts">
// PRD 步骤6 跨合同同表：检测员挑一张表，把名下所有该测这个项目的样品（可跨合同）放进同一张表逐行录，
// 保存时系统按样品编号逐个落成各自的记录、自动归到所属合同。
import { ref, computed, reactive } from 'vue'
import { ElMessage } from 'element-plus'
import templatesJson from '../data/templates.json'
import { templatePhase } from '../data/phase'
import { resolveSchema } from '../data/schemas'
import { api, currentUser, hasRole, type Sample, type TestTask } from '../api'
import { todayLocal } from '../utils/date'
import { markDirty, clearDirty } from '../utils/dirty'

type Tpl = { code: string; name: string; analyte: string; matrix: string; method: string; sheetType: string; raw: string; file: string }
const LAB_TPLS = (templatesJson as Tpl[]).filter(t => (t.sheetType === '原始记录') && templatePhase(t) === '实验室')

// 真盲视角同 Samples.vue 口径：盲用户拿到的 contract_id 已被后端脱敏，别把有委托的样标成"散样"
const isBlindView = computed(() => hasRole('tester') && !hasRole('admin', 'tech', 'qc', 'registrar', 'sampler', 'signer'))
const emit = defineEmits<{ saved: [] }>()
const props = defineProps<{ samples: Sample[]; myTasks: TestTask[] }>()

const tplKeyword = ref('')
const tpl = ref<Tpl | null>(null)
const candidates = computed(() => {
  const k = tplKeyword.value.toLowerCase()
  return LAB_TPLS.filter(t => !k || (t.raw + t.analyte + t.code + t.method).toLowerCase().includes(k)).slice(0, 40)
})

const schema = computed(() => (tpl.value ? resolveSchema(tpl.value.sheetType, tpl.value.method, tpl.value.code, undefined) : null))
// 输入列（id/input），auto 列现算
const cols = computed(() => schema.value?.columns ?? [])

// 候选样品：tech 看全部待检样品；检测员只看质控派给自己的项目匹配这张表的
function analyteHits(items: string[], analyte: string) {
  const a = analyte.toLowerCase()
  return items.some(it => { const s = it.toLowerCase(); return a && (a.includes(s) || s.includes(a)) })
}
const pickable = computed<Sample[]>(() => {
  if (!tpl.value) return []
  const t = tpl.value
  const base = props.samples.filter(s => s.status !== 'done' && s.matrix === t.matrix && (!s.items.length || analyteHits(s.items, t.analyte)))
  if (hasRole('tech')) return base
  const mine = new Set(props.myTasks.filter(k => analyteHits([k.analyte], t.analyte)).map(k => k.sample_id))
  return base.filter(s => mine.has(s.id))
})

const chosen = reactive<Record<string, boolean>>({})
const rows = reactive<Record<string, Record<string, any>>>({})
function toggle(s: Sample) {
  chosen[s.id] = !chosen[s.id]
  if (chosen[s.id] && !rows[s.id]) { const blank: Record<string, any> = {}; cols.value.forEach(c => (blank[c.key] = '')); blank.id = s.id; rows[s.id] = blank }
  markDirty('batch-entry')
}
const chosenIds = computed(() => Object.keys(chosen).filter(id => chosen[id]))

// 共用回归系数（同一批同一条曲线）；不填不算浓度
const reg = reactive<{ a: number | undefined; b: number | undefined }>({ a: undefined, b: undefined })
const regValid = computed(() => typeof reg.a === 'number' && isFinite(reg.a) && typeof reg.b === 'number' && isFinite(reg.b))
const sharedMeta = reactive<Record<string, any>>({ date: todayLocal(), signer: currentUser.value?.name || '' })

function autoVals(row: Record<string, any>): Record<string, any> {
  const s = schema.value
  if (!s?.compute) return {}
  if (s.regression && !regValid.value) return {}
  return s.compute(row, { reg: { a: (regValid.value ? reg.a : 0) as number, b: (regValid.value ? reg.b : 0) as number }, meta: sharedMeta })
}
const RESULT_KEY: Record<string, string> = { photometric: 'rho', titration: 'rho', gravimetric: 'rho', ic: 'rho', micro: 'result', generic: 'result' }
function resultOf(row: Record<string, any>) {
  const s = schema.value!
  const key = RESULT_KEY[s.id]
  if (!key) return null
  const col = s.columns.find(c => c.key === key)
  const v = col?.kind === 'auto' ? autoVals(row)[key] : row[key]
  if (v == null || v === '' || isNaN(+v)) return null
  return { analyte: tpl.value!.analyte, value: +v, unit: col?.unit || '' }
}

const saving = ref(false)
async function saveAll(submit = false) {
  if (!tpl.value || !chosenIds.value.length) return ElMessage.warning('先勾选要录的样品')
  saving.value = true
  try {
    const entries = chosenIds.value.map(id => ({ sampleId: id, row: { ...rows[id], ...autoVals(rows[id]) }, resultSummary: resultOf(rows[id]) }))
    const recs = await api.saveRecordsBatch({
      code: tpl.value.code, name: tpl.value.raw, sheetType: tpl.value.sheetType,
      method: tpl.value.method, analyte: tpl.value.analyte, matrix: tpl.value.matrix,
      sharedMeta: { ...sharedMeta }, ...(regValid.value ? { reg: { a: reg.a, b: reg.b } } : {}),
      entries, submit,
    })
    clearDirty('batch-entry')
    ElMessage.success(`已${submit ? '提交' : '保存'} ${recs.length} 个样品的记录（按编号自动归各自委托）`)
    emit('saved')
  } catch (e: any) {
    ElMessage.error('批量保存失败（整批未落库）：' + (e?.response?.data?.error || e?.message || e))
  } finally { saving.value = false }
}
</script>

<template>
  <div class="batch">
    <div v-if="!tpl" class="picker">
      <p class="hint">跨合同同表：选一张记录表，把名下所有要测这个项目的样品放进同一张表里录，保存后按样品编号自动归各自委托。</p>
      <input v-model="tplKeyword" class="search" placeholder="搜检测项目 / 表号 / 方法…" />
      <div class="tlist">
        <div v-for="t in candidates" :key="t.file" class="titem" @click="tpl = t">
          <b>{{ t.raw }}</b>
          <span class="mono">{{ t.code }} · {{ t.matrix }} · {{ t.analyte }}</span>
        </div>
      </div>
    </div>

    <template v-else>
      <div class="bar">
        <span class="back" @click="tpl = null">← 换一张表</span>
        <b>{{ tpl.raw }}</b>
        <span class="mono sub">{{ tpl.code }} · {{ tpl.analyte }}</span>
      </div>

      <div class="pick-samples">
        <b>本批样品（{{ chosenIds.length }}/{{ pickable.length }}）</b>
        <span v-if="!pickable.length" class="hint">没有可录的样品——{{ hasRole('tech') ? '没有待检的匹配样品' : '质控还没把该项目的任务派给你' }}</span>
        <label v-for="s in pickable" :key="s.id" class="cs" :class="{ on: chosen[s.id] }">
          <input type="checkbox" :checked="!!chosen[s.id]" @change="toggle(s)" />
          <span class="mono">{{ s.id }}</span><i>{{ s.client }}<template v-if="s.contract_id"> · {{ s.contract_id }}</template></i>
        </label>
      </div>

      <div v-if="schema?.regression" class="regbar">
        回归方程 a=<input v-model.number="reg.a" placeholder="必填" /> b=<input v-model.number="reg.b" placeholder="必填" />
        <span v-if="!regValid" class="warn">未填系数不算浓度</span>
      </div>

      <div v-if="chosenIds.length" class="tbl-wrap">
        <table>
          <thead><tr>
            <th class="fixcol">样品编号 / 委托</th>
            <th v-for="c in cols.filter(c => c.key !== 'id')" :key="c.key" :class="{ autoh: c.kind === 'auto' }">{{ c.label }}<small v-if="c.unit"> {{ c.unit }}</small></th>
          </tr></thead>
          <tbody>
            <tr v-for="id in chosenIds" :key="id">
              <td class="fixcol mono">{{ id }}<i>{{ isBlindView ? '盲样' : (props.samples.find(s => s.id === id)?.contract_id || '散样') }}</i></td>
              <template v-for="c in cols.filter(c => c.key !== 'id')" :key="c.key">
                <td v-if="c.kind === 'auto'" class="auto">{{ autoVals(rows[id])[c.key] ?? '' }}</td>
                <td v-else><input v-model="rows[id][c.key]" @input="markDirty('batch-entry')" /></td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="chosenIds.length" class="foot">
        <label>检测日期<input v-model="sharedMeta.date" type="date" /></label>
        <label>检验人<input v-model="sharedMeta.signer" /></label>
        <span style="flex:1"></span>
        <el-button :loading="saving" @click="saveAll(false)">保存草稿（{{ chosenIds.length }} 样品）</el-button>
        <el-button type="primary" :loading="saving" @click="saveAll(true)">全部提交复核</el-button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.batch{display:flex;flex-direction:column;gap:12px}
.hint{font-size:12.5px;color:var(--faint);line-height:1.6}
.search{width:100%;box-sizing:border-box;border:1px solid var(--line-strong);border-radius:7px;padding:8px 10px;font-size:13px;font-family:inherit;background:var(--surface);color:var(--ink)}
.tlist{max-height:320px;overflow-y:auto;border:1px solid var(--line);border-radius:8px}
.titem{display:flex;flex-direction:column;gap:2px;padding:9px 12px;border-bottom:1px solid var(--line);cursor:pointer;font-size:13px}
.titem:hover{background:var(--accent-soft)}
.titem .mono{font-size:11.5px;color:var(--faint)}
.bar{display:flex;align-items:center;gap:10px;font-size:13.5px}
.bar .back{color:var(--accent);cursor:pointer;font-size:12.5px}
.bar .sub{color:var(--faint);font-size:12px}
.pick-samples{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12.5px}
.cs{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:8px;padding:4px 10px;cursor:pointer}
.cs.on{border-color:var(--accent);background:var(--accent-soft)}
.cs i{font-style:normal;color:var(--faint);font-size:11.5px}
.regbar{display:flex;align-items:center;gap:6px;font-size:12.5px}
.regbar input{width:80px;border:1px solid var(--line-strong);border-radius:5px;height:26px;text-align:center;font-family:var(--font-mono)}
.regbar .warn{color:#c07a1a;font-size:11.5px}
.tbl-wrap{overflow-x:auto;border:1.5px solid var(--ink);border-radius:8px}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{border:1px solid var(--line-strong);padding:0;text-align:center}
thead th{background:var(--surface-2);color:var(--muted);font-weight:600;font-size:11.5px;padding:6px}
thead th.autoh{background:var(--good-soft);color:var(--good)}
td{height:32px}
td input{width:100%;min-width:64px;height:30px;border:0;background:transparent;text-align:center;font-family:var(--font-mono);font-size:12.5px;color:var(--ink)}
td input:focus{outline:2px solid var(--accent);outline-offset:-2px;background:var(--accent-soft)}
.auto{background:color-mix(in srgb,var(--good) 12%,transparent);font-family:var(--font-mono);font-weight:700;color:var(--good)}
.fixcol{min-width:150px;padding:2px 8px;text-align:left}
.fixcol i{display:block;font-style:normal;font-size:10.5px;color:var(--faint)}
.foot{display:flex;align-items:center;gap:12px;font-size:12.5px;color:var(--muted)}
.foot label{display:inline-flex;align-items:center;gap:6px}
.foot input{border:1px solid var(--line-strong);border-radius:6px;height:28px;padding:0 8px;font-family:inherit}
</style>
