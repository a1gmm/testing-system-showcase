import { afterEach, describe, expect, test, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('../src/api', () => ({ api: {}, currentUser: { value: null } }))

import StructuredSheet from '../src/components/StructuredSheet.vue'
import templates from '../src/data/templates.json'
import { isTemplateReadyForEntry } from '../src/data/templateEntry'

const structuredSheetStubs = {
  ElIcon: true,
  ElButton: true,
  'el-option': true,
  'el-select': true,
  Lock: true,
  MagicStick: true,
  Finished: true,
  RecordAttachments: true,
}

const activeTemplates = templates.filter(isTemplateReadyForEntry)
const renderBatches = Array.from({ length: 10 }, (_, index) => activeTemplates.slice(index * 44, (index + 1) * 44))

function mountTemplate(template: (typeof templates)[number]) {
  return mount(StructuredSheet, {
    props: {
      analyte: template.analyte,
      method: template.method,
      matrix: template.matrix,
      file: template.file,
      code: template.code,
      sheetType: template.sheetType,
      templateName: template.name,
      tplMeta: template.meta,
    },
    global: {
      stubs: structuredSheetStubs,
    },
  })
}

afterEach(() => vi.restoreAllMocks())

describe('全部正式录入模板渲染', () => {
  test('结构化表单测试环境不会留下未注册组件警告', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const wrapper = mountTemplate(activeTemplates[0]!)

    const unresolved = warn.mock.calls.filter(([message]) => String(message).includes('Failed to resolve component'))
    warn.mockRestore()
    wrapper.unmount()
    expect(unresolved).toEqual([])
  })

  test('正式录入清单保持 439 张启用原表', () => {
    expect(activeTemplates).toHaveLength(439)
  })

  test.each(renderBatches.map(batch => [batch] as const))('启用原表批次 %# 逐张挂载、解析专用版式且能产生可见内容', (batch) => {
    for (const template of batch) {
      const wrapper = mountTemplate(template)
      expect(wrapper.text().trim().length, `${template.file} ${template.code}`).toBeGreaterThan(0)
      wrapper.unmount()
    }
  })
})
