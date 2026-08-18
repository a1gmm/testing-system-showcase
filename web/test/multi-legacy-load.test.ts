import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'

// v-model 绑定的值只在 DOM property 上，不会序列化进 html()，只能逐个读 input 的实际值
const inputValues = (w: VueWrapper<any>) =>
  w.findAll('input').map(i => (i.element as HTMLInputElement).value).filter(v => v !== '')

// 一张表从单组分改成多组分后（templates.json 的 meta.components 由字符串改为数组），
// 改之前存的老记录只有 data.rows、没有 data.compRows。多组分模式下 activeRows 只读 compRows，
// 老数据若不归位就会在界面上凭空消失，分析员一保存就被 8 套空种子覆盖 —— 合规记录的静默数据丢失。
const { getRecordMock } = vi.hoisted(() => ({ getRecordMock: vi.fn() }))
vi.mock('../src/api', () => ({
  api: {
    getRecord: (...a: any[]) => getRecordMock(...a),
    getAudit: vi.fn().mockResolvedValue([]),
    listInstruments: vi.fn().mockResolvedValue([]),
  },
  hasRole: () => true,
  currentUser: { value: null },
}))

const { resolveSchemaMock } = vi.hoisted(() => ({ resolveSchemaMock: vi.fn() }))
vi.mock('../src/data/schemas', () => ({ resolveSchema: (...a: any[]) => resolveSchemaMock(...a) }))

import StructuredSheet from '../src/components/StructuredSheet.vue'

const multiSchema = {
  id: 'fixture-multi',
  title: () => '多组分夹具表',
  columns: [
    { key: 'id', label: '样品编号', kind: 'id', w: 100 },
    { key: 'area', label: '峰面积', kind: 'input', w: 90 },
  ],
  meta: [{ label: '仪器型号', key: 'instrument' }],
  signRoles: ['检验'],
  seed: () => [{ id: '', area: '' }],
}

const mountOpts = {
  props: {
    analyte: '苯系物', method: '气相色谱', matrix: '', code: 'HJ-TC-203', sheetType: '原始记录',
    sampleId: 'S-2026-0001',
    tplMeta: { components: ['苯', '甲苯', '乙苯'] },
  },
  global: { stubs: { ElIcon: true, ElButton: true } },
}

describe('多组分表读取改版前的老记录', () => {
  beforeEach(() => {
    resolveSchemaMock.mockReturnValue(multiSchema)
    getRecordMock.mockReset()
  })

  it('老记录只有 rows、没有 compRows 时，数据不能在界面上消失', async () => {
    getRecordMock.mockResolvedValue({
      id: 'R-1', status: 'draft',
      data: { rows: [{ id: 'F-9', area: 0.777 }], meta: { instrument: 'GC-3420A' }, reg: {} },
    })
    const w = mount(StructuredSheet, mountOpts)
    await flushPromises()
    expect(inputValues(w)).toContain('F-9')
    expect(inputValues(w)).toContain('0.777')
  })

  it('新记录有 compRows 时照常按组分加载', async () => {
    getRecordMock.mockResolvedValue({
      id: 'R-2', status: 'draft',
      data: {
        rows: [{ id: 'F-1', area: 0.1 }],
        compRows: { 苯: [{ id: 'F-1', area: 0.1 }], 甲苯: [{ id: 'F-2', area: 0.2 }], 乙苯: [{ id: 'F-3', area: 0.3 }] },
        meta: {}, reg: {},
      },
    })
    const w = mount(StructuredSheet, mountOpts)
    await flushPromises()
    expect(inputValues(w)).toContain('F-1')   // 首个组分「苯」的数据
    expect(inputValues(w)).not.toContain('F-2')   // 甲苯的数据不该串到苯的表格里
  })
})
