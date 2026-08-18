<script setup lang="ts">
import type { Section } from '../../data/schemas'
const props = defineProps<{ section: Extract<Section,{type:'checks'}>; meta: Record<string,any>; locked?: boolean }>()
function toggle(o: string) {
  if (props.locked) return
  const k = props.section.key
  if (props.section.multi) {
    const set = new Set<string>(Array.isArray(props.meta[k]) ? props.meta[k] : [])
    set.has(o) ? set.delete(o) : set.add(o); props.meta[k] = [...set]
  } else props.meta[k] = props.meta[k] === o ? '' : o
}
function on(o: string) {
  const v = props.meta[props.section.key]
  return props.section.multi ? Array.isArray(v) && v.includes(o) : v === o
}
</script>
<template>
  <div class="checks"><b>{{ section.label }}</b>
    <span v-for="o in section.options" :key="o" class="chk" :class="{ on: on(o) }" @click="toggle(o)"><i class="cb" aria-hidden="true"></i>{{ o }}</span>
  </div>
</template>
<style scoped>
.checks{display:flex;flex-wrap:wrap;gap:14px;align-items:center;padding:6px 9px;font-size:12.5px;margin-bottom:8px}
.checks b{color:var(--muted);font-weight:500} .chk{cursor:pointer;color:var(--muted)} .chk.on{color:var(--ink);font-weight:600} .chk i{margin-right:3px;font-style:normal}
/* 纸质表勾选框：纯 CSS 方框，跨平台与打印渲染一致 */
.chk i.cb{display:inline-block;position:relative;width:10px;height:10px;border:1px solid var(--ink);border-radius:2px;margin-right:4px;vertical-align:-1px;print-color-adjust:exact;-webkit-print-color-adjust:exact}
.chk i.cb::after{content:'';position:absolute;left:2px;top:0;width:3px;height:6px;border:solid var(--ink);border-width:0 1.5px 1.5px 0;transform:rotate(45deg);opacity:0}
.chk.on i.cb::after{opacity:1}
</style>
