import type { ArchiveItem } from '../api'

export type ArchiveStageKey = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8'

export const ARCHIVE_STAGES: { key: ArchiveStageKey; number: string; label: string; hint: string }[] = [
  { key: '1', number: '1', label: '委托与合同', hint: '委托信息与合同原件' },
  { key: '2', number: '2', label: '合同评审', hint: '受理与技术评审结论' },
  { key: '3', number: '3', label: '监测方案', hint: '点位、项目、频次与限值' },
  { key: '4', number: '4', label: '采样指派', hint: '监测期次与人员安排' },
  { key: '5', number: '5', label: '现场采样', hint: '现场表单、照片与确认' },
  { key: '6', number: '6', label: '样品交接', hint: '样品登记、交接与签收' },
  { key: '7', number: '7', label: '质控', hint: '任务通知、质量安排与质控结果' },
  { key: '8', number: '8', label: '实验室分析', hint: '前处理与检测原始记录' },
]

function snapshot(item: ArchiveItem): Record<string, any> {
  const value = item.metadata?.snapshot
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

export function archiveStageForItem(item: ArchiveItem): ArchiveStageKey | null {
  if (item.entity_type === 'contract') return '1'
  if (item.entity_type === 'contract_review') return '2'
  if (item.entity_type === 'scheme') return '3'
  if (item.entity_type === 'round') return '4'
  if (item.entity_type === 'sampling_workflow' || item.entity_type === 'round_sheet') return '5'
  if (item.entity_type === 'handover_sheet' || item.entity_type === 'sample_handover' || item.entity_type === 'sample') return '6'
  if (item.entity_type === 'quality_plan_workflow' || item.entity_type === 'test_notice' || item.entity_type === 'test_task' || item.entity_type === 'qc_record') return '7'
  if (item.entity_type === 'lab_record_workflow' || item.entity_type === 'pretreatment') return '8'
  return null
}

export function isOriginalArchiveItem(item: ArchiveItem): boolean {
  return archiveStageForItem(item) !== null
}

export function archiveStageForAttachment(item: ArchiveItem): ArchiveStageKey | null {
  if (item.entity_type !== 'attachment') return null
  const attachedTo = String(snapshot(item).entity_type || '')
  if (attachedTo === 'record' || attachedTo === 'pretreatment') return '8'
  if (attachedTo === 'qc') return '7'
  if (attachedTo === 'handover') return '6'
  return '5'
}

function attachmentMatchesItem(attachment: ArchiveItem, item: ArchiveItem): boolean {
  const target = snapshot(attachment)
  const targetType = String(target.entity_type || '')
  const targetId = String(target.entity_id || '')
  if (!targetType || !targetId) return false

  if (targetType === 'record') return item.entity_type === 'lab_record_workflow' && item.entity_id === targetId
  if (targetType === 'pretreatment') return item.entity_type === 'pretreatment' && item.entity_id === targetId
  if (targetType === 'qc') return item.entity_type === 'qc_record' && item.entity_id === targetId
  if (targetType === 'handover') return item.entity_type === 'sample_handover' && item.entity_id === targetId
  if (targetType === 'round_sheet') {
    const itemSnapshot = snapshot(item)
    const roundSheetTarget = `${String(itemSnapshot.round_id || '')}::${String(itemSnapshot.template_code || '')}`
    return item.entity_type === 'round_sheet' && roundSheetTarget === targetId
  }
  if (targetType === 'round') return item.entity_type === 'sampling_workflow' && item.entity_id === targetId
  return false
}

export function archiveAttachmentsForItem(item: ArchiveItem, allItems: ArchiveItem[]): ArchiveItem[] {
  return allItems.filter(candidate => candidate.entity_type === 'attachment' && attachmentMatchesItem(candidate, item))
}

export function unassignedArchiveAttachmentsForStage(stage: ArchiveStageKey, allItems: ArchiveItem[]): ArchiveItem[] {
  const originalItems = allItems.filter(isOriginalArchiveItem)
  return allItems.filter(candidate => candidate.entity_type === 'attachment'
    && archiveStageForAttachment(candidate) === stage
    && !originalItems.some(item => attachmentMatchesItem(candidate, item)))
}

export function archiveItemSearchText(item: ArchiveItem): string {
  const raw = JSON.stringify(item.metadata?.snapshot ?? {})
  return `${item.label} ${item.entity_id} ${item.entity_type} ${raw}`.toLocaleLowerCase()
}

export function archiveStageLabel(item: ArchiveItem): string {
  return ARCHIVE_STAGES.find(stage => stage.key === archiveStageForItem(item))?.label || '归档证据'
}
