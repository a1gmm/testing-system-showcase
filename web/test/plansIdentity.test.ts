import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'
import { ElMessage, ElMessageBox } from 'element-plus'

const mocks = vi.hoisted(() => ({
  assignRound: vi.fn(async () => ({})),
  sampleRound: vi.fn(async () => { throw new Error('采样表还差王采样确认') }),
  saveRoundField: vi.fn(async () => ({})),
  planItems: [] as any[],
  checkouts: [] as any[],
  dirtyAllowed: true,
  dirtyKeys: [] as string[],
  roundFieldAllowed: true,
  route: { query: { stage: 'sampling', queue: 'final' } as Record<string, string> },
  currentUser: { value: { username: 'same-b', name: '同名采样员', roles: ['sampler', 'qc'], status: 'active', created_at: '' } as any },
  assignments: [] as any[],
  scrollIntoView: vi.fn(),
  round: {
  id: 'ROUND-WEB-ID', contract_id: 'C1', round_no: 1, due_date: '2026-08-01', status: 'pending',
  plan_id: null, sampler: '同名采样员、同名采样员', sampler_ids: ['same-a', 'same-b'], assignment_status: 'active',
  plan_date: '2026-08-01', sampled_at: null, created_at: '2026-08-01', bucket: 'overdue', client: '客户', project: '项目',
  field_info: {
    confirmations: { 'same-a': { name: '同名采样员', at: '2026-08-01T09:00:00.000Z' } },
    confirms: { '同名采样员': '2026-08-01T09:00:00.000Z' },
    confirmation_users: [
      { user_id: 'same-a', name: '同名采样员', confirmed_at: '2026-08-01T09:00:00.000Z' },
      { user_id: 'same-b', name: '同名采样员', confirmed_at: null },
    ],
  },
  },
}))

vi.mock('../src/api', () => ({
  currentUser: mocks.currentUser,
  QC_TYPES: [], UNIT_OPTS: [],
  api: {
    listAllRounds: vi.fn(async () => [mocks.round]),
    listSamplers: vi.fn(async () => [
      { username: 'same-a', name: '同名采样员' },
      { username: 'same-b', name: '同名采样员' },
    ]),
    getRoundDetail: vi.fn(async () => ({ round: mocks.round, contract: { client: '客户', scheme: { points: [] } }, planItems: mocks.planItems, samples: [] })),
    roundQcReqs: vi.fn(async () => []), listRoundQc: vi.fn(async () => []), listContractPoints: vi.fn(async () => []),
    listCheckouts: vi.fn(async () => mocks.checkouts), assignRound: mocks.assignRound,
    saveRoundField: mocks.saveRoundField, sampleRound: mocks.sampleRound,
    getWorkflow: vi.fn(async () => ({
      id: 'wf-round', contract_id: 'C1', round_id: 'ROUND-WEB-ID', scope: 'sampling', subject_type: 'round_sampling',
      subject_id: 'ROUND-WEB-ID', status: 'approved', current_revision: 1, created_by: 'same-b', created_at: '2026-08-01',
      withdrawn_reason: null, withdrawn_by: null, withdrawn_at: null, revisions: [], decisions: [],
    })),
    listWorkflowAssignments: vi.fn(async () => mocks.assignments),
    listWorkflowCandidates: vi.fn(async () => []),
  },
}))
vi.mock('../src/permissions', () => ({
  can: vi.fn((action: string) => action !== 'round_field' || mocks.roundFieldAllowed),
  PAGE_ROLES: { plans: ['sampler', 'planner', 'qc', 'tech'] },
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn(), resolve: (to: any) => ({ path: to.path || '/', query: to.query || {}, fullPath: '/' }) }), useRoute: () => mocks.route }))
vi.mock('../src/utils/dirty', () => ({
  confirmIfDirty: vi.fn(async () => mocks.dirtyAllowed),
  hasDirty: vi.fn((prefix?: string) => mocks.dirtyKeys.some(key => !prefix || key.startsWith(prefix))),
}))

import Plans from '../src/pages/Plans.vue'

const stubs = {
  'el-select': { props: ['modelValue'], template: '<div data-el-select><slot /></div>' },
  'el-option': { props: ['label', 'value'], template: '<span class="option" :data-label="label" :data-value="value" />' },
  'el-button': { template: '<button><slot /></button>' },
  'router-link': { template: '<a><slot /></a>' },
  RecordAttachments: true,
  StructuredSheet: true,
  WorkflowAssignmentEditor: { template: '<fieldset data-assignment-scope="sampling" tabindex="-1">采样指定</fieldset>' },
}

beforeEach(() => {
  vi.restoreAllMocks()
  mocks.assignRound.mockClear()
  mocks.saveRoundField.mockReset().mockResolvedValue({})
  mocks.sampleRound.mockReset().mockRejectedValue(new Error('采样表还差王采样确认'))
  mocks.dirtyAllowed = true
  mocks.dirtyKeys = []
  mocks.roundFieldAllowed = true
  mocks.route.query = { stage: 'sampling', queue: 'final' }
  mocks.currentUser.value = { username: 'same-b', name: '同名采样员', roles: ['sampler', 'qc'], status: 'active', created_at: '' }
  mocks.assignments = [{
    id: 1, contract_id: 'C1', scope: 'sampling', reviewer_username: 'reviewer', approver_username: 'approver',
    active: true, reason: null, assigned_by: 'planner', assigned_at: '2026-08-01',
  }]
  mocks.scrollIntoView.mockReset()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: mocks.scrollIntoView })
})

test('采样审核人未指定时计划员可从阻断提示直达人员指定区', async () => {
  mocks.route.query = { stage: 'dispatch', queue: 'final' }
  mocks.currentUser.value = { username: 'planner', name: '计划员', roles: ['planner'], status: 'active', created_at: '' }
  mocks.assignments = []
  const wrapper = mount(Plans, { attachTo: document.body, global: { stubs } })
  await flushPromises()
  await wrapper.find('.item.ingrp').trigger('click')
  await flushPromises()

  expect(wrapper.text()).toContain('采样员已派 · 审核人员待指定')
  const action = wrapper.get('[data-qualification-action]')
  await action.trigger('click')
  await flushPromises()

  const target = wrapper.get('[data-sampling-assignment-target]')
  expect(target.isVisible()).toBe(true)
  expect(document.activeElement).toBe(target.get('[data-assignment-scope="sampling"]').element)
  expect(mocks.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  wrapper.unmount()
})

test('计划员从现场采样入口进入时仍能看到审核人员指定区', async () => {
  mocks.route.query = { stage: 'sampling', queue: 'final' }
  mocks.currentUser.value = { username: 'planner', name: '计划员', roles: ['planner'], status: 'active', created_at: '' }
  const wrapper = mount(Plans, { global: { stubs } })
  await flushPromises()
  await wrapper.find('.item.ingrp').trigger('click')
  await flushPromises()

  expect(wrapper.find('[data-sampling-assignment-target]').exists()).toBe(true)
})

test('Plans 以 sampler ID 初始化改派并区分同名选项；确认按钮和状态按 user ID 判断', async () => {
  const wrapper = mount(Plans, { global: { stubs } })
  await flushPromises()
  await wrapper.find('.item.ingrp').trigger('click')
  await flushPromises()

  const select = wrapper.findComponent('[data-el-select]')
  expect(select.props('modelValue')).toEqual(['same-a', 'same-b'])
  expect(wrapper.findAll('.option').map(x => [x.attributes('data-label'), x.attributes('data-value')])).toEqual([
    ['同名采样员（same-a）', 'same-a'],
    ['同名采样员（same-b）', 'same-b'],
  ])
  const confirms = wrapper.findAll('[data-confirm-user-id]')
  expect(confirms).toHaveLength(2)
  expect(confirms[0].classes()).toContain('ok')
  expect(confirms[1].classes()).not.toContain('ok')
  expect(wrapper.text()).toContain('我确认采样表无误')
})

test('收样入库失败时显示后端的具体卡点，不再静默无响应', async () => {
  vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as any)
  const error = vi.spyOn(ElMessage, 'error').mockImplementation(() => undefined as any)
  const wrapper = mount(Plans, { global: { stubs } })
  await flushPromises()
  await wrapper.find('.item.ingrp').trigger('click')
  await flushPromises()
  const button = wrapper.findAll('button').find(b => b.text().includes('现场采样 · 收样入库'))
  expect(button).toBeTruthy()
  await button!.trigger('click')
  await flushPromises()
  expect(error).toHaveBeenCalledWith(expect.stringContaining('采样表还差王采样确认'))
})

test('现场记录保存失败时中止收样入库并显示原因', async () => {
  mocks.saveRoundField.mockRejectedValueOnce(new Error('现场记录冲突'))
  const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as any)
  const error = vi.spyOn(ElMessage, 'error').mockImplementation(() => undefined as any)
  const wrapper = mount(Plans, { global: { stubs } })
  await flushPromises()
  await wrapper.find('.item.ingrp').trigger('click')
  await flushPromises()
  const button = wrapper.findAll('button').find(b => b.text().includes('现场采样 · 收样入库'))!
  await button.trigger('click')
  await flushPromises()
  expect(confirm).not.toHaveBeenCalled()
  expect(mocks.sampleRound).not.toHaveBeenCalled()
  expect(error).toHaveBeenCalledWith(expect.stringContaining('现场记录冲突'))
})

test('有未保存采样表时中止收样入库', async () => {
  mocks.dirtyKeys = ['sheet:ROUND-WEB-ID:HJ-TC-136']
  const wrapper = mount(Plans, { global: { stubs } })
  await flushPromises()
  await wrapper.find('.item.ingrp').trigger('click')
  await flushPromises()
  const button = wrapper.findAll('button').find(b => b.text().includes('现场采样 · 收样入库'))!
  await button.trigger('click')
  await flushPromises()
  expect(mocks.saveRoundField).not.toHaveBeenCalled()
  expect(mocks.sampleRound).not.toHaveBeenCalled()
})

test('其他期次残留未保存标记不阻断当前已定稿期次收样入库', async () => {
  mocks.dirtyKeys = ['sheet:OTHER-ROUND:HJ-TC-136']
  vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as any)
  mocks.sampleRound.mockResolvedValueOnce([{ id: 'Q2026-0001' }] as any)
  const wrapper = mount(Plans, { global: { stubs } })
  await flushPromises()
  await wrapper.find('.item.ingrp').trigger('click')
  await flushPromises()

  const button = wrapper.findAll('button').find(b => b.text().includes('现场采样 · 收样入库'))!
  await button.trigger('click')
  await flushPromises()

  expect(mocks.saveRoundField).toHaveBeenCalledWith('ROUND-WEB-ID', expect.any(Object))
  expect(mocks.sampleRound).toHaveBeenCalledWith('ROUND-WEB-ID')
})

test('取消收样不调用接口，确认成功后给出入库数量', async () => {
  const confirm = vi.spyOn(ElMessageBox, 'confirm')
  confirm.mockRejectedValueOnce('cancel')
  const wrapper = mount(Plans, { global: { stubs } })
  await flushPromises()
  await wrapper.find('.item.ingrp').trigger('click')
  await flushPromises()
  const button = wrapper.findAll('button').find(b => b.text().includes('现场采样 · 收样入库'))!
  await button.trigger('click')
  await flushPromises()
  expect(mocks.sampleRound).not.toHaveBeenCalled()

  const success = vi.spyOn(ElMessage, 'success').mockImplementation(() => undefined as any)
  confirm.mockResolvedValueOnce('confirm' as any)
  mocks.sampleRound.mockResolvedValueOnce([{ id: 'Q2026-0001' }] as any)
  await button.trigger('click')
  await flushPromises()
  expect(mocks.sampleRound).toHaveBeenCalledWith('ROUND-WEB-ID')
  expect(success).toHaveBeenCalledWith(expect.stringContaining('已入库 1 个样品'))
})

test('恢复已保存的多张采样单，并按表号挂独立附件目标', async () => {
  const oldField = (mocks.round as any).field_info
  mocks.planItems = [{ matrix: '废水', point: '排污口', items: ['化学需氧量'], qty: 1 }]
  ;(mocks.round as any).field_info = { sheetCodes: { 废水: ['HJ-TC-136', 'HJ-TC-146'] } }
  const wrapper = mount(Plans, { global: { stubs } })
  await flushPromises()
  await wrapper.find('.item.ingrp').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('废水 · 采样单（可多选）')
  const sheetAttachments = wrapper.findAll('record-attachments-stub').filter(w => w.attributes('type') === 'round_sheet')
  expect(sheetAttachments.map(w => w.attributes('id')).sort()).toEqual([
    'ROUND-WEB-ID::HJ-TC-136', 'ROUND-WEB-ID::HJ-TC-146',
  ])
  ;(mocks.round as any).field_info = oldField
  mocks.planItems = []
})

test('无现场填写权限时采样单附件也是只读', async () => {
  const oldField = (mocks.round as any).field_info
  mocks.roundFieldAllowed = false
  mocks.planItems = [{ matrix: '废水', point: '排污口', items: ['化学需氧量'], qty: 1 }]
  ;(mocks.round as any).field_info = { sheetCodes: { 废水: ['HJ-TC-136'] } }
  const wrapper = mount(Plans, { global: { stubs } })
  await flushPromises()
  await wrapper.find('.item.ingrp').trigger('click')
  await flushPromises()
  const attachment = wrapper.findAll('record-attachments-stub').find(w => w.attributes('type') === 'round_sheet')
  expect(attachment?.attributes('frozen')).toBe('true')
  ;(mocks.round as any).field_info = oldField
  mocks.planItems = []
})

test('本期已领用设备默认进入现场记录并随保存提交', async () => {
  mocks.saveRoundField.mockClear()
  mocks.checkouts = [{ round_id: 'ROUND-WEB-ID', instrument_id: 'TC-001', instrument_name: '烟尘采样器' }]
  const wrapper = mount(Plans, { global: { stubs } })
  await flushPromises()
  await wrapper.find('.item.ingrp').trigger('click')
  await flushPromises()
  const save = wrapper.findAll('button').find(b => b.text().includes('保存现场记录'))
  expect(save).toBeTruthy()
  await save!.trigger('click')
  await flushPromises()
  expect(mocks.saveRoundField).toHaveBeenCalledWith('ROUND-WEB-ID', expect.objectContaining({ instrumentIds: ['TC-001'] }))
  mocks.checkouts = []
})
