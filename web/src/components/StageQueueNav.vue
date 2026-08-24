<script setup lang="ts">
import { useRoute } from 'vue-router'
import { STAGE_QUEUES, type StageQueueKey } from '../workflow/businessStages'

defineProps<{ active: StageQueueKey; counts?: Partial<Record<StageQueueKey, number>> }>()
const route = useRoute()
</script>

<template>
  <nav class="queue-nav" aria-label="阶段工作队列">
    <router-link v-for="queue in STAGE_QUEUES" :key="queue.key"
      :to="{ query: { ...route.query, queue: queue.key } }" :class="{ active: active === queue.key }">
      {{ queue.label }}<span v-if="counts?.[queue.key] !== undefined" class="count">{{ counts[queue.key] }}</span>
    </router-link>
  </nav>
</template>

<style scoped>
.queue-nav{display:flex;gap:4px;overflow-x:auto;border-bottom:1px solid var(--line);margin:0 0 16px}.queue-nav a{display:flex;align-items:center;gap:6px;min-height:44px;padding:0 13px;border-bottom:2px solid transparent;color:var(--muted);text-decoration:none;font-size:14px;white-space:nowrap}.queue-nav a:hover{color:var(--ink);background:var(--surface-2)}.queue-nav a.active{color:var(--accent-ink);border-color:var(--accent);font-weight:600;background:var(--accent-soft)}.count{font:600 12px var(--font-mono);font-variant-numeric:tabular-nums}
</style>
