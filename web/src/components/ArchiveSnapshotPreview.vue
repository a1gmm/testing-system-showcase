<script setup lang="ts">
import { computed } from 'vue'
import { api, type ArchiveItem } from '../api'
import { archiveStageLabel } from '../archive/archiveViewer'
import ArchiveValue from './ArchiveValue.vue'

const props = defineProps<{ item: ArchiveItem }>()
const snapshot = computed<Record<string, any>>(() => {
  const value = props.item.metadata?.snapshot
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : { value }
})
const record = computed(() => snapshot.value.record && typeof snapshot.value.record === 'object' ? snapshot.value.record : null)
const result = computed(() => record.value?.data?.resultSummary)
const resultText = computed(() => {
  if (!result.value || result.value.value === null || result.value.value === undefined || result.value.value === '') return ''
  return `${result.value.value}${result.value.unit ? ` ${result.value.unit}` : ''}`
})
const decisions = computed(() => Array.isArray(props.item.metadata?.decisions) ? props.item.metadata.decisions : [])
const attachment = computed(() => props.item.entity_type === 'attachment' ? snapshot.value : null)
const attachmentUrl = computed(() => attachment.value?.id ? api.attachmentUrl(String(attachment.value.id)) : '')
</script>

<template>
  <article class="record-preview" :data-archive-preview="item.id">
    <header class="preview-head">
      <div>
        <span class="stage-name">{{ archiveStageLabel(item) }}</span>
        <h2>{{ item.label }}</h2>
      </div>
      <span v-if="item.revision !== null" class="frozen">定稿版本 {{ item.revision }}</span>
      <span v-else class="frozen">归档快照</span>
    </header>

    <div v-if="record" class="record-summary">
      <div><span>样品编号</span><b class="mono">{{ record.sampleId || '—' }}</b></div>
      <div><span>检测项目</span><b>{{ record.analyte || '—' }}</b></div>
      <div><span>检测方法</span><b>{{ record.method || '—' }}</b></div>
      <div><span>记录表号</span><b class="mono">{{ record.templateCode || '—' }}</b></div>
      <div v-if="resultText" class="result"><span>检测结果</span><b>{{ resultText }}</b></div>
    </div>

    <div v-if="attachment" class="attachment-preview">
      <div><b>{{ attachment.orig_name || item.label }}</b><span>{{ attachment.mime || '附件' }}</span></div>
      <a v-if="attachmentUrl" :href="attachmentUrl" target="_blank" rel="noopener">打开原文件</a>
    </div>

    <section class="snapshot-section">
      <div class="section-title"><h3>原始内容</h3><span>来自报告引用的冻结归档版本</span></div>
      <ArchiveValue :value="snapshot" />
    </section>

    <section v-if="decisions.length" class="snapshot-section">
      <div class="section-title"><h3>复核与审核</h3><span>{{ decisions.length }} 条签批记录</span></div>
      <ArchiveValue :value="decisions" field-key="decisions" />
    </section>

    <details class="audit-detail">
      <summary>版本与审计信息</summary>
      <div class="audit-grid">
        <span>记录编号</span><b class="mono">{{ item.entity_id }}</b>
        <span>记录类型</span><b class="mono">{{ item.entity_type }}</b>
        <span>内容哈希</span><b class="mono hash">{{ item.content_hash }}</b>
      </div>
    </details>
  </article>
</template>

<style scoped>
.record-preview{min-width:0;padding:20px 24px 28px}.preview-head{display:flex;align-items:flex-start;gap:12px;border-bottom:1px solid var(--line);padding-bottom:14px}
.preview-head>div{min-width:0;flex:1}.stage-name{display:block;color:var(--accent);font-size:12px;font-weight:600;margin-bottom:4px}.preview-head h2{margin:0;font-size:20px;line-height:1.35;overflow-wrap:anywhere}.frozen{flex:none;padding:4px 8px;border-radius:999px;background:var(--good-soft);color:var(--good);font-size:12px}
.record-summary{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:0;border-bottom:1px solid var(--line);margin-bottom:22px}.record-summary div{display:grid;gap:3px;padding:12px 12px 12px 0}.record-summary span{font-size:12px;color:var(--muted)}.record-summary b{font-size:14px}.record-summary .result b{color:var(--good);font-size:17px}
.snapshot-section{margin-top:22px}.section-title{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px}.section-title h3{margin:0;font-size:16px}.section-title span{color:var(--faint);font-size:12px}
.attachment-preview{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1px solid var(--line)}.attachment-preview div{display:grid;gap:3px}.attachment-preview span{color:var(--muted);font-size:12px}.attachment-preview a{min-height:44px;display:inline-flex;align-items:center;padding:0 14px;border:1px solid var(--accent);border-radius:7px;color:var(--accent);text-decoration:none;font-weight:600;font-size:13px}
.audit-detail{margin-top:24px;padding-top:12px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}.audit-detail summary{cursor:pointer;width:max-content}.audit-grid{display:grid;grid-template-columns:80px minmax(0,1fr);gap:6px 10px;margin-top:10px}.audit-grid b{font-weight:500;color:var(--faint);overflow-wrap:anywhere}.hash{word-break:break-all}.mono{font-family:var(--font-mono);font-variant-numeric:tabular-nums}
@media(max-width:900px){.record-preview{padding:16px}.record-summary{grid-template-columns:repeat(2,minmax(120px,1fr))}}@media(max-width:520px){.record-summary{grid-template-columns:1fr}.section-title{align-items:flex-start;flex-direction:column}}
</style>
