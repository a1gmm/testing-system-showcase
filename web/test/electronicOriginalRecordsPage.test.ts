import { flushPromises, shallowMount } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'

const routeState = vi.hoisted(() => ({
  name: 'report-original-records',
  params: { id: 'BG2026-0001' },
}))
vi.mock('vue-router', () => ({ useRoute: () => routeState }))

const mocks = vi.hoisted(() => ({
  getReport: vi.fn(),
  getArchivePackage: vi.fn(),
  attachmentUrl: vi.fn((id: string) => `/api/attachments/file/${id}`),
}))
vi.mock('../src/api', () => ({
  api: mocks,
  currentUser: { value: { username: 'editor', name: '报告员', roles: ['report_editor'] } },
}))

import ElectronicOriginalRecords from '../src/pages/ElectronicOriginalRecords.vue'

const report = {
  id: 'BG2026-0001', sample_id: null, round_id: 'R-1', contract_id: 'WT-1', client: '甲厂', title: '甲厂检测报告',
  conclusion: '符合', data: {}, status: 'issued', checker: '复核员', checked_at: '2026-08-31T10:00:00.000Z',
  issuer: '签字人', issued_at: '2026-08-31T11:00:00.000Z', created_at: '2026-08-31T09:00:00.000Z',
  archive_package_id: 'ARCHIVE-1', voided: 0,
}
const item = (id: number, entityType: string, label: string, snapshot: Record<string, unknown>, decisions: unknown[] = []) => ({
  id, archive_package_id: 'ARCHIVE-1', item_order: id, entity_type: entityType, entity_id: `${entityType}-${id}`,
  workflow_instance_id: entityType.endsWith('_workflow') ? `WF-${id}` : null,
  revision: entityType.endsWith('_workflow') ? 2 : null, content_hash: String(id).repeat(64).slice(0, 64), label,
  metadata: { snapshot, decisions },
})
const archive = {
  id: 'ARCHIVE-1', contract_id: 'WT-1', report_batch_id: null, version: 3, status: 'confirmed',
  manifest_sha256: 'a'.repeat(64), readiness: { ready: true, contractId: 'WT-1', reportBatchId: null, roundIds: ['R-1'], issues: [] },
  created_by: 'archivist', created_at: '2026-08-31T08:00:00.000Z', confirmed_by: 'archivist',
  confirmed_at: '2026-08-31T08:30:00.000Z', invalidated_by: null, invalidated_at: null, invalidation_reason: null,
  items: [
    item(1, 'contract', '委托合同 WT-1', { id: 'WT-1', client: '甲厂' }),
    item(2, 'round_sheet', 'HJ-TC-136 现场采样原始记录', { round_id: 'R-1', template_code: 'HJ-TC-136', data: { rows: [{ point: '1#排口' }], meta: { signer: '采样员' } } }),
    item(3, 'lab_record_workflow', 'COD 检测原始记录', { record: { sampleId: 'W260831-1', templateCode: 'HJ-TC-103', templateName: '化学需氧量(CODcr)', analyte: '化学需氧量', matrix: '废水', method: '重铬酸盐法', sheetType: '原始记录', data: { rows: [{ id: 'W260831-1' }], meta: { signer: '分析员' } } } }, [{ level: 'review', decided_by: 'reviewer', decided_at: '2026-08-31T07:00:00.000Z' }]),
    item(4, 'attachment', '色谱图.pdf', { id: 'ATT-PDF', entity_type: 'record', orig_name: '色谱图.pdf', mime: 'application/pdf' }),
    item(5, 'attachment', '现场照片.jpg', { id: 'ATT-IMG', entity_type: 'round_sheet', orig_name: '现场照片.jpg', mime: 'image/jpeg' }),
    item(6, 'audit_entry', '报告签批留痕', { action: 'approve', who: '审核员' }),
  ],
}

beforeEach(() => {
  routeState.name = 'report-original-records'
  routeState.params.id = 'BG2026-0001'
  mocks.getReport.mockReset().mockResolvedValue(report)
  mocks.getArchivePackage.mockReset().mockResolvedValue(archive)
  mocks.attachmentUrl.mockClear()
})

test('报告入口自动读取精确冻结版本并连续呈现全部电子原始记录', async () => {
  const print = vi.spyOn(window, 'print').mockImplementation(() => undefined)
  const wrapper = shallowMount(ElectronicOriginalRecords)
  await flushPromises()

  expect(mocks.getReport).toHaveBeenCalledWith('BG2026-0001')
  expect(mocks.getArchivePackage).toHaveBeenCalledWith('ARCHIVE-1')
  const book = wrapper.get('[data-electronic-record-book="ARCHIVE-1"]')
  expect(book.text()).toContain('完整电子原始记录册')
  expect(book.text()).toContain('BG2026-0001')
  expect(book.text()).toContain('归档版本 3')
  expect(book.text()).toContain('共 6 项冻结记录')
  expect(wrapper.findAll('[data-record-book-item]')).toHaveLength(6)
  expect(wrapper.get('[data-record-book-stage="5"]').text()).toContain('现场采样')
  expect(wrapper.get('[data-record-book-stage="8"]').text()).toContain('实验室分析')
  expect(wrapper.get('[data-frozen-sheet-host="3"]').attributes('data-template-file')).toBe('0100.pdf')
  expect(wrapper.get('[data-record-book-pdf="ATT-PDF"]').attributes('src')).toBe('/api/attachments/file/ATT-PDF')
  expect(wrapper.get('[data-record-book-image="ATT-IMG"]').attributes('src')).toBe('/api/attachments/file/ATT-IMG')
  await wrapper.get('[data-print-record-book]').trigger('click')
  expect(print).toHaveBeenCalledOnce()
  print.mockRestore()
})

test('历史报告没有冻结归档时如实说明，绝不伪装成完整记录册', async () => {
  mocks.getReport.mockResolvedValueOnce({ ...report, archive_package_id: null })
  const wrapper = shallowMount(ElectronicOriginalRecords)
  await flushPromises()

  expect(wrapper.get('[role="alert"]').text()).toContain('该历史报告未绑定第 1–8 步冻结归档')
  expect(mocks.getArchivePackage).not.toHaveBeenCalled()
  expect(wrapper.find('[data-electronic-record-book]').exists()).toBe(false)
})

test('归档直达保留已失效历史版本、报告批次范围和其他原文件下载', async () => {
  routeState.name = 'archive-original-records'
  routeState.params.id = 'ARCHIVE-OLD'
  mocks.getArchivePackage.mockResolvedValueOnce({
    ...archive,
    id: 'ARCHIVE-OLD',
    report_batch_id: 'BATCH-2',
    status: 'invalidated',
    items: [item(7, 'attachment', '仪器原始文件.docx', { id: 'ATT-DOC', orig_name: '仪器原始文件.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })],
  })

  const wrapper = shallowMount(ElectronicOriginalRecords)
  await flushPromises()

  expect(mocks.getReport).not.toHaveBeenCalled()
  expect(mocks.getArchivePackage).toHaveBeenCalledWith('ARCHIVE-OLD')
  expect(wrapper.text()).toContain('报告批次 BATCH-2')
  expect(wrapper.text()).toContain('历史冻结版本')
  expect(wrapper.text()).toContain('该格式使用原文件查看')
  expect(wrapper.get('.file-action').attributes('href')).toBe('/api/attachments/file/ATT-DOC')
})

test('缺少编号、非冻结版本和接口错误都给出可恢复的人话提示', async () => {
  routeState.params.id = ''
  const missingId = shallowMount(ElectronicOriginalRecords)
  await flushPromises()
  expect(missingId.get('[role="alert"]').text()).toContain('缺少报告或归档版本编号')

  routeState.params.id = 'BG2026-0001'
  mocks.getReport.mockResolvedValueOnce(report)
  mocks.getArchivePackage.mockResolvedValueOnce({ ...archive, status: 'ready' })
  const notFrozen = shallowMount(ElectronicOriginalRecords)
  await flushPromises()
  expect(notFrozen.get('[role="alert"]').text()).toContain('只有已冻结的归档版本')

  mocks.getReport.mockRejectedValueOnce({ response: { data: { error: '报告读取暂时失败，请稍后重试' } } })
  const apiFailure = shallowMount(ElectronicOriginalRecords)
  await flushPromises()
  expect(apiFailure.get('[role="alert"]').text()).toContain('报告读取暂时失败，请稍后重试')
})

test('历史模板不存在时明确提示版式未匹配并仍展示冻结原始值', async () => {
  mocks.getArchivePackage.mockResolvedValueOnce({
    ...archive,
    items: [item(8, 'lab_record_workflow', '历史检测原始记录', {
      record: { sampleId: 'W260831-9', templateCode: 'HJ-OLD-001', analyte: '历史项目', data: { rows: [{ value: '12.3' }], meta: { signer: '老分析员' } } },
    })],
  })

  const wrapper = shallowMount(ElectronicOriginalRecords)
  await flushPromises()

  const host = wrapper.get('[data-frozen-sheet-host="8"]')
  expect(host.text()).toContain('未匹配到电子表格版式')
  expect(host.findComponent({ name: 'ArchiveValue' }).props('value')).toMatchObject({ rows: [{ value: '12.3' }] })
  expect(host.findComponent({ name: 'StructuredSheet' }).exists()).toBe(false)
})
