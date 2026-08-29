import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ roles: ['archivist'] as string[], listArchivePackages: vi.fn(), listProjects: vi.fn(), listReportBatches: vi.fn(), getArchiveReadiness: vi.fn(), buildArchivePackage: vi.fn(), confirmArchivePackage: vi.fn() }))
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
  mocks.roles = ['archivist']
  const blocked = pkg('draft-1', 'WT-2', 'draft')
  blocked.readiness = { ready: false, contractId: 'WT-2', reportBatchId: null, roundIds: [], issues: [{ code: 'LAB_PENDING', message: '实验室分析还有 2 份记录待审核，暂不能归档' }] }
  mocks.listArchivePackages.mockReset().mockResolvedValue([pkg('confirmed-1', 'WT-3', 'confirmed'), pkg('invalid-1', 'WT-4', 'invalidated'), blocked])
  mocks.listProjects.mockReset().mockResolvedValue([{ id: 'WT-1', client: '甲厂' }, { id: 'WT-2', client: '乙厂' }, { id: 'WT-3', client: '丙厂' }, { id: 'WT-4', client: '丁厂' }])
  mocks.listReportBatches.mockReset().mockResolvedValue([])
  mocks.getArchiveReadiness.mockReset().mockImplementation(async (id: string, reportBatchId?: string) => id === 'WT-1'
    ? { ready: true, contractId: id, reportBatchId: reportBatchId || null, roundIds: [], issues: [] }
    : { ready: false, contractId: id, reportBatchId: reportBatchId || null, roundIds: [], issues: [{ code: 'LAB_PENDING', message: '实验室分析还有 2 份记录待审核，暂不能归档' }] })
  mocks.buildArchivePackage.mockReset()
  mocks.confirmArchivePackage.mockReset()
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
