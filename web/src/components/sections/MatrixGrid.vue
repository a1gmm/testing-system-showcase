<script setup lang="ts">
import type { Section } from '../../data/schemas'
import { cellKey } from '../../data/cellStore'
const props = defineProps<{ section: Extract<Section,{type:'matrix'}>; cells: Record<string,any>; locked?: boolean }>()
const K = (r: string, c: string) => cellKey(props.section.id, r, c)
</script>
<template>
  <div class="mtx-wrap">
    <table class="mtx">
      <thead><tr><th></th><th v-for="c in section.colHeaders" :key="c.key">{{ c.label }}</th></tr></thead>
      <tbody>
        <tr v-for="r in section.rowHeaders" :key="r.key">
          <th class="rowh">{{ r.label }}<small v-if="r.unit"> {{ r.unit }}</small></th>
          <td v-for="c in section.colHeaders" :key="c.key" :class="{ auto: r.kind==='auto' }">
            <span v-if="r.kind==='const'" class="cst">{{ r.value }}</span>
            <span v-else-if="r.kind==='auto'" class="av">{{ cells[K(r.key,c.key)] ?? '' }}</span>
            <input v-else v-model="cells[K(r.key,c.key)]" :disabled="locked" class="f" />
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="section.note" class="mnote">{{ section.note }}</div>
  </div>
</template>
<style scoped>
.mtx-wrap{overflow-x:auto;margin-bottom:10px}
.mtx{border-collapse:collapse;width:100%}
.mtx th,.mtx td{border:1px solid var(--line-strong);padding:0;text-align:center;font-size:12px;height:30px}
.mtx thead th{background:var(--surface-2);color:var(--muted);font-weight:600;padding:4px 6px}
.mtx .rowh{background:var(--surface-2);color:var(--muted);font-weight:500;padding:4px 8px;text-align:left;white-space:nowrap}
.mtx td.auto{background:color-mix(in srgb,var(--good) 12%,transparent)}
.mtx .f{width:100%;min-width:56px;height:28px;border:0;background:transparent;text-align:center;font-family:var(--font-mono);font-size:12px}
.mtx .cst{color:var(--muted)} .mtx .av{color:var(--good);font-weight:700;font-family:var(--font-mono)}
.mnote{font-size:11.5px;color:var(--muted);padding:4px 2px}
</style>
