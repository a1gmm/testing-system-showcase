import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

const mocks = vi.hoisted(() => ({
  getRecord: vi.fn(),
  saveRecord: vi.fn(),
  saveRecordsBatch: vi.fn(),
}))

vi.mock('../src/api', () => ({
  currentUser: ref({ username: 'analyst1', name: '检测员一', roles: ['analyst'] }),
  hasRole: () => true,
  api: {
    getRecord: mocks.getRecord,
    saveRecord: mocks.saveRecord,
    saveRecordsBatch: mocks.saveRecordsBatch,
    getAudit: vi.fn(async () => []),
    listInstruments: vi.fn(async () => []),
    listRefMaterials: vi.fn(async () => []),
    listReagents: vi.fn(async () => []),
  },
}))

import StructuredSheet from '../src/components/StructuredSheet.vue'
import BatchEntry from '../src/components/BatchEntry.vue'

type PersistCase = {
  name: string
  code: string
  analyte: string
  rows: Record<string, number | string>[]
  meta?: Record<string, number>
  expected: { analyte: string; value: number; unit: string }
}

const cases: PersistCase[] = [
  {
    name: 'BOD5 layout result',
    code: 'HJ-TC-071',
    analyte: '五日生化需氧量',
    rows: [
      { c1: 8, c2: 3, f: 2, bcorr: 0 },
      { c1: 100, c2: 0, f: 10, bcorr: 0, note: '全程序空白' },
      { c1: 9, c2: 4, f: 4, bcorr: 0 },
    ],
    expected: { analyte: '五日生化需氧量', value: 15, unit: 'mg/L' },
  },
  {
    name: 'COD layout result',
    code: 'HJ-TC-103',
    analyte: '化学需氧量',
    rows: [{ v0: 25, v1: 15, V: 50, f: 1 }],
    meta: { c: 0.25 },
    expected: { analyte: '化学需氧量', value: 400, unit: 'mg/L' },
  },
  {
    name: 'chlorophyll-a layout result',
    code: 'HJ-TC-601',
    analyte: '叶绿素a',
    rows: [{ a664: 0.5, a647: 0.1, a630: 0.05, a750: 0, ve: 10, vs: 1, d: 1 }],
    expected: { analyte: '叶绿素a', value: 57.67, unit: 'μg/L' },
  },
]

describe('laboratory result persistence contract', () => {
  beforeEach(() => {
    mocks.getRecord.mockReset().mockResolvedValue(null)
    mocks.saveRecord.mockReset().mockResolvedValue({
      id: 'REC-1', status: 'draft', updated_at: '2026-08-25T20:00:00.000Z',
    })
    mocks.saveRecordsBatch.mockReset().mockResolvedValue([{ id: 'REC-BATCH-1' }])
  })

  for (const c of cases) {
    it(`persists ${c.name} as the report result`, async () => {
      const wrapper = mount(StructuredSheet, {
        props: {
          analyte: c.analyte,
          method: '',
          matrix: '废水',
          code: c.code,
          sheetType: '原始记录',
          sampleId: 'SAMPLE-1',
        },
        global: {
          stubs: {
            ElButton: true,
            ElIcon: true,
            ElSelect: true,
            ElOption: true,
            RecordAttachments: true,
          },
        },
      })
      await flushPromises()

      const state = (wrapper.vm as any).$?.setupState || (wrapper.vm as any)
      c.rows.forEach((row, index) => Object.assign(state.rows[index], row))
      if (c.meta) Object.assign(state.meta, c.meta)

      await state.save(false)
      await flushPromises()

      expect(mocks.saveRecord).toHaveBeenCalledOnce()
      expect(mocks.saveRecord.mock.calls[0][0].data.resultSummary).toEqual(c.expected)
    })
  }

  it('persists the same COD layout result through batch entry', async () => {
    const sample = {
      id: 'SAMPLE-1', client: '测试单位', matrix: '废水', items: ['化学需氧量'], status: 'testing', note: '',
      contract_id: 'WT2026-0001', round_id: 'WT2026-0001-R01', source: 'field', point_name: null,
      created_at: '2026-08-25T20:00:00.000Z',
    }
    const wrapper = mount(BatchEntry, {
      props: { samples: [sample], myTasks: [] },
      global: {
        stubs: {
          ElButton: true,
          ElIcon: true,
        },
      },
    })
    const state = (wrapper.vm as any).$?.setupState || (wrapper.vm as any)
    state.tplKeyword = 'HJ-TC-103'
    await wrapper.vm.$nextTick()
    state.tpl = state.candidates.find((item: any) => item.analyte === '化学需氧量')
    await wrapper.vm.$nextTick()
    state.toggle(sample)
    Object.assign(state.rows[sample.id], { v0: 25, v1: 15, V: 50, f: 1 })
    state.sharedMeta.c = 0.25

    await state.saveAll(false)
    await flushPromises()

    expect(mocks.saveRecordsBatch).toHaveBeenCalledOnce()
    expect(mocks.saveRecordsBatch.mock.calls[0][0].entries[0].resultSummary).toEqual({
      analyte: '化学需氧量', value: 400, unit: 'mg/L',
    })
  })
})
