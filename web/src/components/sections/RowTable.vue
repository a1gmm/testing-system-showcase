<script setup lang="ts">
// 逐行表：从 StructuredSheet.vue 抽出的旧版单一表格逻辑，供旧路径 + layout 的 table 分区复用
import { computed } from 'vue'
import { ElMessageBox } from 'element-plus'
import type { Col } from '../../data/schemas'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  columns: Col[]
  rows: Record<string, any>[]
  autoVals: (row: Record<string, any>) => Record<string, any>
  locked?: boolean
}>()
const emit = defineEmits<{ edit: [row: Record<string, any>, label: string] }>()

// 分组表头
const headRow1 = computed(() => {
  const out: any[] = []; const cols = props.columns
  for (let i = 0; i < cols.length;) {
    const c = cols[i]
    if (c.group) { let j = i; while (j < cols.length && cols[j].group === c.group) j++; out.push({ type: 'group', label: c.group, span: j - i }); i = j }
    else { out.push({ type: 'single', col: c }); i++ }
  }
  return out
})
const groupedCols = computed(() => props.columns.filter(c => c.group))
const hasGroups = computed(() => groupedCols.value.length > 0)

function addRow() {
  if (props.locked) return
  const blank: Record<string, any> = {}
  props.columns.forEach(c => (blank[c.key] = ''))
  props.rows.push(blank)
}
async function delRow(i: number) {
  if (props.locked || props.rows.length <= 1) return
  // 行里有内容时先确认——误点「×」一整行就没了，没有撤销
  const hasContent = Object.values(props.rows[i] || {}).some(v => v !== '' && v != null)
  if (hasContent) {
    const ok = await ElMessageBox.confirm('这一行已填了数据，删除后找不回来。确定删除？', '删除行', { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' }).catch(() => null)
    if (!ok) return
  }
  props.rows.splice(i, 1)
}
</script>

<template>
  <div class="tbl-wrap">
    <table>
      <thead>
        <tr>
          <th v-for="(h, i) in headRow1" :key="i" :colspan="h.type === 'group' ? h.span : 1" :rowspan="h.type === 'single' && hasGroups ? 2 : 1"
              :class="{ autoh: h.type === 'single' && h.col.kind === 'auto' }">
            <template v-if="h.type === 'group'">{{ h.label }}</template>
            <template v-else>{{ h.col.label }}<br v-if="h.col.unit"><small v-if="h.col.unit">{{ h.col.unit }}</small></template>
          </th>
          <th v-if="hasGroups" rowspan="2" class="opcol"></th>
          <th v-else class="opcol"></th>
        </tr>
        <tr v-if="hasGroups">
          <th v-for="c in groupedCols" :key="c.key" :class="{ autoh: c.kind === 'auto' }">
            {{ c.label }}<small v-if="c.unit"> {{ c.unit }}</small>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(r, i) in rows" :key="i">
          <template v-for="c in columns" :key="c.key">
            <td v-if="c.kind === 'auto'" class="auto">{{ autoVals(r)[c.key] ?? '' }}</td>
            <td v-else><input v-model="r[c.key]" class="f" :class="{ wide: c.kind === 'id' || (c.w && c.w >= 100) }" :disabled="locked" @change="emit('edit', r, c.label)" /></td>
          </template>
          <td class="opcol"><span v-if="!locked" class="del" @click="delRow(i)" title="删除此行">×</span></td>
        </tr>
      </tbody>
    </table>
  </div>
  <div v-if="!locked" class="addbar"><span class="addrow" @click="addRow">＋ 添加一行</span></div>
</template>

<style scoped>
.tbl-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th,td{border:1px solid var(--line-strong);padding:0;text-align:center;font-variant-numeric:tabular-nums}
thead th{background:var(--surface-2);color:var(--muted);font-weight:600;font-size:11.5px;padding:5px 6px}
thead th small{font-weight:400;opacity:.8}
thead th.autoh{background:var(--good-soft);color:var(--good)}
td{height:32px}
input.f{width:100%;min-width:56px;height:30px;border:0;background:transparent;text-align:center;font-family:var(--font-mono);font-size:12.5px;color:var(--ink);padding:0 2px}
input.f:hover{background:#fafbff}
input.f:focus{outline:2px solid var(--accent);outline-offset:-2px;background:var(--accent-soft);border-radius:3px}
input.f:disabled{color:var(--ink);opacity:.85;cursor:not-allowed;background:transparent}
input.f.wide{font-family:var(--font-sans);text-align:left;padding-left:8px;min-width:90px}
.auto{background:color-mix(in srgb,var(--good) 12%,transparent);font-family:var(--font-mono);font-weight:700;color:var(--good)}
.opcol{width:26px} th.opcol{border:0;background:var(--surface-2)}
.del{color:var(--faint);cursor:pointer;font-size:15px;padding:4px}
.del:hover{color:var(--crit)}
.addbar{padding:6px 10px;border-top:1px dashed var(--line-strong);border-bottom:1.5px solid var(--ink);background:var(--surface-2)}
.addrow{font-size:12px;color:var(--accent);cursor:pointer}
.addrow:hover{text-decoration:underline}
</style>
