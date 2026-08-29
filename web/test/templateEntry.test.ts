import { describe, expect, test } from 'vitest'
import templatesJson from '../src/data/templates.json'
import { isTemplateReadyForEntry } from '../src/data/templateEntry'

describe('正式录入模板开放条件', () => {
  test('开放编号仍必须排除已停用的具体模板版本', () => {
    const candidates = templatesJson.filter(isTemplateReadyForEntry)

    expect(candidates.some(template => template.retired)).toBe(false)
    expect(candidates.some(template => template.code === 'HJ-TC-700')).toBe(false)
    expect(candidates.some(template => template.code === 'HJ-TC-103')).toBe(true)
  })
})
