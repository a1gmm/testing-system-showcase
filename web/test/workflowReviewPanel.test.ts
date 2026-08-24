import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import WorkflowReviewPanel from '../src/components/WorkflowReviewPanel.vue'

const assignment = {
  id: 1, contract_id: 'WT2026-001', scope: 'sampling' as const,
  reviewer_username: 'reviewer', approver_username: 'approver', active: true,
  reason: null, assigned_by: 'planner', assigned_at: '2026-08-20T00:00:00.000Z',
}

function workflow(status: 'pending_review' | 'pending_approval' | 'approved' | 'rejected' = 'pending_review') {
  return {
    id: 'wf-1', contract_id: 'WT2026-001', round_id: 'round-1', scope: 'sampling' as const,
    subject_type: 'round_sampling' as const, subject_id: 'round-1', status, current_revision: 2,
    created_by: 'author', created_at: '2026-08-20T00:00:00.000Z', withdrawn_reason: null,
    withdrawn_by: null, withdrawn_at: null,
    revisions: [
      { revision: 1, snapshot: {}, snapshot_json: '{}', snapshot_sha256: 'one', submitted_by: 'author', submitted_at: '2026-08-20T01:00:00.000Z' },
      { revision: 2, snapshot: {}, snapshot_json: '{}', snapshot_sha256: 'two', submitted_by: 'author', submitted_at: '2026-08-21T01:00:00.000Z' },
    ],
    decisions: [],
  }
}

describe('WorkflowReviewPanel', () => {
  it('只向当前指定复核人显示当前阶段唯一主要动作并带上预期版本', async () => {
    const wrapper = mount(WorkflowReviewPanel, { props: { workflow: workflow(), assignment, actorUsername: 'reviewer' } })
    expect(wrapper.get('[data-primary-action]').text()).toBe('复核通过')
    expect(wrapper.findAll('[data-primary-action]')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('审核通过')

    await wrapper.get('[data-primary-action]').trigger('click')
    expect(wrapper.emitted('decide')?.[0]).toEqual([{ revision: 2, level: 'review', decision: 'approve', comment: '' }])
  })

  it('退回必须填写原因并以当前版本提交', async () => {
    const wrapper = mount(WorkflowReviewPanel, { props: { workflow: workflow('pending_approval'), assignment, actorUsername: 'approver' } })
    const reject = wrapper.get('[data-reject-action]')
    expect(reject.attributes('disabled')).toBeDefined()
    await wrapper.get('[data-rejection-reason]').setValue('缺少原始附件')
    await reject.trigger('click')
    expect(wrapper.emitted('decide')?.[0]).toEqual([{ revision: 2, level: 'approve', decision: 'reject', comment: '缺少原始附件' }])
  })

  it('把并发冲突翻译成固定刷新提示并保留版本历史', async () => {
    const wrapper = mount(WorkflowReviewPanel, {
      props: { workflow: workflow(), assignment, actorUsername: 'reviewer', errorCode: 'WORKFLOW_STALE_REVISION' },
    })
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('内容已有新版本，请刷新')
    expect(wrapper.text()).toContain('版本 1')
    expect(wrapper.text()).toContain('版本 2')
  })

  it('非当前指定人员看不到审批动作', () => {
    const wrapper = mount(WorkflowReviewPanel, { props: { workflow: workflow(), assignment, actorUsername: 'someone-else' } })
    expect(wrapper.find('[data-primary-action]').exists()).toBe(false)
    expect(wrapper.find('[data-reject-action]').exists()).toBe(false)
  })

  it('阻断提示提供就地解决动作并将点击交给业务页', async () => {
    const wrapper = mount(WorkflowReviewPanel, {
      props: {
        workflow: null,
        actorUsername: 'sampler',
        authorUsername: 'sampler',
        qualificationProblem: '尚未指定采样复核人和审核人',
        qualificationActionLabel: '立即指定人员',
      },
    })

    const action = wrapper.get('[data-qualification-action]')
    expect(action.text()).toBe('立即指定人员')
    await action.trigger('click')
    expect(wrapper.emitted('resolve-qualification-problem')).toHaveLength(1)
  })

  it('无解决权限时只显示阻断说明且不暴露不可执行动作', () => {
    const wrapper = mount(WorkflowReviewPanel, {
      props: {
        workflow: null,
        actorUsername: 'sampler',
        authorUsername: 'sampler',
        qualificationProblem: '请联系计划员或管理员',
      },
    })

    expect(wrapper.get('[role="alert"]').text()).toContain('请联系计划员或管理员')
    expect(wrapper.find('[data-qualification-action]').exists()).toBe(false)
    expect(wrapper.find('[data-primary-action]').exists()).toBe(false)
  })

  it('资格能力路由可用服务端已核准层级显示唯一动作而无需读取完整项目指派', async () => {
    const wrapper = mount(WorkflowReviewPanel, {
      props: { workflow: workflow('pending_approval'), actorUsername: 'qualified-only', authorizedLevel: 'approve' },
    })
    expect(wrapper.get('[data-primary-action]').text()).toBe('审核通过')
    expect(wrapper.text()).not.toContain('指定复核人')
    expect(wrapper.text()).not.toContain('指定审核人')
    await wrapper.get('[data-primary-action]').trigger('click')
    expect(wrapper.emitted('decide')?.[0]).toEqual([{ revision: 2, level: 'approve', decision: 'approve', comment: '' }])
  })
})
