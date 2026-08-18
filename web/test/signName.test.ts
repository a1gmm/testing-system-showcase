import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'

vi.mock('../src/api', () => ({ api: {}, currentUser: ref({ username: 'demo_sampler', name: '赵采样', roles: ['sampler'] }) }))
const { resolveSchemaMock } = vi.hoisted(() => ({ resolveSchemaMock: vi.fn() }))
vi.mock('../src/data/schemas', () => ({ resolveSchema: (...a: any[]) => resolveSchemaMock(...a) }))

import StructuredSheet from '../src/components/StructuredSheet.vue'
import { FORMS } from '../src/data/forms'

const mountWith = (code: string) => {
  resolveSchemaMock.mockReturnValue(FORMS[code])
  return mount(StructuredSheet, {
    props: { analyte: '', method: '', matrix: '废水', code, sheetType: '采样记录' },
    global: { stubs: { ElIcon: true, ElButton: true } },
  })
}

describe('签名栏显示当前登录人（不再写死陈检测）', () => {
  it('默认显示当前登录账号姓名', () => {
    const w = mountWith('HJ-TC-136')
    expect(w.text()).not.toContain('陈检测')
    const input = w.find('.sign input.signer')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('赵采样')
  })

  it('可以手动改名/加名字', async () => {
    const w = mountWith('HJ-TC-136')
    const input = w.find('.sign input.signer')
    await input.setValue('赵采样、许技术')
    expect((input.element as HTMLInputElement).value).toBe('赵采样、许技术')
  })
})
