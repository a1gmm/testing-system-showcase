<script setup lang="ts">
import type { Section } from '../../data/schemas'
defineProps<{ section: Extract<Section,{type:'diagram'}> }>()
</script>
<template><div class="diag"><span>{{ section.label }}</span><div class="box">（示意图区域）</div></div></template>
<style scoped>
.diag{padding:6px 9px;margin-bottom:8px;font-size:12.5px} .diag span{color:var(--muted)}
.box{border:1px dashed var(--line-strong);border-radius:6px;height:120px;display:flex;align-items:center;justify-content:center;color:var(--faint);margin-top:4px}
</style>
