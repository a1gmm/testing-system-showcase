<script setup lang="ts">
import { computed } from 'vue'
import type { ArchiveItem } from '../api'
import { approvalRows, formalArchiveRecord } from '../archive/formalArchiveRecord'

defineOptions({ name: 'ArchiveFormalRecord' })
const props = defineProps<{ item: ArchiveItem }>()
const record = computed(() => formalArchiveRecord(props.item))
const approvals = computed(() => approvalRows(props.item))
function valueColspan(cellCount: number) { return cellCount === 1 ? 5 : cellCount === 2 ? 2 : 1 }
</script>

<template>
  <section class="formal-record" :data-formal-record="item.id">
    <header class="formal-header">
      <div class="formal-heading">
        <span data-form-number>{{ record.formNumber }}</span>
        <span>示例环境检测技术服务有限公司 · 冻结电子记录</span>
        <span class="project-number">项目编号：{{ record.projectNumber }}</span>
      </div>
      <h3>{{ record.title }}</h3>
    </header>

    <table v-if="record.metaRows.length" class="formal-table meta-table">
      <tbody>
        <tr v-for="(row, rowIndex) in record.metaRows" :key="rowIndex">
          <template v-for="cell in row" :key="cell.label">
            <th>{{ cell.label }}</th><td :colspan="valueColspan(row.length)">{{ cell.value }}</td>
          </template>
        </tr>
      </tbody>
    </table>

    <section v-for="(detail, tableIndex) in record.tables" :key="tableIndex" class="detail-section">
      <h4 v-if="detail.title">{{ detail.title }}</h4>
      <table class="formal-table detail-table">
        <thead><tr><th v-for="header in detail.headers" :key="header">{{ header }}</th></tr></thead>
        <tbody>
          <tr v-for="(row, rowIndex) in detail.rows" :key="rowIndex"><td v-for="(value, columnIndex) in row" :key="columnIndex">{{ value }}</td></tr>
          <tr v-if="!detail.rows.length"><td class="empty-row" :colspan="detail.headers.length">{{ detail.emptyText || '以下空白' }}</td></tr>
        </tbody>
      </table>
    </section>

    <section v-if="approvals.length" class="detail-section approval-section">
      <h4>复核与审核</h4>
      <table class="formal-table detail-table">
        <thead><tr><th>环节</th><th>结论</th><th>签批人账号</th><th>签批时间</th><th>意见</th><th>版本</th></tr></thead>
        <tbody><tr v-for="(row, rowIndex) in approvals" :key="rowIndex"><td v-for="(value, columnIndex) in row" :key="columnIndex">{{ value }}</td></tr></tbody>
      </table>
    </section>

    <p v-for="note in record.notes" :key="note" class="formal-note">{{ note }}</p>
    <footer class="formal-footer"><span>记录序号：{{ item.item_order }}</span><span>冻结版本：{{ item.revision === null ? '归档快照' : item.revision }}</span></footer>
  </section>
</template>

<style scoped>
.formal-record{box-sizing:border-box;padding:28px 32px 24px;font-family:"Songti SC","SimSun",serif;color:#000;background:#fff}
.formal-header{display:flow-root;margin-bottom:12px}.formal-heading{display:grid;grid-template-columns:1fr 2fr 1.4fr;align-items:end;gap:12px;font-size:12px}.formal-heading span:nth-child(2){text-align:center}.project-number{text-align:right;overflow-wrap:anywhere}.formal-record h3{margin:12px 0 16px;text-align:center;font-size:22px;letter-spacing:.18em}
.formal-table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:13px}.formal-table th,.formal-table td{border:1px solid #000;padding:7px 8px;line-height:1.55;vertical-align:middle;overflow-wrap:anywhere}.formal-table th{background:#fafafa;text-align:center;font-weight:600}.meta-table th{width:13%;white-space:nowrap}.meta-table td{width:auto}.detail-section{margin-top:12px}.detail-section h4{margin:0 0 6px;font-size:13px}.detail-table th{width:auto}.detail-table td{text-align:center}.empty-row{color:#666}.formal-note{margin:8px 0 0;font-size:10.5px;line-height:1.6}.formal-footer{display:flex;justify-content:space-between;margin-top:12px;padding-top:8px;border-top:1px solid #000;font-size:11px}
@media(max-width:720px){.formal-record{padding:20px 14px}.formal-heading{grid-template-columns:1fr}.formal-heading span:nth-child(2),.project-number{text-align:left}.formal-table{font-size:12px}.formal-table th,.formal-table td{padding:6px}.meta-table th{white-space:normal}.detail-section{overflow-x:auto}.detail-table{min-width:680px}}
@media print{.formal-record{page:archive-formal;padding:0;break-inside:auto}.formal-header,.detail-section,.formal-table tr{break-inside:avoid}.formal-table th{background:#fff}.formal-footer{break-inside:avoid}}
@page archive-formal{size:A4 landscape;margin:10mm}
</style>
