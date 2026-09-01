import { flushPromises, mount } from '@vue/test-utils'
import { ElMessageBox } from 'element-plus'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ref } from 'vue'
import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  hasRole: vi.fn(),
  listUsers: vi.fn(),
  listUserQualifications: vi.fn(),
  resetPassword: vi.fn(),
  setUserQualifications: vi.fn(),
  updateUser: vi.fn(),
  updateUserPersonnel: vi.fn(),
}))

vi.mock('../src/api', () => ({
  currentUser: ref({ username: 'admin', name: '管理员', roles: ['admin'], status: 'active', created_at: '2026-01-01T00:00:00.000Z' }),
  hasRole: mocks.hasRole,
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
  vi.restoreAllMocks()
  mocks.hasRole.mockReset().mockReturnValue(true)
  mocks.listUsers.mockReset().mockResolvedValue(users)
  mocks.listUserQualifications.mockReset().mockResolvedValue(qualifications)
  mocks.resetPassword.mockReset().mockResolvedValue(undefined)
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

test('高行人员的四个管理动作是边界明确且可区分的按钮组', async () => {
  mocks.listUserQualifications.mockResolvedValueOnce([
    'sampling_review', 'sampling_approve', 'quality_review', 'quality_approve',
    'laboratory_review', 'laboratory_approve', 'report_review', 'report_approve',
  ].map(code => ({ ...qualifications[0], code })))
  const wrapper = mountUsers()
  await flushPromises()

  expect(wrapper.get('.qualification-list').findAll('.qualification-item')).toHaveLength(8)
  const actions = wrapper.get('[role="group"][aria-label="管理 多岗人员"]')
  const buttons = actions.findAll('button')
  expect(buttons).toHaveLength(4)
  expect(buttons.map(button => button.attributes('type'))).toEqual(['button', 'button', 'button', 'button'])
  expect(buttons.map(button => button.attributes('aria-label'))).toEqual([
    '编辑 多岗人员', '授权 多岗人员', '重置多岗人员的密码', '停用 多岗人员',
  ])
})

test('人员台账保持宽表结构，姓名、用户名、岗位和入职日期不被操作列挤成逐字折行', async () => {
  const wrapper = mountUsers()
  await flushPromises()

  expect(wrapper.get('.pagewrap').classes()).toContain('wide')
  expect(wrapper.get('colgroup').findAll('col').map(col => col.classes()[0] || '')).toEqual([
    'person-col', 'username-col', 'roles-col', '', 'status-col', 'cert-col', 'joined-col', 'actions-col',
  ])
  expect(wrapper.get('td.nm').text()).toContain('多岗人员')
  expect(wrapper.get('td.username').text()).toBe('multi-role')
  expect(wrapper.get('td.joined-at').text()).toBe('2026-01-02')

  const source = readFileSync(resolve(process.cwd(), 'src/pages/Users.vue'), 'utf8')
  expect(source).toMatch(/\.list\{overflow-x:auto\}/)
  expect(source).toMatch(/table\{[^}]*min-width:1280px/)
  expect(source).toMatch(/\.actions-col\{width:196px\}/)
  expect(source).toMatch(/\.nm\{[^}]*white-space:nowrap/)
  expect(source).not.toMatch(/\.nm\{[^}]*display:flex/)
  expect(source).toMatch(/\.username,\.joined-at\{white-space:nowrap\}/)
  expect(source).toMatch(/\.role\{white-space:nowrap\}/)
  expect(source).toMatch(/\.acts\{min-width:196px/)
})

test('无管理员动作列时 colgroup、表头和数据列仍保持七列对齐', async () => {
  mocks.hasRole.mockReturnValue(false)
  const wrapper = mountUsers()
  await flushPromises()

  expect(wrapper.get('colgroup').findAll('col')).toHaveLength(7)
  expect(wrapper.get('thead tr').findAll('th')).toHaveLength(7)
  expect(wrapper.get('tbody tr').findAll('td')).toHaveLength(7)
  expect(wrapper.find('.actions-col').exists()).toBe(false)
  expect(wrapper.find('.action-grid').exists()).toBe(false)
})

test('停用人员显示可区分的启用动作', async () => {
  mocks.listUsers.mockResolvedValueOnce([{ ...users[0], status: 'disabled' }])
  vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as any)
  const wrapper = mountUsers()
  await flushPromises()

  const enable = wrapper.get('[aria-label="启用 多岗人员"]')
  expect(enable.text()).toBe('启用')
  expect(enable.classes()).not.toContain('danger')
  await enable.trigger('click')
  await flushPromises()
  expect(mocks.updateUser).toHaveBeenCalledWith('multi-role', { status: 'active' })
})

test('授权、重置密码和停用按钮分别调用正确管理动作', async () => {
  const prompt = vi.spyOn(ElMessageBox, 'prompt')
    .mockResolvedValueOnce({ value: '授权签字人授权书' } as any)
    .mockResolvedValueOnce({ value: '2027-12-31' } as any)
    .mockResolvedValueOnce({ value: 'new-password' } as any)
  vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as any)
  const wrapper = mountUsers()
  await flushPromises()

  await wrapper.get('[aria-label="授权 多岗人员"]').trigger('click')
  await flushPromises()
  expect(mocks.updateUser).toHaveBeenCalledWith('multi-role', {
    certName: '授权签字人授权书', certUntil: '2027-12-31',
  })

  await wrapper.get('[aria-label="重置多岗人员的密码"]').trigger('click')
  await flushPromises()
  expect(mocks.resetPassword).toHaveBeenCalledWith('multi-role', 'new-password')

  await wrapper.get('[aria-label="停用 多岗人员"]').trigger('click')
  await flushPromises()
  expect(mocks.updateUser).toHaveBeenCalledWith('multi-role', { status: 'disabled' })
  expect(prompt).toHaveBeenCalledTimes(3)
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
