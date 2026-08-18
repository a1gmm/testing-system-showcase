import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('../src/api', () => ({ api: {}, currentUser: { value: null } }))
const { resolveSchemaMock } = vi.hoisted(() => ({ resolveSchemaMock: vi.fn() }))
vi.mock('../src/data/schemas', () => ({ resolveSchema: (...a: any[]) => resolveSchemaMock(...a) }))

import StructuredSheet from '../src/components/StructuredSheet.vue'
import { FORMS } from '../src/data/forms'

const mountWith = (code: string) => {
  resolveSchemaMock.mockReturnValue(FORMS[code])
  return mount(StructuredSheet, {
    props: { analyte: '', method: '', matrix: '废气', code, sheetType: '采样记录' },
    global: { stubs: { ElIcon: true, ElButton: true } },
  })
}

describe('新建现场表版式冒烟', () => {
  const codes = ['HJ-TC-133','HJ-TC-141','HJ-TC-147','HJ-TC-461','HJ-TC-561','HJ-TC-564','HJ-TC-605','HJ-TC-609','HJ-TC-632','HJ-TC-710','HJ-TC-733']

  it('11张都能挂载渲染不崩', () => {
    for (const c of codes) {
      const w = mountWith(c)
      expect(w.text().length).toBeGreaterThan(0)
    }
  })

  it('605加油站带勾选项渲染出关键字段', () => {
    const w = mountWith('HJ-TC-605')
    expect(w.text()).toContain('加油站名称')
    expect(w.text()).toContain('真空泵型号')
  })

  it('461 CEMS比对矩阵+数据对差列渲染', () => {
    const w = mountWith('HJ-TC-461')
    expect(w.text()).toContain('数据对差')
    expect(w.text()).toContain('相对准确度')
  })

  it('461 compute: 数据对差=CEMS(B)-手工(A)', () => {
    const f = FORMS['HJ-TC-461'] as any
    const r = f.compute({ so2Manual: '10', so2Cems: '13' }, { reg: { a: 0, b: 0 }, meta: {} })
    expect(r.so2Diff).toBe(3)
  })
})
