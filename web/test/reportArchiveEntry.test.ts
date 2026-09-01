import { flushPromises, shallowMount } from '@vue/test-utils'
import { ref } from 'vue'
import { expect, test, vi } from 'vitest'

vi.mock('vue-router', () => ({ useRoute: () => ({ query: { queue: 'final' } }) }))
const mocks = vi.hoisted(() => {
  const report = {
    id: 'BG2026-0001', sample_id: null, round_id: 'R-1', contract_id: 'WT-1', client: '甲厂', title: '甲厂检测报告',
    conclusion: '', data: { round: { no: 1, due: '2026-08-31' }, results: [] }, status: 'issued', checker: '复核员',
    checked_at: '2026-08-31T10:00:00.000Z', issuer: '签字人', issued_at: '2026-08-31T11:00:00.000Z',
    created_at: '2026-08-31T09:00:00.000Z', archive_package_id: 'ARCHIVE-1', voided: 0,
  }
  return { roles: ['report_editor'] as string[], report, api: {
    listReports: vi.fn().mockResolvedValue([report]), listRecordsByStatus: vi.fn().mockResolvedValue([]),
    listAllRounds: vi.fn().mockResolvedValue([]), listSamples: vi.fn().mockResolvedValue([]),
    listArchivePackages: vi.fn().mockResolvedValue([]), listReportBatches: vi.fn().mockResolvedValue([]),
    getWorkflow: vi.fn().mockResolvedValue(null), listWorkflowAssignments: vi.fn().mockResolvedValue([]),
    listReportDeliveries: vi.fn().mockResolvedValue([]),
  } }
})
vi.mock('../src/api', () => ({
  api: mocks.api,
  currentUser: ref({ username: 'editor', name: '报告员', roles: ['report_editor'] }),
  hasRole: (...roles: string[]) => mocks.roles.includes('admin') || roles.some(role => mocks.roles.includes(role)),
}))

import Reports from '../src/pages/Reports.vue'

test('报告详情直接打开自动汇编的完整电子原始记录册', async () => {
  mocks.roles = ['report_editor']
  const wrapper = shallowMount(Reports)
  await flushPromises()
  await wrapper.get('.item').trigger('click')
  await flushPromises()

  const entry = wrapper.get('[data-view-report-archive="BG2026-0001"]')
  expect(entry.text()).toContain('查看完整电子原始记录')
  expect(entry.attributes('href')).toBe('/reports/BG2026-0001/original-records')
})

test('报告没有冻结归档或当前岗位无权查看时不显示入口', async () => {
  mocks.api.listReports.mockResolvedValueOnce([{ ...mocks.report, archive_package_id: null }])
  const noArchive = shallowMount(Reports)
  await flushPromises()
  await noArchive.get('.item').trigger('click')
  await flushPromises()
  expect(noArchive.find('[data-view-report-archive]').exists()).toBe(false)

  mocks.roles = ['business']
  mocks.api.listReports.mockResolvedValueOnce([mocks.report])
  const forbidden = shallowMount(Reports)
  await flushPromises()
  await forbidden.get('.item').trigger('click')
  await flushPromises()
  expect(forbidden.find('[data-view-report-archive]').exists()).toBe(false)
})
