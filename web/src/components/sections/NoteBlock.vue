<script setup lang="ts">
import type { Section } from '../../data/schemas'
defineProps<{ section: Extract<Section,{type:'note'}>; meta: Record<string,any>; locked?: boolean }>()
</script>
<template>
  <div class="note"><b>{{ section.label }}</b>
    <textarea v-model="meta[section.key]" :rows="section.rows||2" :disabled="locked" class="f" /></div>
</template>
<style scoped>
.note{display:flex;gap:8px;padding:6px 9px;font-size:12.5px;margin-bottom:8px}
.note b{color:var(--muted);font-weight:500;white-space:nowrap}
.note .f{flex:1;border:1px solid var(--line-strong);border-radius:4px;font-family:inherit;font-size:12.5px;padding:4px 6px;resize:vertical}
</style>
