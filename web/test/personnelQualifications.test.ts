import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listUsers: vi.fn(),
  listUserQualifications: vi.fn(),
  setUserQualifications: vi.fn(),
  updateUser: vi.fn(),
  updateUserPersonnel: vi.fn(),
}))

vi.mock('../src/api', () => ({
  currentUser: ref({ username: 'admin', name: '管理员', roles: ['admin'], status: 'active', created_at: '2026-01-01T00:00:00.000Z' }),
  hasRole: () => true,
  ROLE_LABEL: {
    admin: '系统管理员', sampler: '采样员', analyst: '实验室分析人员', report_editor: '报告编制人员',
  },
  PROFESSIONAL_SCOPES: ['sampling', 'quality', 'laboratory', 'report'],
  PROFESSIONAL_SCOPE_LABEL: { sampling: '采样', quality: '质控', laboratory: '实验室', report: '报告' },
  QUALIFICATION_LABEL: {
    sampling_review: '采样复核', sampling_approve: '采样审核',
    quality_review: '质控复核', quality_approve: '质控审核',
    laboratory_review: '实验室复核', laboratory_approve: '实验室审核',
    report_review: '报告复核', report_approve: '报告审核',
  },
  QUALIFICATION_CODES: [
    'sampling_review', 'sampling_approve', 'quality_review', 'quality_approve',
    'laboratory_review', 'laboratory_approve', 'report_review', 'report_approve',
  ],
  api: mocks,
}))

import Users from '../src/pages/Users.vue'

const users = [{
  username: 'multi-role', name: '多岗人员', roles: ['sampler', 'analyst'], status: 'active',
  created_at: '2026-01-02T00:00:00.000Z', cert_name: null, cert_until: null,
}]
const qualifications = [{
  username: 'multi-role', code: 'sampling_review', valid_from: '2026-01-01', valid_until: '2026-12-31',
  status: 'active', granted_by: 'admin', granted_at: '2026-01-02T00:00:00.000Z',
}]

function mountUsers() {
  return mount(Users, {
    global: {
      stubs: {
        'el-button': { props: ['disabled', 'loading', 'type'], template: '<button :disabled="disabled"><slot /></button>' },
      },
      directives: { loading: () => undefined },
    },
  })
}

beforeEach(() => {
  mocks.listUsers.mockReset().mockResolvedValue(users)
  mocks.listUserQualifications.mockReset().mockResolvedValue(qualifications)
  mocks.setUserQualifications.mockReset().mockResolvedValue(qualifications)
  mocks.updateUser.mockReset().mockResolvedValue(users[0])
  mocks.updateUserPersonnel.mockReset().mockResolvedValue({ user: users[0], qualifications })
})

test('人员行分开显示全部基础岗位、专业审核资格及有效期', async () => {
  const wrapper = mountUsers()
  await flushPromises()

  expect(wrapper.text()).toContain('基础岗位')
  expect(wrapper.text()).toContain('专业审核资格')
  expect(wrapper.text()).toContain('采样员')
  expect(wrapper.text()).toContain('实验室分析人员')
  expect(wrapper.text()).toContain('采样复核')
  expect(wrapper.text()).toContain('2026-01-01 至 2026-12-31')
  expect(wrapper.text()).not.toContain('采样审核')
})

test('编辑人员时按四个专业范围多选复核与审核，并分别保存资格有效期', async () => {
  const wrapper = mountUsers()
  await flushPromises()
  await wrapper.get('[data-testid="edit-user-multi-role"]').trigger('click')

  for (const scope of ['采样', '质控', '实验室', '报告']) expect(wrapper.text()).toContain(scope)
  const samplingReview = wrapper.get('[data-qualification-code="sampling_review"]')
  const reportApprove = wrapper.get('[data-qualification-code="report_approve"]')
  expect(samplingReview.text()).toContain('复核')
  expect(reportApprove.text()).toContain('审核')

  await reportApprove.trigger('click')
  expect(samplingReview.classes()).toContain('on')
  expect(reportApprove.classes()).toContain('on')
  await wrapper.get('[data-valid-from="report_approve"]').setValue('2026-03-01')
  await wrapper.get('[data-valid-until="report_approve"]').setValue('2027-02-28')
  await wrapper.get('[data-testid="save-user-edit"]').trigger('click')
  await flushPromises()

  expect(mocks.updateUserPersonnel).toHaveBeenCalledWith('multi-role', {
    name: '多岗人员', roles: ['sampler', 'analyst'], qualifications: [
      { code: 'sampling_review', validFrom: '2026-01-01', validUntil: '2026-12-31', status: 'active' },
      { code: 'report_approve', validFrom: '2026-03-01', validUntil: '2027-02-28', status: 'active' },
    ],
  })
})

test('专业资格保存失败时在编辑区显示服务端中文原因', async () => {
  mocks.updateUserPersonnel.mockRejectedValueOnce({
    response: { data: { error: '资格失效日期不能早于生效日期', error_code: 'QUALIFICATION_DATE_INVALID' } },
  })
  const wrapper = mountUsers()
  await flushPromises()
  await wrapper.get('[data-testid="edit-user-multi-role"]').trigger('click')
  await wrapper.get('[data-testid="save-user-edit"]').trigger('click')
  await flushPromises()

  const error = wrapper.get('[role="alert"]')
  expect(error.text()).toBe('资格失效日期不能早于生效日期')
  expect(wrapper.find('[data-testid="qualification-editor"]').exists()).toBe(true)
})

test('保存期间冻结目标用户和 payload，A 的数据不会因切换写给 B', async () => {
  const userB = { ...users[0], username: 'user-b', name: '乙人员', roles: ['report_editor'] }
  mocks.listUsers.mockResolvedValueOnce([users[0], userB])
  mocks.listUserQualifications.mockImplementation(async (username: string) => username === 'multi-role' ? qualifications : [])
  let release!: (value: unknown) => void
  const pending = new Promise(resolve => { release = resolve })
  mocks.updateUserPersonnel.mockReturnValueOnce(pending)
  const wrapper = mountUsers()
  await flushPromises()

  await wrapper.get('[data-testid="edit-user-multi-role"]').trigger('click')
  await wrapper.get('[data-testid="save-user-edit"]').trigger('click')
  const switchButton = wrapper.get('[data-testid="edit-user-user-b"]')
  expect(wrapper.get('[data-testid="save-user-edit"]').attributes('disabled')).toBeDefined()
  expect(switchButton.attributes('disabled')).toBeDefined()
  await switchButton.trigger('click')
  expect(wrapper.text()).toContain('编辑「multi-role」')

  release({ user: users[0], qualifications })
  await pending
  await flushPromises()
  expect(mocks.updateUserPersonnel).toHaveBeenCalledTimes(1)
  expect(mocks.updateUserPersonnel).toHaveBeenCalledWith('multi-role', expect.objectContaining({
    name: '多岗人员', roles: ['sampler', 'analyst'],
  }))
})

test('全部专业资格加载失败时仍显示人员，并提供逐行重试而不谎报未授权', async () => {
  mocks.listUserQualifications.mockRejectedValue(new Error('资格服务暂不可用'))
  const wrapper = mountUsers()
  await flushPromises()

  expect(wrapper.text()).toContain('多岗人员')
  expect(wrapper.text()).toContain('专业审核资格加载失败：资格服务暂不可用')
  expect(wrapper.text()).not.toContain('未授权')
  expect(wrapper.find('[data-testid="retry-qualifications-multi-role"]').exists()).toBe(true)
  expect(wrapper.get('[data-testid="edit-user-multi-role"]').attributes('disabled')).toBeDefined()
})

test('专业资格仍在加载时显示逐行加载状态，不短暂谎报未授权', async () => {
  let release!: (value: unknown) => void
  const pending = new Promise(resolve => { release = resolve })
  mocks.listUserQualifications.mockReturnValueOnce(pending)
  const wrapper = mountUsers()
  await flushPromises()

  expect(wrapper.text()).toContain('多岗人员')
  expect(wrapper.text()).toContain('专业审核资格加载中…')
  expect(wrapper.text()).not.toContain('未授权')
  expect(wrapper.get('[data-testid="edit-user-multi-role"]').attributes('disabled')).toBeDefined()

  release([])
  await pending
  await flushPromises()
})

test('部分专业资格加载失败只标记对应人员，重试成功后恢复真实资格', async () => {
  const userB = { ...users[0], username: 'user-b', name: '乙人员', roles: ['report_editor'] }
  mocks.listUsers.mockResolvedValueOnce([users[0], userB])
  mocks.listUserQualifications.mockImplementation(async (username: string) => {
    if (username === 'user-b') throw new Error('乙人员资格加载失败')
    return qualifications
  })
  const wrapper = mountUsers()
  await flushPromises()

  expect(wrapper.text()).toContain('采样复核')
  expect(wrapper.text()).toContain('专业审核资格加载失败：乙人员资格加载失败')
  expect(wrapper.find('[data-testid="retry-qualifications-multi-role"]').exists()).toBe(false)
  mocks.listUserQualifications.mockResolvedValueOnce([{ ...qualifications[0], username: 'user-b', code: 'report_approve' }])
  await wrapper.get('[data-testid="retry-qualifications-user-b"]').trigger('click')
  await flushPromises()

  expect(wrapper.text()).toContain('报告审核')
  expect(wrapper.text()).not.toContain('乙人员资格加载失败')
})
