import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  currentUser: { value: { username: 'planner', name: '计划员', roles: ['planner'], status: 'active', created_at: '' } as any },
  scrollIntoView: vi.fn(),
}))

const confirmedSheet = {
  id: 'HO-1', round_id: 'ROUND-1', contract_id: 'WT-1', status: 'confirmed', client: '测试单位', project: '废水检测',
  sample_ids: ['S-1'], detail: [{ sampleId: 'S-1', items: ['氨氮'], rejected: false }], from_person: '采样员', from_at: '2026-08-24T08:00:00.000Z',
}

vi.mock('../src/api', () => ({
  currentUser: mocks.currentUser,
  api: {
    listHandoverSheets: vi.fn(async () => [confirmedSheet]),
    listTestNotices: vi.fn(async () => []),
    getWorkflow: vi.fn(async () => null),
    getQualityPlan: vi.fn(async () => ({
      id: 'QP-1', round_id: 'ROUND-1', contract_id: 'WT-1', author_username: 'quality-author',
      requirements: [], adjustments: [], status: 'draft', created_at: '2026-08-24T08:00:00.000Z', updated_at: '2026-08-24T08:00:00.000Z',
    })),
    listWorkflowAssignments: vi.fn(async () => []),
  },
}))
vi.mock('../src/permissions', () => ({
  can: vi.fn(() => false),
  PAGE_ROLES: { qc: ['sampler', 'sample_manager', 'qc', 'planner', 'tech'] },
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: { stage: 'quality', queue: 'write' } }) }))

import Qc from '../src/pages/Qc.vue'

const stubs = {
  'el-button': { template: '<button><slot /></button>' },
  'el-input': { template: '<input />' },
  'el-tag': { template: '<span><slot /></span>' },
  StageQueueNav: true,
  ProjectStageProgress: true,
  ProfessionalTaskQueue: true,
  WorkflowAssignmentEditor: {
    props: ['scopes', 'assignments'],
    emits: ['saved'],
    data: () => ({
      savedAssignment: {
        id: 7, contract_id: 'WT-1', scope: 'quality', reviewer_username: 'quality-review',
        approver_username: 'quality-approve', active: true, reason: null,
        assigned_by: 'planner', assigned_at: '2026-08-24T09:00:00.000Z',
      },
    }),
    template: `<fieldset data-assignment-scope="quality" tabindex="-1" :data-scopes="scopes.join(',')" :data-assignment-count="assignments.length">
      质控人员指定
      <button type="button" data-save-quality-assignment @click="$emit('saved', savedAssignment)">保存指定</button>
    </fieldset>`,
  },
}

beforeEach(() => {
  mocks.currentUser.value = { username: 'planner', name: '计划员', roles: ['planner'], status: 'active', created_at: '' }
  mocks.scrollIntoView.mockReset()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: mocks.scrollIntoView })
})

test('计划员在质控阻断提示中可直接定位到本项目的质控人员指定区', async () => {
  const wrapper = mount(Qc, { attachTo: document.body, global: { stubs, directives: { loading: () => undefined } } })
  await flushPromises()

  const action = wrapper.get('[data-qualification-action]')
  expect(action.text()).toBe('立即指定人员')
  await action.trigger('click')
  await flushPromises()

  const target = wrapper.get('[data-quality-assignment-target]')
  expect(target.get('[data-assignment-scope="quality"]').attributes('data-scopes')).toBe('quality')
  expect(document.activeElement).toBe(target.get('[data-assignment-scope="quality"]').element)
  expect(mocks.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  wrapper.unmount()
})

test('质控员看到责任角色和自身可操作范围，不显示越权指定按钮', async () => {
  mocks.currentUser.value = { username: 'quality-author', name: '吴质控', roles: ['qc', 'sample_manager'], status: 'active', created_at: '' }
  const wrapper = mount(Qc, { global: { stubs, directives: { loading: () => undefined } } })
  await flushPromises()

  expect(wrapper.text()).toContain('请联系计划员或管理员指定')
  expect(wrapper.text()).toContain('当前账号可编制质控安排和派检测任务，不能指定审核人员')
  expect(wrapper.find('[data-qualification-action]').exists()).toBe(false)
  expect(wrapper.find('[data-quality-assignment-target]').exists()).toBe(false)
})

test('其他质控员仍能看见已由同事编制的项目但不能修改质量计划', async () => {
  mocks.currentUser.value = { username: 'another-quality', name: '另一质控员', roles: ['qc'], status: 'active', created_at: '' }
  const wrapper = mount(Qc, { global: { stubs, directives: { loading: () => undefined } } })
  await flushPromises()

  expect(wrapper.get('.quality-select').text()).toContain('WT-1')
  expect(wrapper.text()).toContain('本质量计划由账号 quality-author 编制，本账号仅可查看')
  expect(wrapper.find('.adjustments').exists()).toBe(false)
})

test('计划员保存质控指定后立即解除当前项目的未指派阻断', async () => {
  const wrapper = mount(Qc, { global: { stubs, directives: { loading: () => undefined } } })
  await flushPromises()

  expect(wrapper.find('[data-qualification-action]').exists()).toBe(true)
  expect(wrapper.get('[data-assignment-scope="quality"]').attributes('data-assignment-count')).toBe('0')

  await wrapper.get('[data-save-quality-assignment]').trigger('click')
  await flushPromises()

  expect(wrapper.find('[data-qualification-action]').exists()).toBe(false)
  expect(wrapper.get('[data-assignment-scope="quality"]').attributes('data-assignment-count')).toBe('1')
})
