import { describe, expect, test } from 'vitest'
import type { ArchiveItem } from '../src/api'
import {
  attachmentPresentation,
  electronicRecordBookSections,
  resolveFrozenSheet,
} from '../src/archive/electronicRecordBook'

function item(id: number, entityType: string, snapshot: Record<string, unknown>): ArchiveItem {
  return {
    id,
    archive_package_id: 'ARCHIVE-1',
    item_order: id,
    entity_type: entityType,
    entity_id: `${entityType}-${id}`,
    workflow_instance_id: entityType.endsWith('_workflow') ? `WF-${id}` : null,
    revision: entityType.endsWith('_workflow') ? 2 : null,
    content_hash: String(id).repeat(64).slice(0, 64),
    label: `${entityType} ${id}`,
    metadata: { snapshot },
  }
}

describe('电子原始记录册投影', () => {
  test('每条冻结归档记录只进入一个阶段且保持归档顺序', () => {
    const items = [
      item(2, 'round_sheet', { template_code: 'HJ-TC-136', data: { rows: [] } }),
      item(1, 'contract', { id: 'WT-1' }),
      item(3, 'lab_record_workflow', { record: { templateCode: 'HJ-TC-103', analyte: '化学需氧量', data: { rows: [] } } }),
      item(4, 'attachment', { id: 'ATT-1', entity_type: 'record', orig_name: '色谱图.pdf', mime: 'application/pdf' }),
      item(5, 'audit_entry', { action: 'approve' }),
    ]

    const sections = electronicRecordBookSections(items)

    expect(sections.map(section => section.key)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', 'audit'])
    expect(sections.flatMap(section => section.items).map(entry => entry.id)).toEqual([1, 2, 3, 4, 5])
    expect(sections.find(section => section.key === '5')?.items.map(entry => entry.id)).toEqual([2])
    expect(sections.find(section => section.key === '8')?.items.map(entry => entry.id)).toEqual([3, 4])
  })

  test('实验室原始表使用工作流冻结数据并按项目消除同表号歧义', () => {
    const frozenData = { rows: [{ sample: 'W260831-1', v: 12 }], meta: { signer: '分析员甲' } }
    const lab = item(7, 'lab_record_workflow', {
      record: {
        id: 'REC-1', sampleId: 'W260831-1', templateCode: 'HJ-TC-103', templateName: '化学需氧量(CODcr)',
        analyte: '化学需氧量', matrix: '废水', method: '重铬酸盐法', sheetType: '原始记录',
        instrumentId: 'TC-008', data: frozenData,
      },
    })

    expect(resolveFrozenSheet(lab)).toMatchObject({
      code: 'HJ-TC-103', file: '0100.pdf', analyte: '化学需氧量', matrix: '废水',
      sampleId: 'W260831-1', instrumentId: 'TC-008', data: frozenData,
    })
  })

  test('现场原始表直接使用归档条目中的冻结表格数据', () => {
    const frozenData = { rows: [{ point: '1#排口', time: '09:10' }], meta: { signer: '采样员甲' } }
    const field = item(8, 'round_sheet', {
      id: 'ROUND-1::HJ-TC-136', round_id: 'ROUND-1', template_code: 'HJ-TC-136', data: frozenData,
    })

    expect(resolveFrozenSheet(field)).toMatchObject({
      code: 'HJ-TC-136', file: '0403.pdf', matrix: '废水', roundId: 'ROUND-1', data: frozenData,
    })
  })

  test('附件区分图片、PDF 和其他原文件且始终保留下载入口', () => {
    const pdf = item(9, 'attachment', { id: 'ATT-PDF', entity_type: 'record', orig_name: '仪器输出.PDF', mime: 'application/pdf' })
    const image = item(10, 'attachment', { id: 'ATT-IMG', entity_type: 'round_sheet', orig_name: '现场照片.jpg', mime: 'image/jpeg' })
    const other = item(11, 'attachment', { id: 'ATT-DOC', entity_type: 'handover', orig_name: '补充说明.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })

    expect(attachmentPresentation(pdf)).toMatchObject({ kind: 'pdf', attachmentId: 'ATT-PDF', name: '仪器输出.PDF' })
    expect(attachmentPresentation(image)).toMatchObject({ kind: 'image', attachmentId: 'ATT-IMG', name: '现场照片.jpg' })
    expect(attachmentPresentation(other)).toMatchObject({ kind: 'file', attachmentId: 'ATT-DOC', name: '补充说明.docx' })
  })

  test('损坏快照不会伪造成正式表，未知旧模板保留数据但明确没有版式', () => {
    const missingRecord = item(12, 'lab_record_workflow', {})
    const missingData = item(13, 'lab_record_workflow', { record: { templateCode: 'HJ-OLD-001' } })
    const unknownTemplate = item(14, 'lab_record_workflow', {
      record: { templateCode: 'HJ-OLD-001', analyte: '历史项目', data: { rows: [{ value: '12.3' }] } },
    })

    expect(resolveFrozenSheet(missingRecord)).toBeNull()
    expect(resolveFrozenSheet(missingData)).toBeNull()
    expect(resolveFrozenSheet(unknownTemplate)).toMatchObject({ code: 'HJ-OLD-001', file: undefined, data: { rows: [{ value: '12.3' }] } })
  })

  test('现场表兼容旧字段和复合实体编号，附件缺少冻结编号时拒绝展示', () => {
    const field = item(15, 'round_sheet', { templateCode: 'HJ-TC-136', roundId: 'ROUND-OLD', data: { rows: [] } })
    field.entity_id = 'ROUND-FALLBACK::HJ-TC-136'
    const missingAttachment = item(16, 'attachment', {})
    missingAttachment.entity_id = ''
    const extensionOnly = item(17, 'attachment', { id: 'ATT-EXT', orig_name: '仪器输出.PdF' })

    expect(resolveFrozenSheet(field)).toMatchObject({ code: 'HJ-TC-136', roundId: 'ROUND-OLD', file: '0403.pdf' })
    expect(attachmentPresentation(missingAttachment)).toBeNull()
    expect(attachmentPresentation(extensionOnly)).toMatchObject({ kind: 'pdf', attachmentId: 'ATT-EXT' })
  })
})
