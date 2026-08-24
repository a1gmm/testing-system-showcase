<script setup lang="ts">
import { computed } from 'vue'
import { BUSINESS_STAGES, type BusinessStageKey } from '../workflow/businessStages'

const props = withDefaults(defineProps<{
  currentStage?: BusinessStageKey
  completedStages?: BusinessStageKey[]
  blockers?: string[]
}>(), { completedStages: () => [], blockers: () => [] })

const completed = computed(() => new Set(props.completedStages))
</script>

<template>
  <section class="stage-progress" aria-label="项目十阶段进度">
    <ol>
      <li v-for="stage in BUSINESS_STAGES" :key="stage.key" :data-stage-key="stage.key"
          :class="{ current: stage.key === currentStage, complete: completed.has(stage.key) }">
        <router-link :to="stage.to">
          <span class="mark" aria-hidden="true">{{ completed.has(stage.key) ? '✓' : stage.key === currentStage ? '●' : '○' }}</span>
          <span>{{ stage.label }}</span>
        </router-link>
      </li>
    </ol>
    <div v-if="blockers.length" class="blockers" role="alert">
      <b>当前阻塞</b>
      <ul><li v-for="blocker in blockers" :key="blocker">{{ blocker }}</li></ul>
    </div>
  </section>
</template>

<style scoped>
.stage-progress{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:12px 0;margin:16px 0 20px;overflow:hidden}
ol{display:grid;grid-template-columns:repeat(10,minmax(108px,1fr));gap:1px;list-style:none;margin:0;padding:0;overflow-x:auto;background:var(--line)}
ol li{background:var(--surface);min-width:108px}a{display:flex;align-items:flex-start;gap:6px;min-height:44px;padding:9px 8px;color:var(--muted);text-decoration:none;font-size:12px;line-height:1.35}.mark{font-family:var(--font-mono);color:var(--faint)}li.complete a{color:var(--good)}li.current a{background:var(--accent-soft);color:var(--accent-ink);font-weight:600}li.current .mark{color:var(--accent)}
.blockers{display:flex;gap:12px;margin-top:12px;padding:10px 12px;border-radius:6px;background:var(--warn-soft);color:var(--warn);font-size:14px}.blockers b{white-space:nowrap}.blockers ul{margin:0;padding-left:18px}
@media (max-width:900px){ol{grid-template-columns:repeat(10,132px)}}
</style>
