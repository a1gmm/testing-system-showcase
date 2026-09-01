import type { ArchiveItem, RecordData } from '../api'
import templatesJson from '../data/templates.json'
import { templateMatchesAnalyte, type LaboratoryTemplate } from '../data/laboratoryTemplateMatching'
import { templateMatchesSampleMatrix } from '../data/templateMatrix'
import { templatePhase } from '../data/phase'
import {
  ARCHIVE_STAGES,
  archiveAttachmentsForItem,
  archiveStageForItem,
  unassignedArchiveAttachmentsForStage,
  type ArchiveStageKey,
} from './archiveViewer'

export { archiveAttachmentsForItem }

type RecordTemplate = LaboratoryTemplate & {
  name?: string
  method?: string
  raw?: string
  meta?: Record<string, any>
}

export type ElectronicRecordBookSection = (typeof ARCHIVE_STAGES)[number] & { items: ArchiveItem[]; attachments: ArchiveItem[] }

export type FrozenSheet = {
  code: string
  file?: string
  name: string
  analyte: string
  matrix: string
  method: string
  sheetType: string
  sampleId?: string
  roundId?: string
  instrumentId?: string
  meta?: Record<string, any>
  data: RecordData
}

export type AttachmentPresentation = {
  kind: 'image' | 'pdf' | 'file'
  attachmentId: string
  name: string
  mime: string
}

const templates = templatesJson as RecordTemplate[]

function snapshot(item: ArchiveItem): Record<string, any> {
  const value = item.metadata?.snapshot
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function normal(value: unknown) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase().replace(/[\s（）()·_-]/g, '')
}

function templateScore(template: RecordTemplate, record: Record<string, any>) {
  let score = template.retired ? -100 : 0
  if (record.analyte && templateMatchesAnalyte(template, String(record.analyte))) score += 12
  if (record.matrix && templateMatchesSampleMatrix(template, String(record.matrix))) score += 6
  if (record.templateName && normal(template.name) === normal(record.templateName)) score += 5
  if (record.sheetType && normal(template.sheetType) === normal(record.sheetType)) score += 3
  if (record.method && normal(template.method) && (normal(record.method).includes(normal(template.method)) || normal(template.method).includes(normal(record.method)))) score += 2
  if (templatePhase(template) === '现场' && record.roundId) score += 2
  return score
}

function exactTemplate(code: string, record: Record<string, any>): RecordTemplate | undefined {
  return templates
    .filter(template => normal(template.code) === normal(code))
    .map((template, index) => ({ template, index, score: templateScore(template, record) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.template
}

export function electronicRecordBookSections(items: ArchiveItem[]): ElectronicRecordBookSection[] {
  return ARCHIVE_STAGES.map(stage => ({
    ...stage,
    items: items
      .filter(item => archiveStageForItem(item) === stage.key)
      .sort((left, right) => left.item_order - right.item_order),
    attachments: unassignedArchiveAttachmentsForStage(stage.key, items)
      .sort((left, right) => left.item_order - right.item_order),
  }))
}

export function resolveFrozenSheet(item: ArchiveItem): FrozenSheet | null {
  const archived = snapshot(item)
  if (item.entity_type === 'lab_record_workflow') {
    const record = archived.record
    if (!record || typeof record !== 'object' || !record.data || typeof record.data !== 'object') return null
    const code = String(record.templateCode || '').trim()
    if (!code) return null
    const template = exactTemplate(code, record)
    return {
      code,
      file: template?.file,
      name: String(record.templateName || template?.name || item.label),
      analyte: String(record.analyte || template?.analyte || ''),
      matrix: String(record.matrix || template?.matrix || ''),
      method: String(record.method || template?.method || ''),
      sheetType: String(record.sheetType || template?.sheetType || '原始记录'),
      sampleId: String(record.sampleId || '').trim() || undefined,
      instrumentId: String(record.instrumentId || '').trim() || undefined,
      meta: template?.meta,
      data: record.data as RecordData,
    }
  }

  if (item.entity_type === 'round_sheet') {
    const code = String(archived.template_code || archived.templateCode || item.entity_id.split('::').at(-1) || '').trim()
    const data = archived.data
    if (!code || !data || typeof data !== 'object') return null
    const roundId = String(archived.round_id || archived.roundId || item.entity_id.split('::')[0] || '').trim()
    const template = exactTemplate(code, { ...archived, roundId })
    return {
      code,
      file: template?.file,
      name: String(template?.name || item.label),
      analyte: String(template?.analyte || ''),
      matrix: String(template?.matrix || ''),
      method: String(template?.method || ''),
      sheetType: String(template?.sheetType || '采样记录'),
      roundId: roundId || undefined,
      meta: template?.meta,
      data: data as RecordData,
    }
  }

  return null
}

export function attachmentPresentation(item: ArchiveItem): AttachmentPresentation | null {
  if (item.entity_type !== 'attachment') return null
  const attachment = snapshot(item)
  const attachmentId = String(attachment.id || item.entity_id || '').trim()
  if (!attachmentId) return null
  const name = String(attachment.orig_name || item.label || '附件')
  const mime = String(attachment.mime || '').toLocaleLowerCase()
  const lowerName = name.toLocaleLowerCase()
  const kind = mime.startsWith('image/') || /\.(png|jpe?g|webp|heic)$/i.test(lowerName)
    ? 'image'
    : mime === 'application/pdf' || lowerName.endsWith('.pdf') ? 'pdf' : 'file'
  return { kind, attachmentId, name, mime }
}

export function stageAnchor(key: ArchiveStageKey) {
  return `record-book-stage-${key}`
}
