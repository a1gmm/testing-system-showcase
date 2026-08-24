import { flushPromises, mount } from '@vue/test-utils'
import { expect, test, vi } from 'vitest'

const records = [
  {
    id: 'project-legacy-record', serial: null, sample_id: 'PROJECT-SAMPLE', template_code: 'HJ-TC-903', template_name: '化学需氧量',
    sheet_type: '', method: '重铬酸盐法', analyte: 'COD', matrix: '废水', instrument_id: null,
    data: { rows: [], meta: {} }, status: 'migration_required', reviewer: null, reviewed_at: null,
    approver: null, approved_at: null, reject_reason: null, updated_at: '2026-08-22T00:00:00.000Z',
  },
  {
    id: 'approved-record', serial: null, sample_id: 'APPROVED-SAMPLE', template_code: 'HJ-TC-904', template_name: '氨氮',
    sheet_type: '', method: '纳氏试剂法', analyte: '氨氮', matrix: '废水', instrument_id: null,
    data: { rows: [], meta: {} }, status: 'approved', reviewer: '复核员', reviewed_at: '2026-08-22T00:00:00.000Z',
    approver: '审核员', approved_at: '2026-08-22T00:00:00.000Z', reject_reason: null, updated_at: '2026-08-22T00:00:00.000Z',
  },
]

vi.mock('../src/api', () => ({
  api: {
    listRecordsByStatus: vi.fn(async () => records),
    getAudit: vi.fn(async () => []),
    listAudit: vi.fn(async () => []),
  },
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))

import Archive from '../src/pages/Archive.vue'

test('归档页将待迁移记录显示为注意状态并可独立筛选', async () => {
  const wrapper = mount(Archive, {
    global: {
      stubs: {
        'el-button': { template: '<button><slot /></button>' },
        'el-pagination': { template: '<div />' },
      },
      directives: { loading: () => undefined },
    },
  })
  await flushPromises()

  const projectRow = wrapper.findAll('.item').find(item => item.text().includes('PROJECT-SAMPLE'))
  expect(projectRow).toBeTruthy()
  expect(projectRow!.find('.rst').text()).toBe('待迁移')
  expect(projectRow!.find('.sdot').classes()).toContain('warn')

  const migrationFilter = wrapper.findAll('.chip').find(chip => chip.text() === '待迁移')
  expect(migrationFilter).toBeTruthy()
  await migrationFilter!.trigger('click')

  expect(wrapper.findAll('.item')).toHaveLength(1)
  expect(wrapper.find('.item').text()).toContain('PROJECT-SAMPLE')
  expect(wrapper.text()).not.toContain('APPROVED-SAMPLE')
})
