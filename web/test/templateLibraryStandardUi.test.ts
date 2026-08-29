import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import TemplateLibrary from '../src/pages/TemplateLibrary.vue'

const stubs = {
  StructuredSheet: true,
  ElInput: { template: '<input />' },
  ElButton: { template: '<button><slot /></button>' },
  ElIcon: { template: '<span><slot /></span>' },
  Search: true,
  Document: true,
  Edit: true,
}

describe('模板库标准状态界面', () => {
  test('展示逐文件闭环后的全量状态统计', () => {
    const wrapper = mount(TemplateLibrary, { global: { stubs } })

    expect(wrapper.text()).toContain('465 张检测记录表')
    expect(wrapper.text()).toContain('已核验391')
    expect(wrapper.text()).toContain('管理记录25')
    expect(wrapper.text()).toContain('受控方法23')
    expect(wrapper.text()).toContain('旧版0')
    expect(wrapper.text()).toContain('待核验0')
    expect(wrapper.text()).toContain('已停用26')
  })

  test('管理记录显示核验理由而不是伪造标准', async () => {
    const wrapper = mount(TemplateLibrary, { global: { stubs } })
    const handoff = wrapper.findAll('.item').find(item => item.text().includes('135-废水样品交接记录表'))

    expect(handoff).toBeTruthy()
    await handoff!.trigger('click')
    const evidenceButton = wrapper.findAll('button').find(button => button.text() === '依据资料')
    await evidenceButton!.trigger('click')

    expect(wrapper.text()).toContain('管理记录不对应单一检测标准')
    expect(wrapper.text()).toContain('样品交接和运储检查记录')
    expect(wrapper.text()).toContain('核验来源：记录用途分类')
  })

  test('受控方法明确提示必须关联有效 SOP，不冒充国家标准', async () => {
    const wrapper = mount(TemplateLibrary, { global: { stubs } })
    const controlled = wrapper.findAll('.item').find(item => item.text().includes('045-环境空气原子吸收分光光度法原始记录表--铬及化合物'))

    expect(controlled).toBeTruthy()
    await controlled!.trigger('click')
    const evidenceButton = wrapper.findAll('button').find(button => button.text() === '依据资料')
    await evidenceButton!.trigger('click')

    expect(wrapper.text()).toContain('受控方法')
    expect(wrapper.text()).toContain('不得显示为现行国家标准')
    expect(wrapper.text()).toContain('必须关联有效SOP')
  })

  test('未来标准只显示实施预告，不写进当前依据', async () => {
    const wrapper = mount(TemplateLibrary, { global: { stubs } })
    const fixedSource = wrapper.findAll('.item').find(item => item.text().includes('140-烟尘（颗粒物）烟气监测原始记录表'))

    expect(fixedSource).toBeTruthy()
    await fixedSource!.trigger('click')
    const evidenceButton = wrapper.findAll('button').find(button => button.text() === '依据资料')
    await evidenceButton!.trigger('click')

    expect(wrapper.text()).toContain('即将实施：HJ 1405-2024')
    expect(wrapper.text()).toContain('2027-01-01 起')
    expect(wrapper.find('.vbadge').text()).not.toContain('HJ 1405-2024')
  })
})
