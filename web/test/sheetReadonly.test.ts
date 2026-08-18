// 岗位门禁：无 round_field 权限的人（如质控员）打开期次采样表 → 只读，不能填不能存。
// 起因：2026-07-29 实测吴质控(qc)登录后能填现场采样表——页面能进，段落没锁。
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'

vi.mock('../src/api', () => ({
  api: {
    getRoundSheet: vi.fn().mockResolvedValue(null),
    listInstruments: vi.fn().mockResolvedValue([]),
    getRecord: vi.fn().mockResolvedValue(null),
    getAudit: vi.fn().mockResolvedValue([]),
  },
  currentUser: ref({ username: 'demo_qc', name: '吴质控', roles: ['qc'] }),
}))
const { resolveSchemaMock } = vi.hoisted(() => ({ resolveSchemaMock: vi.fn() }))
vi.mock('../src/data/schemas', () => ({ resolveSchema: (...a: any[]) => resolveSchemaMock(...a) }))

import StructuredSheet from '../src/components/StructuredSheet.vue'
import { FORMS } from '../src/data/forms'

const mountSheet = (readonly: boolean) => {
  resolveSchemaMock.mockReturnValue(FORMS['HJ-TC-136'])
  return mount(StructuredSheet, {
    props: { analyte: '', method: '', matrix: '废水', code: 'HJ-TC-136', sheetType: '采样记录', roundId: 'WT2026-0001-R01', readonly },
    global: { stubs: { ElIcon: true, ElButton: { template: '<button class="stub-btn"><slot/></button>' } } },
  })
}

describe('期次采样表 readonly 门禁（质控员只读）', () => {
  it('readonly 时输入框全部禁用、没有保存按钮', () => {
    const w = mountSheet(true)
    const inputs = w.findAll('input.f, textarea.f').filter(i => !(i.element as HTMLInputElement).disabled)
    expect(inputs.length).toBe(0)
    expect(w.find('.savebar .stub-btn').exists()).toBe(false)
    expect(w.text()).toContain('只有采样员能填这张表')
  })

  it('采样员本人（非 readonly）照常可填可存', () => {
    const w = mountSheet(false)
    const enabled = w.findAll('input.f').filter(i => !(i.element as HTMLInputElement).disabled)
    expect(enabled.length).toBeGreaterThan(0)
    expect(w.find('.savebar .stub-btn').exists()).toBe(true)
  })
})

// 同样的门禁在检测录入（sample 模式）也要生效：
// 质控员进「选表录数据」不能白填整张实验室记录表（后端保存会 403，前端就该先锁）
describe('检测记录 readonly 门禁（sample 模式）', () => {
  const mountSample = (readonly: boolean) => {
    resolveSchemaMock.mockReturnValue(FORMS['HJ-TC-136'])
    return mount(StructuredSheet, {
      props: {
        analyte: '', method: '', matrix: '废水', code: 'HJ-TC-136', sheetType: '原始记录',
        sampleId: 'WT2026-0001-01', readonly, lockText: '只有检测员能填写检测原始记录',
      },
      global: { stubs: { ElIcon: true, ElButton: { template: '<button class="stub-btn"><slot/></button>' } } },
    })
  }

  it('readonly 时输入框全部禁用、没有保存/提交按钮、提示按检测场景给', () => {
    const w = mountSample(true)
    const enabled = w.findAll('input.f, textarea.f').filter(i => !(i.element as HTMLInputElement).disabled)
    expect(enabled.length).toBe(0)
    expect(w.find('.savebar .stub-btn').exists()).toBe(false)
    expect(w.text()).toContain('只有检测员能填写检测原始记录')
    // 采样场景的旧文案不能串进检测场景
    expect(w.text()).not.toContain('只有采样员能填这张表')
  })

  it('检测员本人（非 readonly）照常可填可存', () => {
    const w = mountSample(false)
    const enabled = w.findAll('input.f').filter(i => !(i.element as HTMLInputElement).disabled)
    expect(enabled.length).toBeGreaterThan(0)
    expect(w.find('.savebar .stub-btn').exists()).toBe(true)
  })
})
