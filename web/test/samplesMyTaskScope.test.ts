import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { expect, test, vi } from 'vitest'

const sample = {
  id: 'W260826-0', client: '任务单位', matrix: '废水', items: ['氨氮', '化学需氧量', '悬浮物'], status: 'testing', note: '',
  contract_id: 'WT2026-0005', round_id: 'WT2026-0005-R01', source: 'field', point_name: null,
  created_at: '2026-08-26T00:00:00.000Z',
}
const mine = {
  id: 1, sample_id: sample.id, analyte: '化学需氧量', assignee: '林工程师', assignee_username: 'demo_admin',
  assigned_by: '质控员', assigned_at: '2026-08-26T00:00:00.000Z', record_status: 'none',
}

vi.mock('../src/api', () => ({
  currentUser: ref({ username: 'demo_admin', name: '林工程师', roles: ['analyst'], status: 'active', created_at: '' }),
  hasRole: (...roles: string[]) => roles.includes('analyst'),
  HANDOVER_ACTIONS: [], PRETREAT_METHODS: [],
  api: {
    listSamples: vi.fn(async () => [sample]),
    listTasks: vi.fn(async (filter: { assignee?: string; sampleId?: string }) => filter.assignee === 'me' ? [mine] : [mine]),
    listWorkflowAssignments: vi.fn(async () => []),
    getSample: vi.fn(async () => sample),
    listHandovers: vi.fn(async () => []), listPretreatments: vi.fn(async () => []), getRetention: vi.fn(async () => null),
  },
}))
vi.mock('../src/permissions', () => ({ can: (permission: string) => permission === 'record_save' }))
vi.mock('../src/utils/dirty', () => ({ confirmIfDirty: vi.fn(async () => true) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))

import Samples from '../src/pages/Samples.vue'

test('我的任务按具体检测项目收口，不把同一样品上别人的项目混进来', async () => {
  const wrapper = mount(Samples, {
    global: {
      stubs: {
        'el-button': { template: '<button><slot /></button>' }, 'el-pagination': true, 'el-icon': true, 'el-tag': true,
        ArrowRight: true, RecordAttachments: true, BatchEntry: true, SymbolInput: true, StructuredSheet: true,
      },
      directives: { loading: () => undefined },
    },
  })
  await flushPromises()

  const mineChip = wrapper.get('.chip.mine')
  expect(mineChip.classes()).toContain('on')
  expect(mineChip.text()).toContain('我的检测任务')
  const card = wrapper.get('.item')
  expect(card.text()).toContain('化学需氧量')
  expect(card.text()).not.toContain('氨氮')
  expect(card.text()).not.toContain('悬浮物')

  await card.trigger('click')
  await flushPromises()
  expect(wrapper.get('.dsub').text()).toContain('化学需氧量')
  expect(wrapper.get('.dsub').text()).not.toContain('氨氮')
  const blocker = wrapper.get('[data-lab-assignment-blocker]')
  expect(blocker.text()).toContain('实验室复核人和审核人')
  expect(blocker.get('[data-go-reviewer-assignment]').attributes('href')).toContain('/plans?stage=dispatch')
})

test('我的检测任务搜索只匹配本人负责的项目', async () => {
  const wrapper = mount(Samples, {
    global: {
      stubs: {
        'el-button': { template: '<button><slot /></button>' }, 'el-pagination': true, 'el-icon': true, 'el-tag': true,
        ArrowRight: true, RecordAttachments: true, BatchEntry: true, SymbolInput: true, StructuredSheet: true,
      },
      directives: { loading: () => undefined },
    },
  })
  await flushPromises()

  await wrapper.get('.search').setValue('氨氮')
  expect(wrapper.find('.item').exists()).toBe(false)
  await wrapper.get('.search').setValue('化学需氧量')
  expect(wrapper.find('.item').exists()).toBe(true)
})
