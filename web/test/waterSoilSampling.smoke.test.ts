import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('../src/api', () => ({ api: {}, currentUser: { value: null } }))
const { resolveSchemaMock } = vi.hoisted(() => ({ resolveSchemaMock: vi.fn() }))
vi.mock('../src/data/schemas', () => ({ resolveSchema: (...a: any[]) => resolveSchemaMock(...a) }))

import StructuredSheet from '../src/components/StructuredSheet.vue'
import { FORMS } from '../src/data/forms'

const mountWith = (code: string, matrix = '废水') => {
  resolveSchemaMock.mockReturnValue(FORMS[code])
  return mount(StructuredSheet, {
    props: { analyte: '', method: '', matrix, code, sheetType: '采样记录' },
    global: { stubs: { ElIcon: true, ElButton: true } },
  })
}

describe('水/土采样单精确版式冒烟（136/146/201/591）', () => {
  const codes = ['HJ-TC-136', 'HJ-TC-146', 'HJ-TC-201', 'HJ-TC-591']

  it('4张都进了 FORMS（现场选表能命中精确版式）', () => {
    for (const c of codes) expect(FORMS[c], c).toBeTruthy()
  })

  it('4张都能挂载渲染不崩', () => {
    for (const c of codes) {
      const w = mountWith(c)
      expect(w.text().length, c).toBeGreaterThan(0)
    }
  })

  it('136 水和废水：受检单位 + 样品描述分组列', () => {
    const w = mountWith('HJ-TC-136')
    expect(w.text()).toContain('受检单位名称')
    expect(w.text()).toContain('漂浮物')
    expect(w.text()).toContain('保存容器及方法')
  })

  it('146 地下水：水深/井深列', () => {
    const w = mountWith('HJ-TC-146', '地下水')
    expect(w.text()).toContain('水深')
    expect(w.text()).toContain('井深')
  })

  it('201 土壤：质地/湿度勾选项 + 采样量列', () => {
    const w = mountWith('HJ-TC-201', '土壤')
    expect(w.text()).toContain('土壤质地')
    expect(w.text()).toContain('砂壤土')
    expect(w.text()).toContain('采样量')
  })

  it('591 地表水：断面信息 + 前处理方式列', () => {
    const w = mountWith('HJ-TC-591', '地表水')
    expect(w.text()).toContain('断面周边环境描述')
    expect(w.text()).toContain('前处理方式')
  })
})
