import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getRoundSheet: vi.fn(),
}))

vi.mock('../src/api', () => ({
  currentUser: { value: { name: '赵采样' } },
  api: {
    getRoundSheet: mocks.getRoundSheet,
    listRefMaterials: vi.fn(async () => []),
    listReagents: vi.fn(async () => []),
  },
}))

import StructuredSheet from '../src/components/StructuredSheet.vue'

const initialData = {
  meta: { date: '2026-08-01', org: '计划单位', projectNo: 'WT2026-0005' },
  rows: [{ point: '计划排污口', item: '化学需氧量', volume: '500', preserve: 'G3' }],
}

function mountSheet() {
  return mount(StructuredSheet, {
    props: {
      analyte: '化学需氧量', method: '', matrix: '废水', code: 'HJ-TC-136',
      sheetType: '采样记录', roundId: 'ROUND-1', initialData,
    },
    global: {
      stubs: {
        ElButton: true, ElIcon: true, ElSelect: true, ElOption: true,
        RecordAttachments: true,
      },
    },
  })
}

describe('StructuredSheet 期次计划初始值', () => {
  beforeEach(() => mocks.getRoundSheet.mockReset())

  it('新表使用计划初始值', async () => {
    mocks.getRoundSheet.mockResolvedValue(null)
    const wrapper = mountSheet()
    await flushPromises()
    const state = (wrapper.vm as any).$?.setupState || (wrapper.vm as any)
    expect(state.meta).toMatchObject({ date: '2026-08-01', org: '计划单位', projectNo: 'WT2026-0005' })
    expect(state.rows[0]).toMatchObject({ point: '计划排污口', item: '化学需氧量', volume: '500', preserve: 'G3' })
    expect(state.rows).toHaveLength(17)
    expect(state.rows[1]).toMatchObject({ point: '', item: '', volume: '', preserve: '' })
  })

  it('已有保存数据在加载后覆盖计划初始值', async () => {
    mocks.getRoundSheet.mockResolvedValue({
      updated_at: '2026-08-02T01:00:00Z',
      data: {
        meta: { date: '2026-08-02', org: '现场修正单位', projectNo: 'WT2026-0005' },
        rows: [{ point: '现场排污口', item: '化学需氧量', volume: '1000', preserve: 'G7' }],
      },
    })
    const wrapper = mountSheet()
    await flushPromises()
    const state = (wrapper.vm as any).$?.setupState || (wrapper.vm as any)
    expect(state.meta).toMatchObject({ date: '2026-08-02', org: '现场修正单位' })
    expect(state.rows[0]).toMatchObject({ point: '现场排污口', volume: '1000', preserve: 'G7' })
  })
})
