import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), decide: vi.fn() }))
vi.mock('../src/api', () => ({
  currentUser: { value: { username: 'qualified-only', name: '资格专员', roles: ['sales'], status: 'active', created_at: '' } },
  api: { listWorkflowTasks: mocks.list, getWorkflow: mocks.get, decideWorkflow: mocks.decide },
}))

import ProfessionalTaskQueue from '../src/components/ProfessionalTaskQueue.vue'
import WorkflowReviewPanel from '../src/components/WorkflowReviewPanel.vue'

const task = (id: string, revision: number, level: 'review' | 'approve' = 'review') => ({
  workflow_instance_id: `WF-${id}`, subject_type: 'round_sampling' as const, subject_id: `ROUND-${id}`, contract_id: `WT-${id}`,
  status: level === 'review' ? 'pending_review' as const : 'pending_approval' as const, current_revision: revision,
  decision_level: level, acting_capacity: level === 'review' ? '采样复核' : '采样审核',
})
const workflow = (id: string, revision: number, level: 'review' | 'approve' = 'review') => ({
  id: `WF-${id}`, contract_id: `WT-${id}`, round_id: `ROUND-${id}`, scope: 'sampling' as const, subject_type: 'round_sampling' as const,
  subject_id: `ROUND-${id}`, status: level === 'review' ? 'pending_review' as const : 'pending_approval' as const,
  current_revision: revision, created_by: 'author', created_at: '',
  withdrawn_reason: null, withdrawn_by: null, withdrawn_at: null, revisions: [], decisions: [],
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  mocks.list.mockReset()
  mocks.get.mockReset()
  mocks.decide.mockReset().mockResolvedValue({})
})

test('资格专属队列只展示 DTO 标识并以服务端核准层级处理当前工作流动作', async () => {
  mocks.list.mockResolvedValue([{
    workflow_instance_id: 'WF-S', subject_type: 'round_sampling', subject_id: 'ROUND-S', contract_id: 'WT-S',
    status: 'pending_review', current_revision: 3, decision_level: 'review', acting_capacity: '采样复核',
  }])
  mocks.get.mockResolvedValue({
    id: 'WF-S', contract_id: 'WT-S', round_id: 'ROUND-S', scope: 'sampling', subject_type: 'round_sampling', subject_id: 'ROUND-S',
    status: 'pending_review', current_revision: 3, created_by: 'author', created_at: '', withdrawn_reason: null, withdrawn_by: null,
    withdrawn_at: null, revisions: [], decisions: [],
  })
  mocks.decide.mockResolvedValue({})

  const wrapper = mount(ProfessionalTaskQueue, { props: { scope: 'sampling', activeQueue: 'review' } })
  await flushPromises()
  expect(wrapper.text()).toContain('WT-S')
  expect(wrapper.text()).toContain('ROUND-S')
  expect(wrapper.text()).toContain('采样复核')
  expect(wrapper.text()).not.toContain('质控安排')
  await wrapper.get('[data-primary-action]').trigger('click')
  await flushPromises()
  expect(mocks.decide).toHaveBeenCalledWith('WF-S', { revision: 3, level: 'review', decision: 'approve', comment: '' })
})

test('采样审核待办显示合同与期次并以 approve 层级提交', async () => {
  mocks.list.mockResolvedValue([task('P', 4, 'approve')])
  mocks.get.mockResolvedValue(workflow('P', 4, 'approve'))

  const wrapper = mount(ProfessionalTaskQueue, { props: { scope: 'sampling', activeQueue: 'approve' } })
  await flushPromises()

  expect(wrapper.text()).toContain('WT-P')
  expect(wrapper.text()).toContain('ROUND-P')
  expect(wrapper.text()).toContain('采样审核')
  await wrapper.get('[data-primary-action]').trigger('click')
  await flushPromises()
  expect(mocks.decide).toHaveBeenCalledWith('WF-P', { revision: 4, level: 'approve', decision: 'approve', comment: '' })
})

test('专业待办为空时显示明确空状态且不请求详情', async () => {
  mocks.list.mockResolvedValue([])

  const wrapper = mount(ProfessionalTaskQueue, { props: { scope: 'sampling', activeQueue: 'approve' } })
  await flushPromises()

  expect(wrapper.text()).toContain('当前身份下没有需要处理的专业任务')
  expect(mocks.get).not.toHaveBeenCalled()
})

test('专业待办列表加载失败时显示服务端错误', async () => {
  mocks.list.mockRejectedValue(new Error('待办服务暂时不可用'))

  const wrapper = mount(ProfessionalTaskQueue, { props: { scope: 'sampling', activeQueue: 'approve' } })
  await flushPromises()

  expect(wrapper.get('[role="alert"]').text()).toContain('待办服务暂时不可用')
})

test('待办详情与当前任务不匹配时拒绝展示和提交', async () => {
  mocks.list.mockResolvedValue([task('A', 2, 'approve')])
  mocks.get.mockResolvedValue(workflow('B', 2, 'approve'))

  const wrapper = mount(ProfessionalTaskQueue, { props: { scope: 'sampling', activeQueue: 'approve' } })
  await flushPromises()

  expect(wrapper.get('[role="alert"]').text()).toContain('任务详情与当前待办不匹配')
  expect(wrapper.find('[data-primary-action]').exists()).toBe(false)
  expect(mocks.decide).not.toHaveBeenCalled()
})

test('较晚返回的 A 详情不能覆盖已选择且先返回的 B，决定只提交 B 的证据版本', async () => {
  const a = deferred<ReturnType<typeof workflow>>()
  const b = deferred<ReturnType<typeof workflow>>()
  mocks.list.mockResolvedValue([task('A', 7), task('B', 2)])
  mocks.get.mockImplementation((_type: string, subjectId: string) => subjectId === 'ROUND-A' ? a.promise : b.promise)

  const wrapper = mount(ProfessionalTaskQueue, { props: { scope: 'sampling', activeQueue: 'review' } })
  await flushPromises()
  const bButton = wrapper.findAll('.task-list button').find(button => button.text().includes('WT-B'))!
  await bButton.trigger('click')
  expect(wrapper.find('[data-primary-action]').exists()).toBe(false)

  b.resolve(workflow('B', 2))
  await flushPromises()
  expect(wrapper.text()).toContain('当前版本 2')
  a.resolve(workflow('A', 7))
  await flushPromises()
  expect(wrapper.text()).toContain('当前版本 2')
  expect(wrapper.text()).not.toContain('当前版本 7')

  await wrapper.get('[data-primary-action]').trigger('click')
  await flushPromises()
  expect(mocks.decide).toHaveBeenCalledTimes(1)
  expect(mocks.decide).toHaveBeenCalledWith('WF-B', { revision: 2, level: 'review', decision: 'approve', comment: '' })
})

test('切换到尚在加载的 B 时拒绝旧 A 面板的迟到决定事件', async () => {
  const b = deferred<ReturnType<typeof workflow>>()
  mocks.list.mockResolvedValue([task('A', 7), task('B', 2)])
  mocks.get.mockImplementation((_type: string, subjectId: string) => subjectId === 'ROUND-A' ? Promise.resolve(workflow('A', 7)) : b.promise)

  const wrapper = mount(ProfessionalTaskQueue, { props: { scope: 'sampling', activeQueue: 'review' } })
  await flushPromises()
  const oldPanel = wrapper.getComponent(WorkflowReviewPanel)
  const bButton = wrapper.findAll('.task-list button').find(button => button.text().includes('WT-B'))!
  const switching = bButton.trigger('click')
  oldPanel.vm.$emit('decide', { revision: 7, level: 'review', decision: 'approve', comment: '' })
  await switching
  await flushPromises()

  expect(wrapper.find('[data-primary-action]').exists()).toBe(false)
  expect(mocks.decide).not.toHaveBeenCalled()
  b.resolve(workflow('B', 2))
  await flushPromises()
  expect(wrapper.text()).toContain('当前版本 2')
})
