<script setup lang="ts">
import { computed } from 'vue'

defineOptions({ name: 'ArchiveValue' })
const props = withDefaults(defineProps<{ value: unknown; fieldKey?: string; depth?: number }>(), { fieldKey: '', depth: 0 })

const LABELS: Record<string, string> = {
  id: '记录编号', serial: '记录流水号', contract_id: '委托单号', contractId: '委托单号', round_id: '监测期次', roundId: '监测期次',
  sample_id: '样品编号', sampleId: '样品编号', client: '委托单位', contact: '联系人', project: '项目名称', note: '备注',
  name: '名称', created_at: '创建时间', createdAt: '创建时间', updated_at: '最后更新时间', updatedAt: '最后更新时间',
  accepted_at: '受理时间', acceptedAt: '受理时间', accepted_by: '受理人', acceptedBy: '受理人',
  review_info: '合同评审内容', reviewInfo: '合同评审内容', doc_name: '合同原件', quote_json: '报价信息',
  tech_review_result: '技术评审结论', tech_approved_by: '技术批准人', tech_approved_at: '技术批准时间', tech_approve_note: '技术评审意见',
  matrix: '样品基质', items: '检测项目', status: '状态', source: '样品来源', qc_type: '质控类型', qcType: '质控类型',
  template_code: '记录表号', templateCode: '记录表号', template_name: '记录表名称', templateName: '记录表名称', sheet_type: '记录类型', sheetType: '记录类型',
  analyte: '检测项目', method: '检测方法', instrument_id: '仪器编号', instrumentId: '仪器编号', data: '原始记录内容', rows: '记录明细', cells: '表格内容', meta: '记录信息',
  resultSummary: '检测结果', value: '结果值', unit: '单位', result: '结果', verdict: '判定', criterion: '判定依据',
  points: '监测点位', limits: '执行限值', cycle_months: '监测周期（月）', period_start: '开始日期', period_end: '结束日期',
  round_no: '期次', round_ids: '包含期次', due_date: '计划采样日期', sampler: '采样人员', sampler_ids: '采样人员账号', plan_date: '约定采样日期', sampled_at: '实际采样时间', field_info: '现场信息', fieldInfo: '现场信息',
  assignment_status: '指派状态', assignment_updated_at: '指派更新时间', scope: '业务环节', reviewer_username: '复核人账号', approver_username: '审核人账号', active: '当前有效', reason: '指派说明',
  roundSheets: '现场原始记录表', attachments: '附件', sampleSlots: '现场样品', mobileConfirmations: '双人确认',
  sample_ids: '样品清单', detail: '交接明细', from_person: '交出人', fromPerson: '交出人', from_username: '交出人账号', from_at: '交出时间', to_person: '接收人', toPerson: '接收人', to_at: '接收时间', condition: '条件', confirmed_by: '签收人', confirmed_at: '签收时间', storage: '保存条件',
  groups: '检测任务分组', category: '任务类别', nature: '任务性质', sample_desc: '样品说明', received_at: '接样时间', due_at: '要求完成时间', dept: '承接科室', issuer: '下达人', issuer_username: '下达人账号', issued_at: '下达时间',
  assignee: '检测人员', assignee_username: '检测人员账号', assigned_by: '指派人', assigned_at: '指派时间', created_by: '创建人',
  requirements: '质量控制要求', adjustments: '质量调整', qty: '数量', basis: '依据',
  reagent: '试剂', vol_final: '最终体积', volFinal: '最终体积', at: '记录时间', who: '记录人', username: '账号',
  record: '检测原始记录', analyticalQcResults: '分析质控结果', pretreatments: '前处理记录', recheck: '复检标记', recheckReason: '复检原因',
  analysisDate: '分析日期', analyst: '分析人员', absorbance: '吸光度', dilution: '稀释倍数',
  approvedBy: '批准人', approvedAt: '批准时间',
  submittedBy: '提交人账号', submittedAt: '提交时间', decisions: '复核与审核记录', revision: '版本', level: '审批环节', decision: '审批结论', comment: '审批意见', decided_by: '审批人账号', decided_at: '审批时间',
  action: '操作', record_id: '关联记录', content_hash: '内容哈希', orig_name: '文件名', mime: '文件类型', size: '文件大小',
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!(text.startsWith('{') || text.startsWith('['))) return value
  try { return JSON.parse(text) } catch { return value }
}
const normalised = computed(() => parseJson(props.value))
const isArray = computed(() => Array.isArray(normalised.value))
const isObject = computed(() => normalised.value !== null && typeof normalised.value === 'object' && !isArray.value)
const entries = computed(() => isObject.value ? Object.entries(normalised.value as Record<string, unknown>).filter(([, value]) => value !== null && value !== undefined && value !== '') : [])
const label = (key: string) => LABELS[key] || key.replaceAll('_', ' ')
function scalar(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (value === true || (value === 1 && /^(active|consent|recheck)$/.test(props.fieldKey))) return '是'
  if (value === false || (value === 0 && /^(active|consent|recheck)$/.test(props.fieldKey))) return '否'
  if (typeof value === 'number') return String(value)
  const text = String(value)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return text.slice(0, 16).replace('T', ' ')
  if (props.fieldKey === 'level') return ({ review: '复核', approve: '审核' } as Record<string, string>)[text] || text
  const map: Record<string, string> = {
    approve: '通过', approved: '已批准', confirmed: '已确认', issued: '已下达', checked: '已复核',
    draft: '草稿', pending: '待处理', ready: '待确认', invalidated: '已失效', rejected: '已退回',
    good: '合格', done: '已完成', complete: '已完成', active: '当前有效', unassigned: '未指派', revoked: '已撤销', quarantined: '已隔离',
    field: '现场采样', self: '客户送样', sampling: '采样', quality: '质控', laboratory: '实验室分析', report: '报告',
    round_sampling: '现场采样', quality_plan: '质量安排', lab_record: '实验室原始记录', review: '复核',
    contract_tech_review: '技术合同评审', round_assign: '采样指派', round_sample: '现场采样完成',
    submit: '提交复核', reject: '退回修改', withdraw: '撤回', attach_upload: '上传附件', attach_delete: '删除附件',
    handover: '样品交接', report_check: '报告复核', report_issue: '报告签发', report_void: '报告作废', archive_confirm: '确认归档',
  }
  return map[text] || text
}
</script>

<template>
  <span v-if="!isArray && !isObject" class="archive-scalar">{{ scalar(normalised) }}</span>
  <span v-else-if="isArray && !(normalised as unknown[]).length" class="archive-empty-value">无</span>
  <div v-else-if="isArray" class="archive-array" :class="{ nested: depth > 0 }">
    <div v-for="(entry, index) in (normalised as unknown[])" :key="index" class="archive-array-row">
      <span class="archive-row-number">{{ index + 1 }}</span>
      <ArchiveValue :value="entry" :depth="depth + 1" />
    </div>
  </div>
  <dl v-else class="archive-object" :class="{ nested: depth > 0 }">
    <template v-for="([key, entry]) in entries" :key="key">
      <dt>{{ label(key) }}</dt>
      <dd><ArchiveValue :value="entry" :field-key="key" :depth="depth + 1" /></dd>
    </template>
  </dl>
</template>

<style scoped>
.archive-scalar{white-space:pre-wrap;overflow-wrap:anywhere}.archive-empty-value{color:var(--faint)}
.archive-object{display:grid;grid-template-columns:minmax(120px,180px) minmax(0,1fr);margin:0;border-top:1px solid var(--line)}
.archive-object.nested{margin:2px 0;border:1px solid var(--line);border-radius:6px;overflow:hidden}
.archive-object dt,.archive-object dd{margin:0;padding:9px 10px;border-bottom:1px solid var(--line);font-size:13px;line-height:1.5}
.archive-object dt{color:var(--muted);background:var(--surface-2);font-weight:500}.archive-object dd{min-width:0;background:var(--surface)}
.archive-array{display:grid;gap:8px}.archive-array-row{display:grid;grid-template-columns:24px minmax(0,1fr);gap:6px;align-items:start}
.archive-row-number{padding-top:8px;color:var(--faint);font:500 11px var(--font-mono)}
@media(max-width:720px){.archive-object{grid-template-columns:1fr}.archive-object dt{border-bottom:0;padding-bottom:3px}.archive-object dd{padding-top:3px}}
</style>
