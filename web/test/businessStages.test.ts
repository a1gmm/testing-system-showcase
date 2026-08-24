import { describe, expect, it } from 'vitest'
import { BUSINESS_STAGES, STAGE_QUEUES } from '../src/workflow/businessStages'
import { PAGE_ROLES, PERM } from '../src/permissions'

describe('十阶段业务主线', () => {
  it('按确认顺序提供十个且仅十个阶段入口', () => {
    expect(BUSINESS_STAGES.map(stage => stage.label)).toEqual([
      '① 编制委托合同', '② 合同评审', '③ 编制监测方案', '④ 采样指派',
      '⑤ 现场采样', '⑥ 样品交接', '⑦ 质控', '⑧ 实验室分析',
      '⑨ 1–8 档案归档', '⑩ 出具报告',
    ])
    expect(BUSINESS_STAGES.map(stage => stage.to)).toEqual([
      { path: '/contracts', query: { stage: 'contract' } },
      { path: '/contracts', query: { stage: 'review' } },
      { path: '/contracts', query: { stage: 'scheme' } },
      { path: '/plans', query: { stage: 'dispatch' } },
      { path: '/plans', query: { stage: 'sampling' } },
      { path: '/qc', query: { stage: 'handover' } },
      { path: '/qc', query: { stage: 'quality' } },
      { path: '/samples', query: { stage: 'laboratory' } },
      { path: '/archive-packages' },
      { path: '/reports' },
    ])
    expect(BUSINESS_STAGES.some(stage => stage.label.includes('三级审核'))).toBe(false)
  })

  it('菜单阶段角色都是对应复用页面的可访问角色，planner 只新增方案页面准入', () => {
    const routeRoles: Record<string, string[]> = {
      '/contracts': PAGE_ROLES.contracts, '/plans': PAGE_ROLES.plans, '/qc': PAGE_ROLES.qc,
      '/samples': PAGE_ROLES.samples, '/archive-packages': PAGE_ROLES['archive-packages'], '/reports': PAGE_ROLES.reports,
    }
    for (const stage of BUSINESS_STAGES) {
      expect(stage.roles.filter(role => !routeRoles[stage.to.path].includes(role)), stage.label).toEqual([])
    }
    expect(PAGE_ROLES.contracts).toContain('planner')
    expect(PERM.scheme_edit).toContain('planner')
    expect(PERM.contract_edit).not.toContain('planner')
    expect(PERM.contract_accept).not.toContain('planner')
  })

  it('所有阶段共用五个聚焦队列而不另造业务页面', () => {
    expect(STAGE_QUEUES.map(queue => queue.label)).toEqual(['待我填写', '待我复核', '待我审核', '已退回', '已定稿'])
    expect(new Set(BUSINESS_STAGES.map(stage => stage.to.path)).size).toBeLessThan(10)
  })
})
