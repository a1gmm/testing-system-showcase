import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { expect, test, vi } from 'vitest'

const sample = {
  id: 'W260824-0', client: '搜索测试单位', matrix: '废水', items: ['COD'], status: 'testing', note: '',
  contract_id: 'WT2026-0003', round_id: 'WT2026-0003-R02', source: 'field', point_name: null,
  created_at: '2026-08-24T00:00:00.000Z',
}

vi.mock('../src/api', () => ({
  currentUser: ref({ username: 'viewer', name: '查看员', roles: [], status: 'active', created_at: '' }),
  hasRole: () => false,
  HANDOVER_ACTIONS: [],
  PRETREAT_METHODS: [],
  api: {
    listSamples: vi.fn(async () => [sample]),
    listTasks: vi.fn(async () => []),
    getSample: vi.fn(async () => sample),
    listHandovers: vi.fn(async () => []),
    listPretreatments: vi.fn(async () => []),
    getRetention: vi.fn(async () => null),
  },
}))
vi.mock('../src/permissions', () => ({ can: () => false }))
vi.mock('../src/utils/dirty', () => ({ confirmIfDirty: vi.fn(async () => true) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))

import Samples from '../src/pages/Samples.vue'

test('废水样品可搜索到未标注基质的 COD 原始记录表', async () => {
  const wrapper = mount(Samples, {
    global: {
      stubs: {
        'el-button': { template: '<button><slot /></button>' },
        'el-pagination': { template: '<div />' },
        'el-icon': { template: '<i><slot /></i>' },
        'el-tag': { template: '<span><slot /></span>' },
        'el-input': { template: '<input />' },
        ArrowRight: { template: '<i />' },
        RecordAttachments: true,
        BatchEntry: true,
        SymbolInput: true,
        StructuredSheet: {
          props: ['matrix'],
          template: '<div data-structured-sheet :data-matrix="matrix" />',
        },
      },
      directives: { loading: () => undefined },
    },
  })
  await flushPromises()

  await wrapper.get('.item').trigger('click')
  await flushPromises()

  expect(wrapper.get('.pk-list').text()).toContain('HJ-TC-103')
  await wrapper.get('.pk-search').setValue('HJ-TC-628')
  expect(wrapper.get('.pk-list').text()).toContain('HJ-TC-628')
  await wrapper.get('.pk-search').setValue('HJ-TC-355')
  expect(wrapper.get('.pk-list').text()).toContain('该基质下暂无匹配记录表')
  await wrapper.get('.pk-search').setValue('COD')

  expect(wrapper.get('.pk-list').text()).toContain('HJ-TC-103')
  await wrapper.get('.pk-item').trigger('click')
  expect(wrapper.get('[data-structured-sheet]').attributes('data-matrix')).toBe('废水')
})
