import { describe, expect, test, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('../src/api', () => ({ api: {}, currentUser: { value: null } }))

import StructuredSheet from '../src/components/StructuredSheet.vue'
import templates from '../src/data/templates.json'
import { isTemplateReadyForEntry } from '../src/data/templateEntry'

describe('全部正式录入模板渲染', () => {
  test('439 张启用原表逐张挂载、解析专用版式且能产生可见内容', () => {
    const active = templates.filter(isTemplateReadyForEntry)
    expect(active).toHaveLength(439)

    for (const template of active) {
      const wrapper = mount(StructuredSheet, {
        props: {
          analyte: template.analyte,
          method: template.method,
          matrix: template.matrix,
          code: template.code,
          sheetType: template.sheetType,
          templateName: template.name,
          tplMeta: template.meta,
        },
        global: {
          stubs: {
            ElIcon: true,
            ElButton: true,
            RecordAttachments: true,
          },
        },
      })
      expect(wrapper.text().trim().length, `${template.file} ${template.code}`).toBeGreaterThan(0)
      wrapper.unmount()
    }
  })
})
