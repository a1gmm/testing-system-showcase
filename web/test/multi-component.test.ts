import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { normalizeComponents } from '../src/data/multiComponent'
import templates from '../src/data/templates.json'

vi.mock('../src/api', () => ({ api: {}, currentUser: { value: null } }))

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }))
vi.mock('element-plus', () => ({ ElMessage: { warning: warnMock, success: vi.fn(), error: vi.fn() } }))

const { resolveSchemaMock } = vi.hoisted(() => ({ resolveSchemaMock: vi.fn() }))
vi.mock('../src/data/schemas', () => ({ resolveSchema: (...args: any[]) => resolveSchemaMock(...args) }))

import StructuredSheet from '../src/components/StructuredSheet.vue'

const BTX = ['苯', '甲苯', '乙苯', '对二甲苯', '间二甲苯', '邻二甲苯', '异丙苯', '苯乙烯']

describe('normalizeComponents 口径', () => {
  it('数组原样通过（HJ-TC-202/611 形态）', () => {
    expect(normalizeComponents(BTX)).toEqual({ list: BTX, error: null })
  })

  it('顿号分隔的字符串切成数组（HJ-TC-203 形态）', () => {
    expect(normalizeComponents(BTX.join('、'))).toEqual({ list: BTX, error: null })
  })

  it('切出来的组分去空白、丢空项', () => {
    expect(normalizeComponents(' 苯 、、 甲苯 ').list).toEqual(['苯', '甲苯'])
    expect(normalizeComponents([' 苯 ', '', '甲苯']).list).toEqual(['苯', '甲苯'])
  })

  it('没有 components 的表（绝大多数）不算多组分，也不报错', () => {
    expect(normalizeComponents(undefined)).toEqual({ list: [], error: null })
    expect(normalizeComponents(null)).toEqual({ list: [], error: null })
  })

  it('components 存在但既非数组也非可切分字符串 —— 报错，不静默', () => {
    for (const bad of [42, {}, true, '', '   ', ['', ' '], []]) {
      const r = normalizeComponents(bad)
      expect(r.list).toEqual([])
      expect(r.error, `${JSON.stringify(bad)} 应给出可见提示`).toBeTruthy()
    }
  })
})

describe('templates.json 的 components 已规范成数组', () => {
  it('每张带 components 的表都是非空字符串数组', () => {
    const withComp = (templates as any[]).filter(t => t.meta && 'components' in t.meta)
    expect(withComp.length).toBeGreaterThan(0)
    for (const t of withComp) {
      expect(Array.isArray(t.meta.components), `${t.code} 的 components 应为数组`).toBe(true)
      expect(t.meta.components.length, `${t.code} 的 components 不应为空`).toBeGreaterThan(0)
      for (const c of t.meta.components) expect(typeof c).toBe('string')
    }
  })

  it('HJ-TC-203 与 202 的组分一致', () => {
    const get = (code: string) => (templates as any[]).find(t => t.code === code)?.meta?.components
    expect(get('HJ-TC-203')).toEqual(BTX)
    expect(get('HJ-TC-202')).toEqual(BTX)
  })
})

const fixtureSchema = {
  id: 'fixture-multi',
  title: () => '多组分夹具表',
  columns: [{ key: 'id', label: '样品编号', kind: 'id', w: 100 }],
  meta: [],
  signRoles: ['检验'],
  seed: () => [{ id: 'F1' }],
}

const mountOpts = {
  props: { analyte: '苯系物', method: '气相色谱', matrix: '水质', code: 'HJ-TC-203', sheetType: '原始记录' },
  global: { stubs: { ElIcon: true, ElButton: true } },
}

describe('StructuredSheet 多组分识别', () => {
  beforeEach(() => {
    warnMock.mockClear()
    resolveSchemaMock.mockReturnValue(fixtureSchema)
  })

  it('components 是数组时，每个组分各一个切换页签', () => {
    const w = mount(StructuredSheet, { ...mountOpts, props: { ...mountOpts.props, tplMeta: { components: BTX } } })
    expect(w.findAll('.ctab')).toHaveLength(8)
  })

  it('components 是顿号字符串时同样生效，不再静默退化成单曲线', () => {
    const w = mount(StructuredSheet, { ...mountOpts, props: { ...mountOpts.props, tplMeta: { components: BTX.join('、') } } })
    const tabs = w.findAll('.ctab')
    expect(tabs).toHaveLength(8)
    expect(tabs.map(t => t.text())).toEqual(BTX)
  })

  it('components 形态不认识时弹出可见告警，而不是静默按单曲线渲染', () => {
    mount(StructuredSheet, { ...mountOpts, props: { ...mountOpts.props, tplMeta: { components: 42 } } })
    expect(warnMock).toHaveBeenCalledTimes(1)
    expect(warnMock.mock.calls[0][0]).toContain('HJ-TC-203')
  })

  it('没有 components 的普通表不告警', () => {
    mount(StructuredSheet, { ...mountOpts, props: { ...mountOpts.props, tplMeta: { instrument: '3420A气相色谱仪' } } })
    expect(warnMock).not.toHaveBeenCalled()
  })
})
