import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { expect, test, vi } from 'vitest'

const fixtures = vi.hoisted(() => ({
  sample: {
    id: 'PROJECT-SAMPLE', client: '任务迁移厂', matrix: '废水', items: ['COD'], status: 'testing', note: '',
    contract_id: 'WT2026-0999', round_id: 'WT2026-0999-R1', source: 'field', point_name: null,
    created_at: '2026-08-22T00:00:00.000Z',
  },
  task: {
    id: 903, sample_id: 'PROJECT-SAMPLE', analyte: 'COD', assignee: '项目分析员', assignee_username: 'project-analyst',
    assigned_by: '质控员', assigned_at: '2026-08-22T00:00:00.000Z', record_status: 'migration_required',
  },
}))

vi.mock('../src/api', () => ({
  currentUser: ref({ username: 'viewer', name: '查看员', roles: [], status: 'active', created_at: '' }),
  hasRole: () => false,
  HANDOVER_ACTIONS: [],
  PRETREAT_METHODS: [],
  api: {
    listSamples: vi.fn(async () => [fixtures.sample]),
    listTasks: vi.fn(async (filter: { sampleId?: string }) => filter.sampleId ? [fixtures.task] : []),
    getSample: vi.fn(async () => fixtures.sample),
    listHandovers: vi.fn(async () => []),
    listPretreatments: vi.fn(async () => []),
    getRetention: vi.fn(async () => null),
  },
}))
vi.mock('../src/permissions', () => ({ can: () => false }))
vi.mock('../src/utils/dirty', () => ({ confirmIfDirty: vi.fn(async () => true) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))

import Samples from '../src/pages/Samples.vue'

test('样品任务行将待迁移状态显示为中文注意态而非成功态', async () => {
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
        StructuredSheet: true,
      },
      directives: { loading: () => undefined },
    },
  })
  await flushPromises()

  await wrapper.find('.item').trigger('click')
  await flushPromises()
  const taskStep = wrapper.findAll('button.step-h').find(button => button.text().includes('检测任务派工'))
  expect(taskStep).toBeTruthy()
  await taskStep!.trigger('click')

  const taskStatus = wrapper.findAll('.ho-ev').find(row => row.text().includes('COD'))!.find('.ho-f')
  expect(taskStatus.text()).toBe('待迁移')
  expect(taskStatus.classes()).toContain('warn')
  expect(taskStatus.classes()).not.toContain('good')
})
