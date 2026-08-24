import { shallowMount } from '@vue/test-utils'
import { expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listAllRounds: vi.fn(), listHandoverSheets: vi.fn(),
  route: { query: { stage: 'sampling', queue: 'review' } as Record<string, string> },
}))

vi.mock('../src/api', () => ({
  currentUser: { value: { username: 'qualified-only', name: '资格专员', roles: ['sales'], status: 'active', created_at: '' } },
  QC_TYPES: [], UNIT_OPTS: [],
  api: { listAllRounds: mocks.listAllRounds, listHandoverSheets: mocks.listHandoverSheets },
}))
vi.mock('../src/permissions', () => ({
  can: () => false,
  PAGE_ROLES: { plans: ['sampler', 'planner', 'qc', 'tech'], qc: ['sampler', 'sample_manager', 'qc', 'planner', 'tech'] },
}))
vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ push: vi.fn(), resolve: () => ({ path: '/', query: {}, fullPath: '/' }) }),
}))

import Plans from '../src/pages/Plans.vue'
import Qc from '../src/pages/Qc.vue'

const stubs = { StageQueueNav: true, ProfessionalTaskQueue: true }

test('资格专属采样复核页只挂载专业队列且不加载派工/现场基础数据', () => {
  mocks.route.query = { stage: 'sampling', queue: 'review' }
  const wrapper = shallowMount(Plans, { global: { stubs } })
  const queue = wrapper.getComponent({ name: 'ProfessionalTaskQueue' })
  expect(queue.props()).toMatchObject({ scope: 'sampling', activeQueue: 'review' })
  expect(wrapper.findComponent({ name: 'StageQueueNav' }).exists()).toBe(false)
  expect(wrapper.text()).not.toContain('期次队列')
  expect(mocks.listAllRounds).not.toHaveBeenCalled()
})

test('资格专属质控审核页只挂载专业队列且不加载交接/质控基础数据', () => {
  mocks.route.query = { stage: 'quality', queue: 'approve' }
  const wrapper = shallowMount(Qc, { global: { stubs } })
  const queue = wrapper.getComponent({ name: 'ProfessionalTaskQueue' })
  expect(queue.props()).toMatchObject({ scope: 'quality', activeQueue: 'approve' })
  expect(wrapper.findComponent({ name: 'StageQueueNav' }).exists()).toBe(false)
  expect(wrapper.text()).not.toContain('待签收交接单')
  expect(mocks.listHandoverSheets).not.toHaveBeenCalled()
})
