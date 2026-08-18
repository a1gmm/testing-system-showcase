import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MatrixGrid from '../src/components/sections/MatrixGrid.vue'
describe('MatrixGrid', () => {
  it('renders col headers, const row values, and binds a cell', async () => {
    const cells: Record<string, any> = {}
    const section = { type:'matrix', id:'m', transpose:true,
      rowHeaders:[{label:'对数值',key:'lg',kind:'const',value:'1.00'},{label:'注入量',key:'inj',kind:'input'}],
      colHeaders:[{label:'10',key:'c10'},{label:'30',key:'c30'}], cellKind:'input' }
    const w = mount(MatrixGrid, { props: { section, cells } })
    expect(w.text()).toContain('对数值')
    expect(w.text()).toContain('1.00')       // const 行显示定值
    const inputs = w.findAll('input')
    await inputs[0].setValue('300ml')
    expect(cells['m.inj.c10']).toBe('300ml')
  })
})
