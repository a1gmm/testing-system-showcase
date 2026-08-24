import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  actor: { username: 'review-me', name: '我的复核员', roles: ['analyst'], status: 'active', created_at: '' },
  api: {
    dueRounds: vi.fn(), listProjects: vi.fn(), listRecordsByStatus: vi.fn(), listSamples: vi.fn(), listReports: vi.fn(),
    resourceAlerts: vi.fn(), listPendingHandovers: vi.fn(), listTasks: vi.fn(), contractAlerts: vi.fn(), statsOverview: vi.fn(),
    listHandoverSheets: vi.fn(), listAllRounds: vi.fn(), statsYearly: vi.fn(), listWorkflowAssignments: vi.fn(), getWorkflow: vi.fn(),
    listArchivePackages: vi.fn(), listReportBatches: vi.fn(), listWorkflowTasks: vi.fn(),
  },
}))
const record = (id: string, contractId: string) => ({
  id, serial: id, sample_id: `S-${id}`, template_code: 'HJ-TC-001', template_name: '原始记录', sheet_type: 'test',
  method: '方法', analyte: 'COD', matrix: '废水', instrument_id: null, data: { rows: [], meta: {} }, status: 'submitted',
  reviewer: null, reviewed_at: null, approver: null, approved_at: null, reject_reason: null, contract_id: contractId, updated_at: '',
})
const round = (id: string, contractId: string, status = 'done') => ({
  id, contract_id: contractId, round_no: 1, due_date: '2026-08-20', status, plan_id: null, sampler: '采样员', sampler_ids: ['author'],
  assignment_status: 'active', plan_date: '2026-08-20', sampled_at: status === 'done' ? '2026-08-20T08:00:00.000Z' : null,
  created_at: '2026-08-01T00:00:00.000Z', sample_count: 1, rollup: 'approved', client: '客户', project: '项目', bucket: 'done',
})
const workflow = (subjectType: 'round_sampling' | 'quality_plan', id: string, contractId: string, status: 'pending_review' | 'pending_approval') => ({
  id: `WF-${id}`, contract_id: contractId, round_id: id, scope: subjectType === 'round_sampling' ? 'sampling' : 'quality',
  subject_type: subjectType, subject_id: id, status, current_revision: 1, created_by: 'author', created_at: '', withdrawn_reason: null,
  withdrawn_by: null, withdrawn_at: null, revisions: [], decisions: [],
})
const task = (scope: 'sampling' | 'quality' | 'laboratory' | 'report', id: string, contractId: string, level: 'review' | 'approve') => ({
  workflow_instance_id: `WF-${id}`,
  subject_type: scope === 'sampling' ? 'round_sampling' : scope === 'quality' ? 'quality_plan' : scope === 'laboratory' ? 'lab_record' : 'report',
  subject_id: id, contract_id: contractId, status: level === 'review' ? 'pending_review' : 'pending_approval', current_revision: 1,
  decision_level: level,
  acting_capacity: `${scope}-${level}`,
})
const archive = (id: string, reportBatchId: string | null, roundIds: string[]) => ({
  id, contract_id: 'WT-REPORT', report_batch_id: reportBatchId, version: 1, status: 'confirmed', manifest_sha256: 'hash',
  readiness: { ready: true, contractId: 'WT-REPORT', reportBatchId, roundIds, issues: [] }, items: [], created_by: 'archivist',
  created_at: '2026-08-22T00:00:00.000Z', confirmed_by: 'archivist', confirmed_at: '2026-08-22T01:00:00.000Z',
  invalidated_by: null, invalidated_at: null, invalidation_reason: null,
})
vi.mock('../src/api', async () => ({
  api: mocks.api, currentUser: (await import('vue')).ref(mocks.actor),
  hasRole: (...roles: string[]) => roles.some(role => mocks.actor.roles.includes(role)),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.routerPush }) }))
import Dashboard from '../src/pages/Dashboard.vue'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.actor.roles = ['analyst']
  mocks.api.dueRounds.mockResolvedValue([]); mocks.api.listProjects.mockResolvedValue([]); mocks.api.listSamples.mockResolvedValue([])
  mocks.api.listReports.mockResolvedValue([]); mocks.api.resourceAlerts.mockResolvedValue([]); mocks.api.listPendingHandovers.mockResolvedValue([])
  mocks.api.listTasks.mockResolvedValue([]); mocks.api.contractAlerts.mockResolvedValue([]); mocks.api.statsOverview.mockResolvedValue(null)
  mocks.api.listHandoverSheets.mockResolvedValue([]); mocks.api.listAllRounds.mockResolvedValue([])
  mocks.api.listArchivePackages.mockResolvedValue([]); mocks.api.listReportBatches.mockResolvedValue([])
  mocks.api.listWorkflowAssignments.mockClear()
  mocks.api.listWorkflowTasks.mockClear()
  mocks.api.listWorkflowTasks.mockResolvedValue([])
  mocks.api.statsYearly.mockResolvedValue({ year: 2026, contracts: 0, samples: 0, reportsIssued: 0, exceed: 0, qc: { total: 0, pass: 0 }, testers: [], clients: [] })
  mocks.api.listRecordsByStatus.mockImplementation(async (status: string) => status === 'submitted'
    ? [record('REC-MINE', 'WT-MINE'), record('REC-OTHER', 'WT-OTHER')] : [])
  mocks.api.listWorkflowAssignments.mockImplementation(async (contractId: string) => [{
    id: 1, contract_id: contractId, scope: 'laboratory', reviewer_username: contractId === 'WT-MINE' ? 'review-me' : 'other-reviewer',
    approver_username: 'approve-me', active: true, reason: null, assigned_by: 'planner', assigned_at: '',
  }])
  mocks.api.getWorkflow.mockImplementation(async (_type: string, id: string) => ({
    id: `WF-${id}`, contract_id: id === 'REC-MINE' ? 'WT-MINE' : 'WT-OTHER', round_id: null, scope: 'laboratory',
    subject_type: 'lab_record', subject_id: id, status: 'pending_review', current_revision: 1, created_by: 'author',
    created_at: '', withdrawn_reason: null, withdrawn_by: null, withdrawn_at: null, revisions: [], decisions: [],
  }))
})

test('工作台只统计精确指派给当前账号的复核任务并链接同一队列', async () => {
  mocks.api.listWorkflowTasks.mockImplementation(async (scope: string) => scope === 'laboratory'
    ? [task('laboratory', 'REC-MINE', 'WT-MINE', 'review')] : [])
  const wrapper = mount(Dashboard, { global: { directives: { loading: () => undefined } } })
  await flushPromises()
  const row = wrapper.findAll('.qrow').find(item => item.text().includes('记录待复核'))!
  expect(row.find('.qn').text()).toBe('1')
  expect(mocks.api.listWorkflowTasks.mock.calls.map(([scope]) => scope)).toEqual(['sampling', 'quality', 'laboratory', 'report'])
  expect(mocks.api.listWorkflowAssignments).not.toHaveBeenCalled()
  await row.trigger('click')
  expect(mocks.routerPush).toHaveBeenCalledWith('/samples?stage=laboratory&queue=review')
})

test('工作台按当前账号精确统计采样和质控两级审核且同一期只计一次', async () => {
  mocks.actor.roles = ['planner', 'qc']
  const samplingReview = round('R-S-REVIEW', 'WT-S-REVIEW')
  const samplingApprove = round('R-S-APPROVE', 'WT-S-APPROVE')
  mocks.api.dueRounds.mockResolvedValue([samplingReview, samplingApprove])
  // due 与 allRounds 会重叠；每个工作流仍只能进入一个精确队列一次。
  mocks.api.listAllRounds.mockResolvedValue([samplingReview, samplingApprove])
  mocks.api.listHandoverSheets.mockResolvedValue([
    { id: 'HO-Q-REVIEW', round_id: 'R-Q-REVIEW', contract_id: 'WT-Q-REVIEW', source: 'sampling', sample_ids: ['S-1'], detail: [], from_person: '采样员', from_at: '', to_person: '样管员', to_at: '', storage: '冷藏', status: 'confirmed', note: null, created_at: '' },
    { id: 'HO-Q-APPROVE', round_id: 'R-Q-APPROVE', contract_id: 'WT-Q-APPROVE', source: 'sampling', sample_ids: ['S-2'], detail: [], from_person: '采样员', from_at: '', to_person: '样管员', to_at: '', storage: '冷藏', status: 'confirmed', note: null, created_at: '' },
  ])
  mocks.api.listWorkflowTasks.mockImplementation(async (scope: string) => scope === 'sampling'
    ? [task('sampling', 'R-S-REVIEW', 'WT-S-REVIEW', 'review'), task('sampling', 'R-S-APPROVE', 'WT-S-APPROVE', 'approve')]
    : scope === 'quality' ? [task('quality', 'R-Q-REVIEW', 'WT-Q-REVIEW', 'review'), task('quality', 'R-Q-APPROVE', 'WT-Q-APPROVE', 'approve')]
      : [])
  mocks.api.listRecordsByStatus.mockResolvedValue([])
  mocks.api.listWorkflowAssignments.mockImplementation(async (contractId: string) => [{
    id: 1, contract_id: contractId, scope: contractId.includes('-S-') ? 'sampling' : 'quality',
    reviewer_username: contractId.endsWith('REVIEW') ? 'review-me' : 'other-reviewer',
    approver_username: contractId.endsWith('APPROVE') ? 'review-me' : 'other-approver',
    active: true, reason: null, assigned_by: 'planner', assigned_at: '',
  }])
  mocks.api.getWorkflow.mockImplementation(async (type: 'round_sampling' | 'quality_plan', id: string) => {
    const contractId = id.replace(/^R-/, 'WT-')
    return workflow(type, id, contractId, id.endsWith('REVIEW') ? 'pending_review' : 'pending_approval')
  })

  const wrapper = mount(Dashboard, { global: { directives: { loading: () => undefined } } })
  await flushPromises()
  const expected = [
    ['采样待复核', '1', '采样复核', '/plans?stage=sampling&queue=review'],
    ['采样待审核', '1', '采样审核', '/plans?stage=sampling&queue=approve'],
    ['质控待复核', '1', '质控复核', '/qc?stage=quality&queue=review'],
    ['质控待审核', '1', '质控审核', '/qc?stage=quality&queue=approve'],
  ] as const
  for (const [label, count, capacity, link] of expected) {
    const row = wrapper.findAll('.qrow').find(item => item.find('.ql').text() === label)!
    expect(row.find('.qn').text()).toBe(count)
    expect(row.find('.capacity').text()).toBe(capacity)
    await row.trigger('click')
    expect(mocks.routerPush).toHaveBeenLastCalledWith(link)
  }
})

test('只有专业资格的受派人无需采样或质控基础岗位也能看到精确待办', async () => {
  mocks.actor.roles = []
  mocks.api.listRecordsByStatus.mockResolvedValue([])
  mocks.api.listWorkflowTasks.mockImplementation(async (scope: string) => scope === 'sampling'
    ? [task('sampling', 'R-QUAL-S', 'WT-QUAL-S', 'review')]
    : scope === 'quality' ? [task('quality', 'R-QUAL-Q', 'WT-QUAL-Q', 'approve')] : [])
  mocks.api.listWorkflowAssignments.mockImplementation(async (contractId: string) => [{
    id: 1, contract_id: contractId, scope: contractId.endsWith('-S') ? 'sampling' : 'quality',
    reviewer_username: contractId.endsWith('-S') ? 'review-me' : 'quality-reviewer',
    approver_username: contractId.endsWith('-Q') ? 'review-me' : 'sampling-approver',
    active: true, reason: null, assigned_by: 'planner', assigned_at: '',
  }])

  const wrapper = mount(Dashboard, { global: { directives: { loading: () => undefined } } })
  await flushPromises()
  const sampling = wrapper.findAll('.qrow').find(item => item.find('.ql').text() === '采样待复核')!
  const quality = wrapper.findAll('.qrow').find(item => item.find('.ql').text() === '质控待审核')!
  expect(sampling.find('.qn').text()).toBe('1')
  expect(quality.find('.qn').text()).toBe('1')
  expect(mocks.api.listWorkflowTasks.mock.calls.map(([scope]) => scope)).toEqual(['sampling', 'quality', 'laboratory', 'report'])
  for (const globalLoader of [
    mocks.api.dueRounds, mocks.api.listProjects, mocks.api.listRecordsByStatus, mocks.api.listSamples, mocks.api.listReports,
    mocks.api.resourceAlerts, mocks.api.listPendingHandovers, mocks.api.listTasks, mocks.api.contractAlerts,
    mocks.api.statsOverview, mocks.api.listHandoverSheets, mocks.api.listAllRounds, mocks.api.listArchivePackages,
    mocks.api.listReportBatches,
  ]) expect(globalLoader).not.toHaveBeenCalled()
})

test.each([
  ['qc', false],
  ['sample_manager', true],
] as const)('交接单待签收只属于样品管理员：%s visibility=%s', async (role, visible) => {
  mocks.actor.roles = [role]
  mocks.api.listRecordsByStatus.mockResolvedValue([])
  mocks.api.listHandoverSheets.mockResolvedValue([{
    id: 'HO-SENT', round_id: 'R-HO', contract_id: 'WT-HO', source: 'sampling', sample_ids: ['S-HO'], detail: [],
    from_person: '采样员', from_at: '', to_person: null, to_at: null, storage: '冷藏', status: 'sent', note: null, created_at: '',
  }])
  const wrapper = mount(Dashboard, { global: { directives: { loading: () => undefined } } })
  await flushPromises()
  expect(wrapper.findAll('.qrow').some(item => item.find('.ql').text() === '交接单待签收')).toBe(visible)
})

test('未指派账号收到的服务端专业待办为空且不显示专业队列', async () => {
  mocks.actor.roles = ['sales']
  mocks.api.listRecordsByStatus.mockResolvedValue([])
  mocks.api.listWorkflowTasks.mockResolvedValue([])

  const wrapper = mount(Dashboard, { global: { directives: { loading: () => undefined } } })
  await flushPromises()
  expect(wrapper.findAll('.qrow').some(item => item.find('.ql').text() === '采样待复核')).toBe(false)
  expect(wrapper.findAll('.qrow').some(item => item.find('.ql').text() === '质控待审核')).toBe(false)
})

test('一个专业范围返回 403 不会掩盖另一范围的精确待办或误报全页失败', async () => {
  mocks.actor.roles = ['sales']
  mocks.api.listRecordsByStatus.mockResolvedValue([])
  mocks.api.listWorkflowTasks.mockImplementation(async (scope: string) => {
    if (scope === 'sampling') throw { response: { status: 403 } }
    return scope === 'quality' ? [task('quality', 'R-QUAL-Q', 'WT-QUAL-Q', 'approve')] : []
  })
  mocks.api.listWorkflowAssignments.mockResolvedValue([{
    id: 1, contract_id: 'WT-QUAL-Q', scope: 'quality', reviewer_username: 'quality-reviewer', approver_username: 'review-me',
    active: true, reason: null, assigned_by: 'planner', assigned_at: '',
  }])

  const wrapper = mount(Dashboard, { global: { directives: { loading: () => undefined } } })
  await flushPromises()
  const quality = wrapper.findAll('.qrow').find(item => item.find('.ql').text() === '质控待审核')!
  expect(quality.find('.qn').text()).toBe('1')
  expect(wrapper.find('.partial').exists()).toBe(false)
})

test.each([
  ['缺少归档', [], [], '0'],
  ['归档期次范围不匹配', [archive('ARCHIVE-WRONG', null, ['R-REPORT', 'R-EXTRA'])], [], '0'],
  ['报告批次归档精确匹配', [archive('ARCHIVE-VALID', 'BATCH-REPORT', ['R-REPORT'])], [{ id: 'BATCH-REPORT', contract_id: 'WT-REPORT', name: '第一批', created_by: 'planner', created_at: '', round_ids: ['R-REPORT'] }], '1'],
] as const)('工作台可出报告在%s时显示精确数量', async (_case, packages, batches, expected) => {
  mocks.actor.roles = ['report_editor']
  mocks.api.listRecordsByStatus.mockResolvedValue([])
  mocks.api.listAllRounds.mockResolvedValue([round('R-REPORT', 'WT-REPORT')])
  mocks.api.listArchivePackages.mockResolvedValue(packages)
  mocks.api.listReportBatches.mockResolvedValue(batches)

  const wrapper = mount(Dashboard, { global: { directives: { loading: () => undefined } } })
  await flushPromises()
  const row = wrapper.findAll('.qrow').find(item => item.find('.ql').text() === '可出报告')!
  expect(row.find('.qn').text()).toBe(expected)
})
