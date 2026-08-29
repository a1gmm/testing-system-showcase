import { describe, expect, test } from 'vitest'
import templates from '../src/data/templates.json'
import { isTemplateReadyForEntry } from '../src/data/templateEntry'

describe('文件级模板身份', () => {
  test('同一表号不能让不存在的文件继承正式录入资格', () => {
    const duplicated = templates.filter(template => template.code === 'HJ-TC-194')

    expect(duplicated.map(template => template.file)).toEqual(['0158.pdf', '0159.pdf'])
    expect(duplicated.every(template => isTemplateReadyForEntry(template))).toBe(true)
    expect(isTemplateReadyForEntry({ file: '__missing__.pdf', code: 'HJ-TC-194' })).toBe(false)
  })

  test('停用文件即使表号仍在启用列表中也不能录入', () => {
    expect(isTemplateReadyForEntry({ file: '0161.pdf', code: 'HJ-TC-201', retired: true })).toBe(false)
  })
})
