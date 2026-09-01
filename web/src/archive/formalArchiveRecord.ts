import type { ArchiveItem } from '../api'

export type FormalMetaCell = { label: string; value: string }
export type FormalTable = { title?: string; headers: string[]; rows: string[][]; emptyText?: string }
export type FormalRecordPresentation = {
  formNumber: string
  title: string
  projectNumber: string
  metaRows: FormalMetaCell[][]
  tables: FormalTable[]
  notes: string[]
}

const ACTION_LABELS: Record<string, string> = {
  contract_create: '登记委托合同', contract_accept: '确认受理', contract_tech_review: '技术合同评审',
  scheme_create: '编制监测方案', scheme_approve: '批准监测方案', project_stage_assignment_set: '设置专业复核与审核人员',
  round_assign: '采样指派', round_field: '保存现场采样记录', round_field_confirm: '确认现场采样记录',
  round_sample: '现场采样完成', round_sheet: '保存现场采样原始表', handover: '样品交接',
  handover_confirm: '确认样品交接', handover_sheet_update: '修改样品交接单', handover_sheet_send: '发送样品交接单',
  handover_sheet_confirm: '确认样品交接单', handover_sheet_confirmation_reconciled: '核对交接单签收状态',
  quality_plan_save: '保存质量安排', notice_create: '生成检测任务通知单', notice_update: '修改检测任务通知单',
  notice_issue: '下达检测任务通知单', notice_revoke: '撤回检测任务通知单', tasks_assign: '分配检测任务',
  task_claim: '认领检测任务', task_unclaim: '退回检测任务', task_cancel: '取消检测任务',
  create: '创建记录', update: '修改记录', submit: '提交复核', review: '复核完成', approve: '审核通过',
  reject: '退回修改', withdraw: '撤回', attach_upload: '上传附件', attach_delete: '删除附件',
  report_check: '报告复核', report_issue: '报告签发', report_void: '报告作废', archive_confirm: '确认归档',
}

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿', pending: '待处理', testing: '检测中', done: '已完成', complete: '已完成',
  active: '当前有效', unassigned: '未指派', revoked: '已撤销', quarantined: '已隔离',
  approved: '已批准', approve: '通过', rejected: '已退回', confirmed: '已确认', sent: '已发送', issued: '已下达',
  field: '现场采样', self: '客户送样', published: '已生成正式样品号', good: '完好', pass: '合格',
  review: '复核', laboratory: '实验室分析', sampling: '采样', quality: '质控', report: '报告',
}

const FIELD_LABELS: Record<string, string> = {
  date: '采样日期', samplingDate: '采样日期', weather: '天气', temp: '现场温度', temperature: '现场温度',
  point: '监测点位', org: '受检单位', note: '备注', waterColor: '水色', smell: '气味', oil: '油膜',
  floating: '漂浮物', anomaly: '异常情况', preserve: '保存方法', volume: '采样量', time: '采样时间',
  first: '第一次测定值', second: '第二次测定值', background: '本底值', spikedMeasured: '加标测定值',
  spikeAdded: '加标量', measured: '测定值', reference: '标准值', recovery: '回收率', relativeDeviation: '相对偏差',
  reason: '原因', comment: '意见', requirementCount: '质量要求数量', adjustmentCount: '调整数量', revision: '版本',
  status: '状态', name: '名称', result: '结果', value: '数值', unit: '单位', count: '数量',
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const source = value.trim()
  if (!(source.startsWith('{') || source.startsWith('['))) return value
  try { return JSON.parse(source) } catch { return value }
}

function object(value: unknown): Record<string, any> {
  const parsed = parseJson(value)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : {}
}

function list(value: unknown): any[] {
  const parsed = parseJson(value)
  return Array.isArray(parsed) ? parsed : []
}

function scalar(value: unknown): string {
  const parsed = parseJson(value)
  if (parsed === null || parsed === undefined || parsed === '') return '—'
  if (typeof parsed === 'boolean') return parsed ? '是' : '否'
  if (typeof parsed === 'number') return String(parsed)
  if (Array.isArray(parsed)) return parsed.length ? parsed.map(item => scalar(item)).join('、') : '—'
  if (typeof parsed === 'object') return Object.entries(parsed as Record<string, unknown>)
    .filter(([key, item]) => !isTechnicalKey(key) && item !== null && item !== undefined && item !== '')
    .map(([key, item]) => `${FIELD_LABELS[key] || humanKey(key)}：${scalar(item)}`).join('；') || '—'
  const text = String(parsed)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return text.slice(0, 16).replace('T', ' ')
  return STATUS_LABELS[text] || text
}

function isTechnicalKey(key: string) {
  return /(^|_)(hash|path|receipt|payload|nonce|fingerprint|blob|internal|schema)(_|$)/i.test(key)
    || /Hash$|Id$/.test(key) && !['sampleId', 'roundId', 'contractId'].includes(key)
}

function humanKey(key: string) {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ')
}

function yesNo(value: unknown) {
  if (value === true || value === 1 || value === '1' || value === '是') return '☑是　□否'
  if (value === false || value === 0 || value === '0' || value === '否') return '□是　☑否'
  return '□是　□否'
}

function items(value: unknown) {
  const values = list(value)
  return values.length ? values.map(item => scalar(item)).join('、') : scalar(value)
}

function cycleLabel(value: unknown) {
  const months = Number(value)
  if (!Number.isFinite(months)) return '—'
  if (months === 0) return '单次'
  return ({ 1: '每月', 3: '每季度', 6: '每半年', 12: '每年' } as Record<number, string>)[months] || `${months} 个月`
}

function pair(label: string, value: unknown): FormalMetaCell { return { label, value: scalar(value) } }
function table(title: string, headers: string[], rows: string[][], emptyText = '以下空白'): FormalTable {
  return { title, headers, rows, emptyText }
}

function base(item: ArchiveItem, title: string, formNumber = '电子记录'): FormalRecordPresentation {
  return { formNumber, title, projectNumber: item.entity_id, metaRows: [], tables: [], notes: [] }
}

function contractRecord(item: ArchiveItem, s: Record<string, any>) {
  const quote = object(s.quote_json ?? s.quoteJson)
  const record = base(item, '委托检测信息表', scalar(quote.extNo || s.id || item.entity_id))
  record.projectNumber = scalar(s.id || item.entity_id)
  record.metaRows = [
    [pair('委托单位', s.client), pair('项目名称', s.project)],
    [pair('联系人', s.contact), pair('联系电话', s.phone)],
    [pair('监测周期', cycleLabel(s.cycle_months)), pair('合同有效期', `${scalar(s.period_start)} 至 ${scalar(s.period_end)}`)],
    [pair('受理人 / 时间', [s.accepted_by, s.accepted_at].filter(Boolean).map(scalar).join('　')), pair('技术负责人 / 时间', [s.tech_approved_by, s.tech_approved_at].filter(Boolean).map(scalar).join('　'))],
    [pair('状态', s.status), pair('创建时间', s.created_at)],
  ]
  const rows = list(quote.rows).map((row, index) => {
    const r = object(row)
    return [String(index + 1), scalar(r.category), scalar(r.point), items(r.items), scalar(r.points ?? r.qty), scalar(r.perDay), scalar(r.perYear), scalar(r.subtotal)]
  })
  record.tables = [table('委托检测明细', ['序号', '任务类别', '监测点位', '检测项目', '点位/数量', '次/天', '次/年', '小计'], rows)]
  if (s.note) record.notes.push(`备注：${scalar(s.note)}`)
  return record
}

function contractReviewRecord(item: ArchiveItem, s: Record<string, any>) {
  const review = object(s.reviewInfo ?? s.review_info)
  const record = base(item, '检测业务合同评审记录表', 'QTCYT/JL141')
  record.metaRows = [
    [pair('合同编号', item.entity_id), pair('监测目的', review.purpose || '委托检测')],
    [pair('人力物质资源', yesNo(review.manpower ?? review.ability)), pair('仪器设备', yesNo(review.instruments ?? review.ability))],
    [pair('环境条件', yesNo(review.environment ?? review.ability)), pair('检测方法', yesNo(review.method ?? review['检测方法'] ?? review.ability))],
    [pair('委托方要求', yesNo(review.demand ?? review.ability)), pair('履约风险可控', yesNo(review.risk ?? review.ability))],
    [pair('是否需要分包', yesNo(review.subcontract)), pair('评审结论', s.result)],
    [pair('评审人 / 时间', [s.acceptedBy, s.acceptedAt].filter(Boolean).map(scalar).join('　')), pair('技术负责人 / 时间', [s.approvedBy, s.approvedAt].filter(Boolean).map(scalar).join('　'))],
    [pair('评审意见', s.note || review.note || review.conclusion)],
  ]
  return record
}

function schemeRecord(item: ArchiveItem, s: Record<string, any>) {
  const record = base(item, '监测方案记录表', scalar(s.id || item.entity_id))
  record.metaRows = [
    [pair('委托单号', s.contract_id), pair('方案状态', s.status)],
    [pair('监测周期', cycleLabel(s.cycle_months)), pair('有效期', `${scalar(s.period_start)} 至 ${scalar(s.period_end)}`)],
    [pair('编制时间', s.created_at), pair('审核人 / 时间', [s.reviewer, s.reviewed_at].filter(Boolean).map(scalar).join('　'))],
  ]
  record.tables = [
    table('监测点位与项目', ['序号', '监测要素', '监测点位', '检测项目', '监测频次', '执行标准'], list(s.points).map((row, index) => {
      const r = object(row)
      return [String(index + 1), scalar(r.element || r.matrix), scalar(r.point), items(r.items), scalar(r.freq), scalar(r.standard)]
    })),
    table('执行限值', ['检测项目', '判定关系', '限值', '单位', '执行标准'], list(s.limits).map(row => {
      const r = object(row)
      const limit = r.op === 'range' ? `${scalar(r.value)} - ${scalar(r.value2)}` : scalar(r.value)
      return [scalar(r.analyte), scalar(r.op), limit, scalar(r.unit), scalar(r.standard)]
    })),
  ]
  return record
}

function assignmentRecord(item: ArchiveItem, s: Record<string, any>) {
  const record = base(item, '专业复核与审核人员指派表')
  record.metaRows = [
    [pair('委托单号', s.contract_id), pair('业务环节', s.scope)],
    [pair('专业复核人账号', s.reviewer_username), pair('专业审核人账号', s.approver_username)],
    [pair('当前状态', s.active), pair('指派人 / 时间', [s.assigned_by, s.assigned_at].filter(Boolean).map(scalar).join('　'))],
    [pair('指派说明', s.reason)],
  ]
  return record
}

function roundRecord(item: ArchiveItem, s: Record<string, any>) {
  const record = base(item, '现场采样任务指派表')
  record.metaRows = [
    [pair('委托单号', s.contract_id), pair('监测期次', s.round_no)],
    [pair('计划采样日期', s.due_date), pair('约定采样日期', s.plan_date)],
    [pair('采样人员', s.sampler), pair('派工状态', s.assignment_status)],
    [pair('实际采样时间', s.sampled_at), pair('期次状态', s.status)],
  ]
  record.tables = [table('本期采样任务', ['序号', '样品基质', '监测点位', '检测项目', '数量'], list(s.items).map((row, index) => {
    const r = object(row)
    return [String(index + 1), scalar(r.matrix || r.element), scalar(r.point), items(r.items), scalar(r.qty)]
  }))]
  return record
}

function fieldInfoRows(fieldInfo: Record<string, any>) {
  return Object.entries(fieldInfo)
    .filter(([key, value]) => !['confirmations', 'confirmation_users', 'confirms', 'sheetCodes', 'sheets', 'sheetDrafts'].includes(key) && !isTechnicalKey(key) && value !== null && value !== undefined && value !== '')
    .map(([key, value]) => [FIELD_LABELS[key] || humanKey(key), scalar(value)])
}

function samplingWorkflowRecord(item: ArchiveItem, s: Record<string, any>) {
  const record = base(item, '现场采样审核记录表')
  const fieldInfo = object(s.fieldInfo)
  const legacyConfirmations = object(fieldInfo.confirmations)
  const confirmations = [
    ...Object.entries(legacyConfirmations).map(([account, value]) => {
      const confirmation = object(value)
      return [scalar(confirmation.name || account), scalar(confirmation.at || confirmation.confirmedAt), '现场共同确认', '—']
    }),
    ...list(s.mobileConfirmations).map(value => {
      const confirmation = object(value)
      return [scalar(confirmation.confirmerId), scalar(confirmation.confirmedAt), scalar(confirmation.taskVersion), scalar(confirmation.draftRevision)]
    }),
  ]
  record.metaRows = [
    [pair('委托单号', s.contractId), pair('监测期次', s.roundId)],
    [pair('冻结表单数量', list(s.roundSheets).length), pair('冻结附件数量', list(s.attachments).length + list(s.committedAttachmentReceipts).length)],
  ]
  record.tables = [
    table('现场信息', ['记录项目', '现场记录'], fieldInfoRows(fieldInfo)),
    table('采样计划', ['序号', '样品基质', '监测点位', '检测项目', '数量'], list(s.plan).map((row, index) => {
      const r = object(row)
      return [String(index + 1), scalar(r.matrix || r.element), scalar(r.point), items(r.items), scalar(r.qty)]
    })),
    table('现场样品', ['样品编号', '样品基质', '检测项目', '状态'], list(s.sampleSlots).map(value => {
      const slot = object(value)
      return [scalar(slot.officialSampleId || slot.temporaryId), scalar(slot.matrix), items(slot.items), scalar(slot.state)]
    })),
    table('现场双人确认', ['确认人', '确认时间', '确认依据', '草稿版本'], confirmations),
  ]
  return record
}

function handoverRecord(item: ArchiveItem, s: Record<string, any>) {
  const details = list(s.detail).map(object)
  const gasMatrices = ['废气', '有组织废气', '无组织废气', '环境空气', '大气降水']
  const isGas = gasMatrices.includes(String(s.matrix || '')) || details.some(row => gasMatrices.includes(String(row.matrix || row.sampleName || '')))
  const isSelf = s.source === 'self'
  const record = base(item, isGas ? '环境空气、废气样品交接单' : '水和废水交接记录表', isGas ? 'HJ-TC-596' : isSelf ? 'HJ-TC-135-1' : 'HJ-TC-135')
  record.projectNumber = [s.contract_id, s.id || item.entity_id].filter(Boolean).map(scalar).join(' · ')
  record.metaRows = [
    [pair('样品来源', isSelf ? '客户送样' : '现场采样'), pair('样品数量', list(s.sample_ids).length || details.length), pair('保存条件', s.storage || '常温')],
    [pair(`${isSelf ? '送样' : '采样'}人 / 时间`, [s.from_person, s.from_at].filter(Boolean).map(scalar).join('　')), pair('收样人 / 时间', [s.to_person, s.to_at].filter(Boolean).map(scalar).join('　'))],
  ]
  if (isGas) {
    record.tables = [table('样品交接明细', ['样品编号', '样品名称', '样品状态', '检测项目', '备注'], details.map(row => [
      scalar(row.sampleId), scalar(row.matrix || '废气'), row.rejected ? `拒收：${scalar(row.rejectReason)}` : scalar(row.condition || '完好'), items(row.items), scalar(row.note),
    ]))]
  } else {
    const headers = ['样品编号', ...(isSelf ? ['点位'] : []), '检测项目', '容器保存方法', '采样记录及样品运储检查']
    record.tables = [table('样品交接明细', headers, details.map(row => [
      scalar(row.sampleId), ...(isSelf ? [scalar(row.point || row.pointName)] : []), items(row.items), scalar(row.container || s.storage),
      row.rejected ? `拒收：${scalar(row.rejectReason)}` : '样品完整无异常',
    ]))]
    record.notes.push('保存方法：G-玻璃瓶；P-塑料瓶；J-灭菌瓶（袋）；O-溶解氧瓶。COD、总氮、总磷、氨氮加硫酸至 pH≤2，氰化物加 NaOH 至 pH≥12 冷藏，溶解氧现场固定；其余按 HJ 91.1-2019 执行。')
  }
  if (s.note) record.notes.push(`备注：${scalar(s.note)}`)
  return record
}

function sampleRecord(item: ArchiveItem, s: Record<string, any>) {
  const record = base(item, '样品登记表')
  record.metaRows = [
    [pair('样品编号', s.id || item.entity_id), pair('样品基质', s.matrix)],
    [pair('委托单位', s.client), pair('样品来源', s.source)],
    [pair('委托单号', s.contract_id), pair('监测期次', s.round_id)],
    [pair('检测项目', items(s.items)), pair('样品状态', s.status)],
    [pair('质控类型', s.qc_type), pair('登记时间', s.created_at)],
    [pair('备注', s.note)],
  ]
  return record
}

function sampleHandoverRecord(item: ArchiveItem, s: Record<string, any>) {
  const record = base(item, '样品流转交接记录表')
  record.metaRows = [
    [pair('样品编号', s.sample_id), pair('流转操作', s.action)],
    [pair('交出人', s.from_person), pair('接收人', s.to_person)],
    [pair('样品状态', s.condition), pair('交接时间', s.at)],
    [pair('签收人', s.confirmed_by), pair('签收时间', s.confirmed_at)],
    [pair('备注', s.note)],
  ]
  return record
}

function qualityPlanRecord(item: ArchiveItem, s: Record<string, any>) {
  const record = base(item, '质量控制安排表')
  record.metaRows = [[pair('监测期次', item.entity_id), pair('编制人 / 时间', [s.authorUsername, s.updatedAt].filter(Boolean).map(scalar).join('　'))]]
  const rows = (value: unknown) => list(value).map(entry => {
    const r = object(entry)
    return [scalar(r.qcType), scalar(r.matrix), scalar(r.analyte), scalar(r.qty), scalar(r.basis), scalar(r.note)]
  })
  record.tables = [
    table('质量控制要求', ['质控类型', '样品基质', '检测项目', '数量', '依据', '备注'], rows(s.requirements)),
    ...(list(s.adjustments).length ? [table('人工调整', ['质控类型', '样品基质', '检测项目', '数量', '依据', '备注'], rows(s.adjustments))] : []),
  ]
  return record
}

function testNoticeRecord(item: ArchiveItem, s: Record<string, any>) {
  const record = base(item, '检测任务通知单', 'HJ-TC-137')
  record.metaRows = [
    [pair('通知单号', s.id || item.entity_id), pair('样品份数 / 状态', s.sample_desc)],
    [pair('任务类别', s.category), pair('任务性质', s.nature)],
    [pair('样品来源', s.source), pair('接样时间', s.received_at)],
    [pair('完成时间', s.due_at), pair('承接科室', s.dept || '环境室')],
    [pair('承办人 / 下达时间', [s.issuer, s.issued_at].filter(Boolean).map(scalar).join('　')), pair('状态', s.status)],
  ]
  record.tables = [table('检测项目', ['样品编号', '检测项目'], list(s.groups).map(value => {
    const group = object(value)
    return [scalar(group.sampleId), items(group.analytes)]
  }))]
  if (s.note) record.notes.push(`备注：${scalar(s.note)}`)
  return record
}

function testTaskRecord(item: ArchiveItem, s: Record<string, any>) {
  const record = base(item, '检测任务指派表')
  record.metaRows = [
    [pair('样品编号', s.sample_id), pair('检测项目', s.analyte)],
    [pair('检测人员', s.assignee), pair('检测人员账号', s.assignee_username)],
    [pair('指派人', s.assigned_by), pair('指派时间', s.assigned_at)],
  ]
  return record
}

function pretreatmentRecord(item: ArchiveItem, s: Record<string, any>) {
  const record = base(item, '样品前处理记录表')
  record.metaRows = [
    [pair('样品编号', s.sample_id), pair('前处理方法', s.method)],
    [pair('所用试剂', s.reagent), pair('处理条件', s.condition)],
    [pair('定容 / 最终体积', s.vol_final), pair('操作人 / 时间', [s.who, s.at].filter(Boolean).map(scalar).join('　'))],
    [pair('备注', s.note)],
  ]
  return record
}

function qcRecord(item: ArchiveItem, s: Record<string, any>) {
  const record = base(item, '质量控制结果记录表')
  record.metaRows = [
    [pair('质控类型', s.qc_type), pair('监测期次', s.round_id)],
    [pair('样品编号', s.sample_id), pair('检测项目', s.analyte)],
    [pair('计算结果', `${scalar(s.result)} ${s.unit || ''}`.trim()), pair('判定', s.verdict)],
    [pair('判定依据', s.criterion), pair('记录人 / 时间', [s.who, s.at].filter(Boolean).map(scalar).join('　'))],
  ]
  record.tables = [table('质控原始数据', ['数据项目', '原始值'], Object.entries(object(s.data)).filter(([key]) => !isTechnicalKey(key)).map(([key, value]) => [FIELD_LABELS[key] || humanKey(key), scalar(value)]))]
  if (s.note) record.notes.push(`备注：${scalar(s.note)}`)
  return record
}

function reportBatchRecord(item: ArchiveItem, s: Record<string, any>) {
  const record = base(item, '报告批次范围表')
  record.metaRows = [
    [pair('报告批次', s.name), pair('批次编号', s.id || item.entity_id)],
    [pair('委托单号', s.contract_id), pair('创建人 / 时间', [s.created_by, s.created_at].filter(Boolean).map(scalar).join('　'))],
  ]
  record.tables = [table('包含监测期次', ['序号', '监测期次编号'], list(s.round_ids).map((roundId, index) => [String(index + 1), scalar(roundId)]))]
  return record
}

function auditDetail(value: unknown) {
  const detail = object(value)
  const segments: string[] = []
  if (detail.revision !== undefined) segments.push(`第 ${scalar(detail.revision)} 版`)
  for (const value of list(detail.changes)) {
    const change = object(value)
    const row = Number(change.row)
    const location = Number.isFinite(row) ? `第 ${row + 1} 行` : ''
    const column = scalar(change.col || change.field || change.key)
    const transition = `${column}：${scalar(change.from)} → ${scalar(change.to)}`
    segments.push([location, transition].filter(Boolean).join(' · '))
  }
  for (const [key, entry] of Object.entries(detail)) {
    if (['revision', 'changes'].includes(key) || isTechnicalKey(key) || entry === null || entry === undefined || entry === '') continue
    segments.push(`${FIELD_LABELS[key] || humanKey(key)}：${scalar(entry)}`)
  }
  return segments.join('；') || '无补充说明'
}

function auditRecord(item: ArchiveItem, s: Record<string, any>) {
  const record = base(item, '电子记录操作留痕表')
  record.metaRows = [
    [pair('关联记录', s.record_id), pair('操作', ACTION_LABELS[String(s.action || '')] || s.action)],
    [pair('操作人', s.who), pair('账号', s.username)],
    [pair('记录时间', s.at), pair('变更内容', auditDetail(s.detail))],
  ]
  return record
}

function unknownRecord(item: ArchiveItem, s: Record<string, any>) {
  const record = base(item, item.label || '冻结电子记录表')
  record.tables = [table('冻结记录', ['记录项目', '记录值'], Object.entries(s)
    .filter(([key, value]) => !isTechnicalKey(key) && value !== null && value !== undefined && value !== '')
    .map(([key, value]) => [FIELD_LABELS[key] || humanKey(key), scalar(value)]))]
  return record
}

export function formalArchiveRecord(item: ArchiveItem): FormalRecordPresentation {
  const s = object(item.metadata?.snapshot)
  switch (item.entity_type) {
    case 'contract': return contractRecord(item, s)
    case 'contract_review': return contractReviewRecord(item, s)
    case 'scheme': return schemeRecord(item, s)
    case 'assignment': return assignmentRecord(item, s)
    case 'round': return roundRecord(item, s)
    case 'sampling_workflow': return samplingWorkflowRecord(item, s)
    case 'handover_sheet': return handoverRecord(item, s)
    case 'sample': return sampleRecord(item, s)
    case 'sample_handover': return sampleHandoverRecord(item, s)
    case 'quality_plan_workflow': return qualityPlanRecord(item, s)
    case 'test_notice': return testNoticeRecord(item, s)
    case 'test_task': return testTaskRecord(item, s)
    case 'pretreatment': return pretreatmentRecord(item, s)
    case 'qc_record': return qcRecord(item, s)
    case 'report_batch': return reportBatchRecord(item, s)
    case 'audit_entry': return auditRecord(item, s)
    default: return unknownRecord(item, s)
  }
}

export function approvalRows(item: ArchiveItem): string[][] {
  return list(item.metadata?.decisions).map(value => {
    const decision = object(value)
    return [
      decision.level === 'review' ? '复核' : decision.level === 'approve' ? '审核' : scalar(decision.level),
      scalar(decision.decision), scalar(decision.decided_by), scalar(decision.decided_at), scalar(decision.comment), scalar(decision.revision || item.revision),
    ]
  })
}
