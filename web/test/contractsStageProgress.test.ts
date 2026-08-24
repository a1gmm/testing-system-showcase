import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'

const labels = [
  '① 编制委托合同', '② 合同评审', '③ 编制监测方案', '④ 采样指派', '⑤ 现场采样',
  '⑥ 样品交接', '⑦ 质控', '⑧ 实验室分析', '⑨ 1–8 档案归档', '⑩ 出具报告',
]
const pipeline = {
  activeIndex: 1, round: null, blockers: ['合同评审尚未通过'],
  stages: labels.map((label, index) => ({
    key: ['contract', 'contract-review', 'scheme', 'dispatch', 'sampling', 'handover', 'quality', 'laboratory', 'archive', 'report'][index],
    label, code: `S${index + 1}`, who: '责任岗位', action: '处理当前阶段', status: index === 0 ? 'done' : index === 1 ? 'active' : 'todo',
  })),
}
const contract = {
  id: 'WT-DETAIL', client: '详情测试厂', project: '十阶段项目', contact: null, phone: null, status: 'draft',
  accepted_at: null, accepted_by: null, tech_review_result: null, tech_approved_at: null, urgent: 0,
  cycle_months: 0, period_start: null, period_end: null, created_at: '2026-08-22T00:00:00.000Z',
  plan: [], samples: [], scheme: null, quote: null, doc_name: null,
}
const stats = { samples: 0, tested: 0, approved: 0, reports: 0, issued: false, reportStatus: 'none' }
const projectSummary = { ...contract, stats, plan: null, pipeline }
const project = { contract, plans: [], samples: [], reports: [], stats, pipeline }
const mocks = vi.hoisted(() => ({ api: { listProjects: vi.fn(), getProject: vi.fn(), listRounds: vi.fn(), contractDocUrl: vi.fn() } }))

vi.mock('../src/api', () => ({ api: mocks.api, UNIT_OPTS: [] }))
vi.mock('../src/permissions', () => ({ can: () => false }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: { stage: 'contract', queue: 'write' } }),
  useRouter: () => ({ push: vi.fn(), resolve: (to: any) => ({ path: to.path || '/', query: to.query || {} }) }),
}))
import Contracts from '../src/pages/Contracts.vue'

beforeEach(() => {
  mocks.api.listProjects.mockReset().mockResolvedValue([projectSummary])
  mocks.api.getProject.mockReset().mockResolvedValue(project)
  mocks.api.listRounds.mockReset().mockResolvedValue([])
})

test('真实选中项目详情渲染十阶段进度和服务端直接阻塞，不再渲染旧八阶段条', async () => {
  const wrapper = mount(Contracts, {
    global: {
      directives: { loading: () => undefined },
      stubs: {
        RouterLink: { template: '<a><slot /></a>' },
        'el-button': { template: '<button><slot /></button>' },
        'el-icon': { template: '<span><slot /></span>' },
        'el-select': true, 'el-select-v2': true, 'el-option': true, 'el-dialog': true, RecordAttachments: true,
        Folder: true, Document: true,
      },
    },
  })
  await flushPromises()
  await wrapper.get('.pjrow').trigger('click')
  await flushPromises()

  const progress = wrapper.get('[aria-label="项目十阶段进度"]')
  expect(progress.findAll('[data-stage-key]')).toHaveLength(10)
  expect(progress.text()).toContain('合同评审尚未通过')
  expect(wrapper.find('.pipe').exists()).toBe(false)
})
