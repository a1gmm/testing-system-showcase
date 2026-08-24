import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ProjectStageProgress from '../src/components/ProjectStageProgress.vue'

describe('ProjectStageProgress', () => {
  it('始终显示完整十步并直接说明阻塞原因', () => {
    const wrapper = mount(ProjectStageProgress, {
      props: {
        currentStage: 'archive',
        completedStages: ['contract', 'contract-review', 'scheme', 'dispatch', 'sampling', 'handover', 'quality'],
        blockers: ['实验室分析还有 2 份记录待审核，暂不能归档'],
      },
    })
    expect(wrapper.findAll('[data-stage-key]')).toHaveLength(10)
    expect(wrapper.text()).toContain('① 编制委托合同')
    expect(wrapper.text()).toContain('⑩ 出具报告')
    expect(wrapper.get('[role="alert"]').text()).toContain('实验室分析还有 2 份记录待审核，暂不能归档')
  })
})
