<script setup lang="ts">
import type { Section } from '../../data/schemas'
import katex from 'katex'
const props = defineProps<{ section: Extract<Section,{type:'kv'}>; meta: Record<string,any>; locked?: boolean }>()
function toggle(key: string, opt: string) {
  if (props.locked) return
  props.meta[key] = props.meta[key] === opt ? '' : opt
}
function tex(s: string) {
  try { return katex.renderToString(s, { throwOnError: false }) } catch { return s }
}
</script>
<template>
  <div class="kv" :style="{ gridTemplateColumns: `repeat(${section.cols||1}, minmax(0,1fr))` }">
    <div v-for="r in section.rows" :key="r.key||r.label" class="kvrow" :style="{ gridColumn: r.colspan ? `span ${r.colspan}` : undefined }">
      <b>{{ r.label }}</b>
      <template v-if="r.checks">
        <span v-for="o in r.checks" :key="o" class="chk" :class="{ on: meta[r.checksKey!]===o }" @click="toggle(r.checksKey!, o)">
          <i class="cb" aria-hidden="true"></i>{{ o }}
        </span>
      </template>
      <span v-else-if="r.latex" class="tex" v-html="tex(r.latex)"></span>
      <span v-else-if="r.fixed" class="fx">{{ r.value || meta[r.key!] || '' }}</span>
      <input v-else v-model="meta[r.key!]" :disabled="locked" class="f" />
    </div>
  </div>
</template>
<style scoped>
.kv{display:grid;gap:1px;border:1px solid var(--line-strong);background:var(--line-strong);margin:0 0 10px}
.kvrow{display:flex;align-items:baseline;gap:8px;background:var(--surface);padding:6px 9px;min-height:30px;font-size:12.5px}
.kvrow b{color:var(--muted);font-weight:500;white-space:nowrap;flex:none}
.kvrow .f{flex:1;min-width:0;border:0;border-bottom:1px solid var(--line-strong);background:transparent;height:24px;font-family:var(--font-mono);font-size:12.5px}
.chk{cursor:pointer;user-select:none;color:var(--muted)} .chk.on{color:var(--ink);font-weight:600} .chk i{margin-right:3px;font-style:normal}
/* 纸质表勾选框：纯 CSS 方框，跨平台与打印渲染一致 */
.chk i.cb{display:inline-block;position:relative;width:10px;height:10px;border:1px solid var(--ink);border-radius:2px;margin-right:4px;vertical-align:-1px;print-color-adjust:exact;-webkit-print-color-adjust:exact}
.chk i.cb::after{content:'';position:absolute;left:2px;top:0;width:3px;height:6px;border:solid var(--ink);border-width:0 1.5px 1.5px 0;transform:rotate(45deg);opacity:0}
.chk.on i.cb::after{opacity:1}
.fx{font-weight:600;color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}
.tex{font-size:15px;color:var(--ink);overflow-x:auto;max-width:100%}
</style>
