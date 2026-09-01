import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getRecord: vi.fn(async () => null),
  getRoundSheet: vi.fn(async () => null),
  listInstruments: vi.fn(async () => []),
  listRefMaterials: vi.fn(async () => []),
  listReagents: vi.fn(async () => []),
  getAudit: vi.fn(async () => []),
}))

vi.mock('../src/api', () => ({
  currentUser: ref({ username: 'viewer', name: '查看人', roles: ['report_editor'], status: 'active', created_at: '' }),
  api: mocks,
}))

import StructuredSheet from '../src/components/StructuredSheet.vue'

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockClear()
})

test('归档冻结模式只渲染传入快照，不请求当前记录或资源台账', async () => {
  const frozenData = {
    rows: [{ id: 'W260831-1', vSample: '10.00', c: '24.6' }],
    meta: { date: '2026-08-31', signer: '分析员甲', analyte: '化学需氧量' },
    cells: {},
    resultSummary: { analyte: '化学需氧量', value: 24.6, unit: 'mg/L' },
  }
  const wrapper = mount(StructuredSheet, {
    props: {
      sampleId: 'W260831-1', analyte: '化学需氧量', method: '重铬酸盐法', matrix: '废水',
      code: 'HJ-TC-103', file: '0100.pdf', sheetType: '原始记录', templateName: '化学需氧量(CODcr)',
      frozenData, frozenInstrumentId: 'TC-008', readonly: true,
    },
    global: {
      stubs: {
        ElIcon: true,
        ElButton: { template: '<button><slot /></button>' },
        ElSelect: true,
        ElOption: true,
        RecordAttachments: true,
      },
    },
  })
  await flushPromises()

  const state = (wrapper.vm as any).$?.setupState || (wrapper.vm as any)
  expect(state.rows[0]).toMatchObject({ id: 'W260831-1', vSample: '10.00', c: '24.6' })
  expect(state.meta).toMatchObject({ date: '2026-08-31', signer: '分析员甲' })
  expect(state.instrumentId).toBe('TC-008')
  expect(wrapper.text()).toContain('归档冻结快照')
  expect(wrapper.text()).not.toContain('系统里能填能算')
  expect(wrapper.find('.savebar').exists()).toBe(false)
  expect(wrapper.findAll('input.f, textarea.f').every(input => (input.element as HTMLInputElement).disabled)).toBe(true)
  expect(mocks.getRecord).not.toHaveBeenCalled()
  expect(mocks.getRoundSheet).not.toHaveBeenCalled()
  expect(mocks.listInstruments).not.toHaveBeenCalled()
  expect(mocks.listRefMaterials).not.toHaveBeenCalled()
  expect(mocks.listReagents).not.toHaveBeenCalled()
})

test('冻结属性本身就会锁表且不会把当前查看人补成历史签字人', async () => {
  const wrapper = mount(StructuredSheet, {
    props: {
      sampleId: 'W260831-2', analyte: '化学需氧量', method: '重铬酸盐法', matrix: '废水',
      code: 'HJ-TC-103', file: '0100.pdf', sheetType: '原始记录', templateName: '化学需氧量(CODcr)',
      frozenData: { rows: [{ id: 'W260831-2' }], meta: {}, cells: {} },
    },
    global: {
      stubs: {
        ElIcon: true,
        ElButton: { template: '<button><slot /></button>' },
        ElSelect: true,
        ElOption: true,
        RecordAttachments: true,
      },
    },
  })
  await flushPromises()

  const state = (wrapper.vm as any).$?.setupState || (wrapper.vm as any)
  expect(state.locked).toBe(true)
  expect(state.meta.signer || '').toBe('')
  expect(wrapper.find('.savebar').exists()).toBe(false)
})
