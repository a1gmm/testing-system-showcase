import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ roles: ['archivist'] as string[], listArchivePackages: vi.fn(), listProjects: vi.fn(), listReportBatches: vi.fn(), getArchiveReadiness: vi.fn(), getArchivePackage: vi.fn(), buildArchivePackage: vi.fn(), confirmArchivePackage: vi.fn(), attachmentUrl: vi.fn((id: string) => `/api/attachments/file/${id}`) }))
vi.mock('../src/api', () => ({
  currentUser: ref({ username: 'archivist', name: '档案员', roles: ['archivist'] }),
  hasRole: (...roles: string[]) => mocks.roles.includes('admin') || roles.some(role => mocks.roles.includes(role)),
  api: mocks,
}))
import ArchivePackages from '../src/pages/ArchivePackages.vue'

const pkg = (id: string, contractId: string, status: string, reportBatchId: string | null = null, version = 1) => ({
  id, contract_id: contractId, report_batch_id: reportBatchId, version, status, manifest_sha256: 'hash',
  readiness: { ready: true, contractId, reportBatchId, roundIds: [], issues: [] }, items: [],
  created_by: 'archivist', created_at: '2026-08-22T00:00:00.000Z', confirmed_by: status === 'confirmed' ? 'archivist' : null,
  confirmed_at: status === 'confirmed' ? '2026-08-22T01:00:00.000Z' : null, invalidated_by: status === 'invalidated' ? 'planner' : null,
  invalidated_at: status === 'invalidated' ? '2026-08-22T02:00:00.000Z' : null, invalidation_reason: status === 'invalidated' ? '上游撤回' : null,
})

beforeEach(() => {
  window.history.replaceState({}, '', '/')
  mocks.roles = ['archivist']
  const blocked = pkg('draft-1', 'WT-2', 'draft')
  blocked.readiness = { ready: false, contractId: 'WT-2', reportBatchId: null, roundIds: [], issues: [{ code: 'LAB_PENDING', message: '实验室分析还有 2 份记录待审核，暂不能归档' }] }
  mocks.listArchivePackages.mockReset().mockResolvedValue([pkg('confirmed-1', 'WT-3', 'confirmed'), pkg('invalid-1', 'WT-4', 'invalidated'), blocked])
  mocks.listProjects.mockReset().mockResolvedValue([{ id: 'WT-1', client: '甲厂' }, { id: 'WT-2', client: '乙厂' }, { id: 'WT-3', client: '丙厂' }, { id: 'WT-4', client: '丁厂' }])
  mocks.listReportBatches.mockReset().mockResolvedValue([])
  mocks.getArchiveReadiness.mockReset().mockImplementation(async (id: string, reportBatchId?: string) => id === 'WT-1'
    ? { ready: true, contractId: id, reportBatchId: reportBatchId || null, roundIds: [], issues: [] }
    : { ready: false, contractId: id, reportBatchId: reportBatchId || null, roundIds: [], issues: [{ code: 'LAB_PENDING', message: '实验室分析还有 2 份记录待审核，暂不能归档' }] })
  mocks.getArchivePackage.mockReset()
  mocks.buildArchivePackage.mockReset()
  mocks.confirmArchivePackage.mockReset()
})

test('报告深链直接打开其绑定的冻结归档版本，无需用户再次查找项目', async () => {
  const direct = pkg('archive-from-report', 'WT-9', 'confirmed')
  direct.items = [{
    id: 90, archive_package_id: direct.id, item_order: 1, entity_type: 'lab_record_workflow', entity_id: 'LAB-9',
    workflow_instance_id: 'WF-LAB-9', revision: 2, content_hash: '9'.repeat(64), label: 'COD检测原始记录 · S-009',
    metadata: { snapshot: { record: { sampleId: 'S-009', analyte: 'COD' } } },
  }]
  mocks.getArchivePackage.mockResolvedValueOnce(direct)
  window.history.replaceState({}, '', '/archive-packages?archive=archive-from-report&report=BG2026-0009')

  const wrapper = mount(ArchivePackages, { global: { directives: { loading: () => undefined } } })
  await flushPromises()

  expect(mocks.getArchivePackage).toHaveBeenCalledWith('archive-from-report')
  expect(wrapper.get('[data-archive-manifest="archive-from-report"]').text()).toContain('COD检测原始记录 · S-009')
})

test('项目与报告批次按精确 scope 核验，失效版本修正后可构建同 scope 新版本且历史不丢', async () => {
  mocks.listProjects.mockResolvedValueOnce([{ id: 'WT-1', client: '甲厂' }])
  mocks.listReportBatches.mockResolvedValueOnce([{ id: 'BATCH-1', contract_id: 'WT-1', name: '第一批报告', created_by: 'editor', created_at: '', round_ids: ['R-1'] }])
  mocks.listArchivePackages.mockResolvedValueOnce([
    pkg('batch-invalid-v2', 'WT-1', 'invalidated', 'BATCH-1', 2),
    pkg('batch-confirmed-v1', 'WT-1', 'confirmed', 'BATCH-1', 1),
  ])
  mocks.getArchiveReadiness.mockImplementation(async (contractId: string, reportBatchId?: string) => ({
    ready: true, contractId, reportBatchId: reportBatchId || null, roundIds: reportBatchId ? ['R-1'] : ['R-1', 'R-2'], issues: [],
  }))
  const wrapper = mount(ArchivePackages, { global: { directives: { loading: () => undefined } } })
  await flushPromises()

  expect(wrapper.text()).toContain('第一批报告')
  expect(wrapper.text()).toContain('版本 1')
  expect(wrapper.text()).toContain('版本 2')
  expect(wrapper.text()).toContain('上游已修正，可以构建新版本')
  await wrapper.get('[data-rebuild-scope="WT-1::BATCH-1"]').trigger('click')
  await flushPromises()
  expect(mocks.buildArchivePackage).toHaveBeenCalledWith('WT-1', 'BATCH-1')
})

test('归档页并列呈现可归档、阻塞、已确认和已失效状态，阻塞原因直接可见', async () => {
  const wrapper = mount(ArchivePackages, { global: { directives: { loading: () => undefined } } })
  await flushPromises()
  expect(wrapper.text()).toContain('待归档')
  expect(wrapper.text()).toContain('阻塞')
  expect(wrapper.text()).toContain('已确认归档')
  expect(wrapper.text()).toContain('已失效')
  expect(wrapper.text()).toContain('实验室分析还有 2 份记录待审核，暂不能归档')
})

test('已确认归档提供连续查看电子记录册入口', async () => {
  const wrapper = mount(ArchivePackages, { global: { directives: { loading: () => undefined } } })
  await flushPromises()

  const entry = wrapper.get('[data-open-electronic-record-book="confirmed-1"]')
  expect(entry.text()).toContain('连续查看电子记录册')
  expect(entry.attributes('href')).toBe('/archive-packages/confirmed-1/original-records')
  expect(wrapper.get('[data-open-electronic-record-book="invalid-1"]').attributes('href')).toBe('/archive-packages/invalid-1/original-records')
  expect(wrapper.find('[data-open-electronic-record-book="draft-1"]').exists()).toBe(false)
})

test('归档阻断按问题类型给出可操作入口', async () => {
  mocks.listArchivePackages.mockResolvedValueOnce([])
  mocks.listProjects.mockResolvedValueOnce([{ id: 'WT-5', client: '入口测试厂' }])
  mocks.getArchiveReadiness.mockResolvedValueOnce({
    ready: false, contractId: 'WT-5', reportBatchId: null, roundIds: [], issues: [
      { code: 'ASSIGNMENT_NOT_ACTIVE', entityId: 'laboratory', message: 'laboratory 专业缺少当前有效复核/审核指派' },
      { code: 'LAB_RECORD_MISSING', entityId: 'W1:氨氮', message: '检测项目 氨氮 尚无实验室记录' },
    ],
  })
  const wrapper = mount(ArchivePackages, { global: { directives: { loading: () => undefined } } })
  await flushPromises()

  expect(wrapper.get('[data-fix-assignments]').attributes('href')).toContain('/plans?stage=dispatch')
  expect(wrapper.get('[data-fix-laboratory]').attributes('href')).toContain('/samples?stage=laboratory')
})

test('只有档案管理员能看到确认归档主动作', async () => {
  mocks.listArchivePackages.mockResolvedValueOnce([pkg('ready-1', 'WT-3', 'ready')])
  mocks.listProjects.mockResolvedValueOnce([{ id: 'WT-3', client: '丙厂' }])
  const wrapper = mount(ArchivePackages, { global: { directives: { loading: () => undefined } } })
  await flushPromises()
  expect(wrapper.find('[data-confirm-archive="ready-1"]').exists()).toBe(true)

  mocks.roles = ['report_editor']
  const readOnly = mount(ArchivePackages, { global: { directives: { loading: () => undefined } } })
  await flushPromises()
  expect(readOnly.find('[data-confirm-archive="ready-1"]').exists()).toBe(false)
})

test('已确认归档向只读角色提供查看全部清单入口并显示冻结版本资料', async () => {
  const confirmed = pkg('confirmed-1', 'WT-3', 'confirmed')
  confirmed.items = [
    {
      id: 1, archive_package_id: confirmed.id, item_order: 1, entity_type: 'contract', entity_id: 'WT-3',
      workflow_instance_id: null, revision: null, content_hash: 'a'.repeat(64), label: '委托合同 WT-3',
      metadata: { snapshot: { accepted_at: '2026-08-22T01:00:00.000Z', created_at: '2026-08-21T00:00:00.000Z', review_info: { ability: '具备' } } },
    },
    {
      id: 2, archive_package_id: confirmed.id, item_order: 2, entity_type: 'lab_record_workflow', entity_id: 'LAB-1',
      workflow_instance_id: 'WF-LAB-1', revision: 4, content_hash: 'b'.repeat(64), label: 'COD检测原始记录 · S-001',
      metadata: {
        snapshot: { record: { id: 'LAB-1', serial: 'JL-001', sampleId: 'S-001', templateCode: 'HJ-TC-103', analyte: 'COD', method: '重铬酸盐法', data: { meta: { analysisDate: '2026-08-22', analyst: '陈检测' }, resultSummary: { analyte: 'COD', value: 20, unit: 'mg/L' }, rows: [{ absorbance: 0.123, dilution: 1 }] } } },
        decisions: [{ revision: 4, level: 'approve', decision: 'approve', comment: '审核通过', decided_by: 'demo_tech', decided_at: '2026-08-22T02:00:00.000Z' }],
      },
    },
    { id: 3, archive_package_id: confirmed.id, item_order: 3, entity_type: 'contract_review', entity_id: 'WT-3', workflow_instance_id: null, revision: null, content_hash: 'c'.repeat(64), label: '技术合同评审 WT-3', metadata: { snapshot: { result: 'approve' } } },
    { id: 4, archive_package_id: confirmed.id, item_order: 4, entity_type: 'scheme', entity_id: 'FA-3', workflow_instance_id: null, revision: null, content_hash: 'd'.repeat(64), label: '已批准监测方案 FA-3', metadata: { snapshot: { points: [] } } },
    { id: 5, archive_package_id: confirmed.id, item_order: 5, entity_type: 'round', entity_id: 'R-1', workflow_instance_id: null, revision: null, content_hash: 'e'.repeat(64), label: '采样指派与监测期次 R-1', metadata: { snapshot: { sampler: '赵采样' } } },
    { id: 6, archive_package_id: confirmed.id, item_order: 6, entity_type: 'sampling_workflow', entity_id: 'R-1', workflow_instance_id: 'WF-S-1', revision: 1, content_hash: 'f'.repeat(64), label: '现场采样整期批准记录', metadata: { snapshot: { roundSheets: [] } } },
    { id: 7, archive_package_id: confirmed.id, item_order: 7, entity_type: 'handover_sheet', entity_id: 'JJ-1', workflow_instance_id: null, revision: null, content_hash: '1'.repeat(64), label: '样品交接单 JJ-1', metadata: { snapshot: { status: 'confirmed' } } },
    { id: 8, archive_package_id: confirmed.id, item_order: 8, entity_type: 'quality_plan_workflow', entity_id: 'R-1', workflow_instance_id: 'WF-Q-1', revision: 1, content_hash: '2'.repeat(64), label: '质量安排批准记录', metadata: { snapshot: { requirements: [] } } },
    { id: 9, archive_package_id: confirmed.id, item_order: 9, entity_type: 'report_batch', entity_id: 'B-1', workflow_instance_id: null, revision: null, content_hash: '3'.repeat(64), label: '报告批次 第一批报告', metadata: { snapshot: { name: '第一批报告' } } },
  ]
  mocks.roles = ['report_editor']
  mocks.listArchivePackages.mockResolvedValueOnce([confirmed])
  mocks.listProjects.mockResolvedValueOnce([{ id: 'WT-3', client: '丙厂' }])

  const wrapper = mount(ArchivePackages, { global: { directives: { loading: () => undefined } } })
  await flushPromises()

  const viewButton = wrapper.get('[data-view-archive="confirmed-1"]')
  expect(viewButton.text()).toContain('查看全部 9 项')
  await viewButton.trigger('click')

  const manifest = wrapper.get('[data-archive-manifest="confirmed-1"]')
  expect(manifest.text()).toContain('委托合同 WT-3')
  expect(manifest.text()).toContain('COD检测原始记录 · S-001')
  expect(manifest.text()).toContain('定稿版本 4')
  expect(manifest.get('[data-archive-stage="1"]').text()).toContain('委托与合同')
  expect(manifest.get('[data-archive-stage="2"]').text()).toContain('合同评审')
  expect(manifest.get('[data-archive-stage="3"]').text()).toContain('监测方案')
  expect(manifest.get('[data-archive-stage="4"]').text()).toContain('采样指派')
  expect(manifest.get('[data-archive-stage="5"]').text()).toContain('现场采样')
  expect(manifest.get('[data-archive-stage="6"]').text()).toContain('样品交接')
  expect(manifest.get('[data-archive-stage="7"]').text()).toContain('质控')
  expect(manifest.get('[data-archive-stage="8"]').text()).toContain('实验室分析')
  expect(manifest.get('[data-archive-stage="audit"]').text()).toContain('1')
  const contractPreview = manifest.get('[data-archive-preview="1"]')
  expect(contractPreview.text()).toContain('受理时间')
  expect(contractPreview.text()).toContain('创建时间')
  expect(contractPreview.text()).toContain('合同评审内容')
  expect(contractPreview.text()).not.toContain('accepted at')

  await manifest.get('[data-archive-item="2"]').trigger('click')
  const preview = manifest.get('[data-archive-preview="2"]')
  expect(preview.text()).toContain('样品编号')
  expect(preview.text()).toContain('S-001')
  expect(preview.text()).toContain('检测项目')
  expect(preview.text()).toContain('COD')
  expect(preview.text()).toContain('20 mg/L')
  expect(preview.text()).toContain('分析日期')
  expect(preview.text()).toContain('分析人员')
  expect(preview.text()).toContain('吸光度')
  expect(preview.text()).toContain('稀释倍数')
  expect(preview.text()).toContain('审批环节审核')
  expect(preview.text()).not.toContain('absorbance')
})

test('已失效历史版本保留只读清单入口', async () => {
  const invalidated = pkg('invalid-1', 'WT-4', 'invalidated')
  invalidated.items = [{
    id: 3, archive_package_id: invalidated.id, item_order: 1, entity_type: 'contract', entity_id: 'WT-4',
    workflow_instance_id: null, revision: null, content_hash: 'c'.repeat(64), label: '委托合同 WT-4', metadata: { snapshot: {} },
  }]
  mocks.roles = ['report_editor']
  mocks.listArchivePackages.mockResolvedValueOnce([invalidated])
  mocks.listProjects.mockResolvedValueOnce([{ id: 'WT-4', client: '丁厂' }])

  const wrapper = mount(ArchivePackages, { global: { directives: { loading: () => undefined } } })
  await flushPromises()

  expect(wrapper.text()).toContain('上游撤回')
  await wrapper.get('[data-view-archive="invalid-1"]').trigger('click')
  expect(wrapper.get('[data-archive-manifest="invalid-1"]').text()).toContain('委托合同 WT-4')
})

test('空归档版本给出明确提示', async () => {
  mocks.roles = ['report_editor']
  mocks.listArchivePackages.mockResolvedValueOnce([pkg('empty-1', 'WT-5', 'confirmed')])
  mocks.listProjects.mockResolvedValueOnce([{ id: 'WT-5', client: '戊厂' }])

  const wrapper = mount(ArchivePackages, { global: { directives: { loading: () => undefined } } })
  await flushPromises()
  await wrapper.get('[data-view-archive="empty-1"]').trigger('click')

  expect(wrapper.get('[data-archive-manifest="empty-1"]').text()).toContain('该归档版本没有清单项')
})
