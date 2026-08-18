import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('../src/api', () => ({ api: {}, currentUser: { value: null } }))

// 自包含 fixture：不依赖 Task 6 才会加入的 228 表，避免任务顺序耦合
const { resolveSchemaMock } = vi.hoisted(() => ({ resolveSchemaMock: vi.fn() }))
vi.mock('../src/data/schemas', () => ({ resolveSchema: (...args: any[]) => resolveSchemaMock(...args) }))

import StructuredSheet from '../src/components/StructuredSheet.vue'

const KV_LABEL = '观测条件（夹具）'

const layoutFixtureSchema = {
  id: 'fixture-layout',
  title: () => '布局夹具表',
  columns: [{ key: 'id', label: '编号', kind: 'id', w: 80 }],
  meta: [],
  signRoles: ['检验'],
  seed: () => [{ id: 'x' }],
  layout: [
    { type: 'kv', id: 'h', cols: 1, rows: [{ label: KV_LABEL, key: 'cond' }] },
  ],
}

const legacyFixtureSchema = {
  id: 'fixture-legacy',
  title: () => '旧版夹具表',
  columns: [
    { key: 'id', label: '样品编号', kind: 'id', w: 100 },
    { key: 'val', label: '数值', kind: 'input' },
  ],
  meta: [{ label: '测量项目', key: 'analyte', fixed: true }],
  signRoles: ['检验', '复核'],
  seed: () => [{ id: 'F1', val: '' }],
}

const mountOpts = {
  props: { analyte: '', method: '', matrix: '废气', code: 'HJ-TC-TEST', sheetType: '原始记录' },
  global: { stubs: { ElIcon: true, ElButton: true } },
}

describe('StructuredSheet layout path', () => {
  it('renders layout sections when schema.layout is present', () => {
    resolveSchemaMock.mockReturnValue(layoutFixtureSchema)
    const w = mount(StructuredSheet, mountOpts)
    expect(w.text()).toContain(KV_LABEL)
    // layout 路径下不应渲染旧版单一 <table>
    expect(w.find('table').exists()).toBe(false)
  })

  it('renders legacy row table when schema.layout is absent', () => {
    resolveSchemaMock.mockReturnValue(legacyFixtureSchema)
    const w = mount(StructuredSheet, mountOpts)
    expect(w.find('table').exists()).toBe(true)
    expect(w.text()).toContain('样品编号')
    expect(w.text()).toContain('数值')
  })
})
