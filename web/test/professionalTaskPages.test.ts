import { shallowMount } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listAllRounds: vi.fn(), listHandoverSheets: vi.fn(),
  can: vi.fn(),
  route: { query: { stage: 'sampling', queue: 'review' } as Record<string, string> },
  actor: { username: 'qualified-only', name: '资格专员', roles: ['sales'], status: 'active', created_at: '' },
}))

vi.mock('../src/api', () => ({
  currentUser: { value: mocks.actor },
  QC_TYPES: [], UNIT_OPTS: [],
  api: { listAllRounds: mocks.listAllRounds, listHandoverSheets: mocks.listHandoverSheets },
}))
vi.mock('../src/permissions', () => ({
  can: mocks.can,
  PAGE_ROLES: { plans: ['sampler', 'planner', 'qc', 'tech'], qc: ['sampler', 'sample_manager', 'qc', 'planner', 'tech'] },
}))
vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ push: vi.fn(), resolve: () => ({ path: '/', query: {}, fullPath: '/' }) }),
}))

import Plans from '../src/pages/Plans.vue'
import Qc from '../src/pages/Qc.vue'

const stubs = { StageQueueNav: true, ProfessionalTaskQueue: true }

beforeEach(() => {
  mocks.actor.username = 'qualified-only'
  mocks.actor.name = '资格专员'
  mocks.actor.roles = ['sales']
  mocks.can.mockReset().mockReturnValue(false)
  mocks.listAllRounds.mockReset().mockResolvedValue([])
  mocks.listHandoverSheets.mockReset().mockResolvedValue([])
})

test('资格专属采样复核页只挂载专业队列且不加载派工/现场基础数据', () => {
  mocks.route.query = { stage: 'sampling', queue: 'review' }
  const wrapper = shallowMount(Plans, { global: { stubs } })
  const queue = wrapper.getComponent({ name: 'ProfessionalTaskQueue' })
  expect(queue.props()).toMatchObject({ scope: 'sampling', activeQueue: 'review' })
  expect(wrapper.findComponent({ name: 'StageQueueNav' }).exists()).toBe(false)
  expect(wrapper.text()).not.toContain('期次队列')
  expect(wrapper.text()).toContain('⑤ 现场采样')
  expect(wrapper.text()).not.toContain('④ 采样指派')
  expect(mocks.listAllRounds).not.toHaveBeenCalled()
})

test.each(['round_assign', 'round_field'])('具备 %s 的基础岗位仍使用普通期次工作台', (permission) => {
  mocks.can.mockImplementation(action => action === permission)
  mocks.route.query = { stage: 'dispatch', queue: 'write' }

  const wrapper = shallowMount(Plans, { global: { stubs } })

  expect(wrapper.findComponent({ name: 'StageQueueNav' }).exists()).toBe(true)
  expect(wrapper.findComponent({ name: 'ProfessionalTaskQueue' }).exists()).toBe(false)
  expect(wrapper.text()).toContain('④ 采样指派')
})

test.each(['sampling', 'dispatch'])('拥有质控页面岗位的采样审核人从 %s 入口仍进入本人专业队列', (stage) => {
  mocks.actor.username = 'demo_qc'
  mocks.actor.name = '吴质控'
  mocks.actor.roles = ['qc', 'sample_manager']
  mocks.route.query = { stage, queue: 'approve' }

  const wrapper = shallowMount(Plans, { global: { stubs } })

  const queue = wrapper.getComponent({ name: 'ProfessionalTaskQueue' })
  expect(queue.props()).toMatchObject({ scope: 'sampling', activeQueue: 'approve' })
  expect(wrapper.findComponent({ name: 'StageQueueNav' }).exists()).toBe(false)
  expect(wrapper.text()).not.toContain('期次队列')
  expect(wrapper.text()).toContain('⑤ 现场采样')
  expect(wrapper.text()).not.toContain('④ 采样指派')
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
