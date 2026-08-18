import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import KvBlock from '../src/components/sections/KvBlock.vue'
describe('KvBlock', () => {
  it('renders labels and binds inputs', async () => {
    const meta: Record<string, any> = {}
    const section = { type: 'kv', id: 'h', cols: 2, rows: [
      { label: '受检单位', key: 'org' },
      { label: '检测依据', key: 'basis', checks: ['GB20952-2020', '其他'], checksKey: 'basisChk' },
    ] }
    const w = mount(KvBlock, { props: { section, meta } })
    expect(w.text()).toContain('受检单位')
    expect(w.text()).toContain('检测依据')
    const input = w.get('input')
    await input.setValue('潍柴')
    expect(meta.org).toBe('潍柴')
  })
})
