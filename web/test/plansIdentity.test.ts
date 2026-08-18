import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  assignRound: vi.fn(async () => ({})),
  round: {
  id: 'ROUND-WEB-ID', contract_id: 'C1', round_no: 1, due_date: '2026-08-01', status: 'pending',
  plan_id: null, sampler: '同名采样员、同名采样员', sampler_ids: ['same-a', 'same-b'], assignment_status: 'active',
  plan_date: '2026-08-01', sampled_at: null, created_at: '2026-08-01', bucket: 'overdue', client: '客户', project: '项目',
  field_info: {
    confirmations: { 'same-a': { name: '同名采样员', at: '2026-08-01T09:00:00.000Z' } },
    confirms: { '同名采样员': '2026-08-01T09:00:00.000Z' },
    confirmation_users: [
      { user_id: 'same-a', name: '同名采样员', confirmed_at: '2026-08-01T09:00:00.000Z' },
      { user_id: 'same-b', name: '同名采样员', confirmed_at: null },
    ],
  },
  },
}))

vi.mock('../src/api', () => ({
  currentUser: { value: { username: 'same-b', name: '同名采样员', roles: ['sampler', 'qc'], status: 'active', created_at: '' } },
  QC_TYPES: [], UNIT_OPTS: [],
  api: {
    listAllRounds: vi.fn(async () => [mocks.round]),
    listSamplers: vi.fn(async () => [
      { username: 'same-a', name: '同名采样员' },
      { username: 'same-b', name: '同名采样员' },
    ]),
    getRoundDetail: vi.fn(async () => ({ round: mocks.round, contract: { client: '客户', scheme: { points: [] } }, planItems: [], samples: [] })),
    roundQcReqs: vi.fn(async () => []), listRoundQc: vi.fn(async () => []), listContractPoints: vi.fn(async () => []),
    listCheckouts: vi.fn(async () => []), assignRound: mocks.assignRound,
  },
}))
vi.mock('../src/permissions', () => ({ can: vi.fn(() => true) }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('../src/utils/dirty', () => ({ confirmIfDirty: vi.fn(async () => true) }))

import Plans from '../src/pages/Plans.vue'

const stubs = {
  'el-select': { props: ['modelValue'], template: '<div data-el-select><slot /></div>' },
  'el-option': { props: ['label', 'value'], template: '<span class="option" :data-label="label" :data-value="value" />' },
  'el-button': { template: '<button><slot /></button>' },
  RecordAttachments: true,
  StructuredSheet: true,
}

beforeEach(() => mocks.assignRound.mockClear())

test('Plans 以 sampler ID 初始化改派并区分同名选项；确认按钮和状态按 user ID 判断', async () => {
  const wrapper = mount(Plans, { global: { stubs } })
  await flushPromises()
  await wrapper.find('.item.ingrp').trigger('click')
  await flushPromises()

  const select = wrapper.findComponent('[data-el-select]')
  expect(select.props('modelValue')).toEqual(['same-a', 'same-b'])
  expect(wrapper.findAll('.option').map(x => [x.attributes('data-label'), x.attributes('data-value')])).toEqual([
    ['同名采样员（same-a）', 'same-a'],
    ['同名采样员（same-b）', 'same-b'],
  ])
  const confirms = wrapper.findAll('[data-confirm-user-id]')
  expect(confirms).toHaveLength(2)
  expect(confirms[0].classes()).toContain('ok')
  expect(confirms[1].classes()).not.toContain('ok')
  expect(wrapper.text()).toContain('我确认采样表无误')
})
