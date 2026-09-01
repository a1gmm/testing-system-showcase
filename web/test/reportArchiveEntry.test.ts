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
  return { api: {
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
  hasRole: (...roles: string[]) => roles.includes('report_editor'),
}))

import Reports from '../src/pages/Reports.vue'

test('报告详情提供明确的第1–8步原始档案入口并带入报告绑定的冻结版本', async () => {
  const wrapper = shallowMount(Reports)
  await flushPromises()
  await wrapper.get('.item').trigger('click')
  await flushPromises()

  const entry = wrapper.get('[data-view-report-archive="BG2026-0001"]')
  expect(entry.text()).toContain('查看第1–8步原始档案')
  expect(entry.attributes('href')).toBe('/archive-packages?archive=ARCHIVE-1&report=BG2026-0001')
})
