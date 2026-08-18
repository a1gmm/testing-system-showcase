import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('../src/api', () => ({ api: {}, currentUser: { value: null } }))

const { resolveSchemaMock } = vi.hoisted(() => ({ resolveSchemaMock: vi.fn() }))
vi.mock('../src/data/schemas', () => ({ resolveSchema: (...args: any[]) => resolveSchemaMock(...args) }))

import StructuredSheet from '../src/components/StructuredSheet.vue'

// 夹具照搬 specialForms 的写法：表级常量用 meta[].value 声明（如 HJ-TC-118 的 Saltzman 系数）
const constFixtureSchema = {
  id: 'fixture-const',
  title: () => '常量夹具表',
  columns: [{ key: 'id', label: '样品编号', kind: 'id', w: 100 }],
  meta: [
    { label: 'Saltzman系数f', key: 'saltzman', fixed: true, value: '0.88' },
    { label: '测定波长', key: 'wavelength', fixed: true, value: '540nm' },
    { label: '仪器编号', key: 'instrumentNo' },
  ],
  signRoles: ['检验'],
  seed: () => [{ id: 'F1' }],
}

const mountOpts = {
  props: { analyte: '', method: '', matrix: '废气', code: 'HJ-TC-TEST', sheetType: '原始记录' },
  global: { stubs: { ElIcon: true, ElButton: true } },
}

describe('schema 表级常量 meta[].value', () => {
  it('templates.json 没给的常量，用 schema 声明的 value 兜底显示', () => {
    resolveSchemaMock.mockReturnValue(constFixtureSchema)
    const w = mount(StructuredSheet, mountOpts)
    expect(w.text()).toContain('0.88')
    expect(w.text()).toContain('540nm')
  })

  it('原件抽出的 tplMeta 覆盖 schema 的缺省常量', () => {
    resolveSchemaMock.mockReturnValue(constFixtureSchema)
    const w = mount(StructuredSheet, { ...mountOpts, props: { ...mountOpts.props, tplMeta: { wavelength: '220nm、275nm' } } })
    expect(w.text()).toContain('220nm、275nm')
    expect(w.text()).not.toContain('540nm')
  })
})
