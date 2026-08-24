import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ listWorkflowCandidates: vi.fn(), setWorkflowAssignment: vi.fn() }))
vi.mock('../src/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/api')>()
  return { ...actual, api: mocks }
})

import WorkflowAssignmentEditor from '../src/components/WorkflowAssignmentEditor.vue'
import { currentUser } from '../src/api'

beforeEach(() => {
  currentUser.value = null
  mocks.listWorkflowCandidates.mockReset().mockImplementation(async (_contractId: string, scope: string, level: string) => {
    if (scope === 'sampling' && level === 'review') return []
    return [{ username: `${scope}-${level}`, name: `${scope}-${level}-name` }]
  })
  mocks.setWorkflowAssignment.mockReset().mockImplementation(async (contractId: string, scope: string, input: any) => ({
    id: 1, contract_id: contractId, scope, reviewer_username: input.reviewerUsername,
    approver_username: input.approverUsername, active: true, reason: input.reason || null,
    assigned_by: 'planner', assigned_at: '2026-08-22T00:00:00.000Z',
  }))
})

test('管理员可把同一验收账号提交为复核人与审核人，由服务端验收开关最终裁决', async () => {
  currentUser.value = {
    username: 'demo_admin', name: '林工程师', roles: ['admin'], status: 'active', created_at: '', must_change_pw: false,
  }
  mocks.listWorkflowCandidates.mockResolvedValue([{ username: 'demo_admin', name: '林工程师' }])
  const wrapper = mount(WorkflowAssignmentEditor, {
    props: { contractId: 'WT2026-ACCEPTANCE', assignments: [], effectiveDate: '2026-08-23' },
  })
  await flushPromises()
  await wrapper.get('[data-reviewer="sampling"]').setValue('demo_admin')
  await wrapper.get('[data-approver="sampling"]').setValue('demo_admin')
  await wrapper.get('[data-save-assignment="sampling"]').trigger('click')
  await flushPromises()

  expect(mocks.setWorkflowAssignment).toHaveBeenCalledWith('WT2026-ACCEPTANCE', 'sampling', {
    reviewerUsername: 'demo_admin', approverUsername: 'demo_admin',
  })
  expect(wrapper.text()).toContain('单人验收模式')
})

test('四个专业的选择器只使用服务端候选列表并直说无合格人选原因', async () => {
  const wrapper = mount(WorkflowAssignmentEditor, { props: { contractId: 'WT2026-001', assignments: [], effectiveDate: '2026-08-22' } })
  await flushPromises()

  expect(mocks.listWorkflowCandidates).toHaveBeenCalledTimes(8)
  expect(mocks.listWorkflowCandidates).toHaveBeenCalledWith('WT2026-001', 'sampling', 'review', '2026-08-22')
  expect(wrapper.text()).toContain('没有具备有效采样复核资格且可与审核人分离的候选人')
  expect(wrapper.find('option[value="quality-review"]').exists()).toBe(true)
})

test('管理员面对空候选列表可直接进入人员资格配置', async () => {
  currentUser.value = {
    username: 'admin', name: '管理员', roles: ['admin'], status: 'active', created_at: '', must_change_pw: false,
  }
  mocks.listWorkflowCandidates.mockResolvedValue([])
  const wrapper = mount(WorkflowAssignmentEditor, {
    props: { contractId: 'WT2026-001', assignments: [], effectiveDate: '2026-08-22' },
  })
  await flushPromises()

  const links = wrapper.findAll('[data-configure-qualifications]')
  expect(links).toHaveLength(4)
  expect(links[0].attributes('href')).toBe('/users')
})

test('非管理员面对空候选列表时得到明确的管理员联系指引', async () => {
  currentUser.value = {
    username: 'planner', name: '计划员', roles: ['planner'], status: 'active', created_at: '', must_change_pw: false,
  }
  mocks.listWorkflowCandidates.mockResolvedValue([])
  const wrapper = mount(WorkflowAssignmentEditor, {
    props: { contractId: 'WT2026-001', assignments: [], effectiveDate: '2026-08-22' },
  })
  await flushPromises()

  expect(wrapper.text()).toContain('请联系管理员配置采样复核/审核资格')
  expect(wrapper.find('[data-configure-qualifications]').exists()).toBe(false)
})

test('复核人与审核人必须不同，换人原因随一次原子指派请求提交', async () => {
  const wrapper = mount(WorkflowAssignmentEditor, {
    props: {
      contractId: 'WT2026-001', effectiveDate: '2026-08-22',
      assignments: [{
        id: 1, contract_id: 'WT2026-001', scope: 'quality', reviewer_username: 'old-review', approver_username: 'old-approve',
        active: true, reason: null, assigned_by: 'planner', assigned_at: '2026-08-20T00:00:00.000Z',
      }],
    },
  })
  await flushPromises()
  await wrapper.get('[data-reviewer="quality"]').setValue('quality-review')
  await wrapper.get('[data-approver="quality"]').setValue('quality-approve')
  await wrapper.get('[data-reason="quality"]').setValue('原审核人员调岗')
  await wrapper.get('[data-save-assignment="quality"]').trigger('click')
  await flushPromises()

  expect(mocks.setWorkflowAssignment).toHaveBeenCalledWith('WT2026-001', 'quality', {
    reviewerUsername: 'quality-review', approverUsername: 'quality-approve', reason: '原审核人员调岗',
  })
})
