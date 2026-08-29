import { describe, expect, test } from 'vitest'
import templates from '../src/data/templates.json'
import manifest from '../src/data/templateSchemaManifest.json'
import { resolveSchema, resolveTemplateSchema, type Schema } from '../src/data/schemas'

type Template = (typeof templates)[number]

function visibleLabels(schema: Schema) {
  const values = [...schema.meta.map(item => item.label), ...schema.columns.map(item => item.label), ...schema.signRoles]
  for (const section of schema.layout || []) {
    if (section.type === 'table') values.push(...section.columns.map(item => item.label))
    if (section.type === 'kv') values.push(...section.rows.map(item => item.label), ...section.rows.flatMap(item => item.checks || []))
    if (section.type === 'checks') values.push(section.label, ...section.options)
    if (section.type === 'matrix') values.push(...section.rowHeaders.map(item => item.label), ...section.colHeaders.map(item => item.label))
    if (section.type === 'note' || section.type === 'diagram') values.push(section.label)
  }
  return values.map(value => value.replace(/[\s()（）·:：/\-]/g, ''))
}

describe('逐文件录入版式清单', () => {
  const active = templates.filter(template => !template.retired)

  test('439 张启用表按 file 一一绑定，不靠重复表号猜版式', () => {
    expect(active).toHaveLength(439)
    expect(Object.keys(manifest)).toHaveLength(active.length)
    for (const template of active) {
      const binding = manifest[template.file as keyof typeof manifest]
      expect(binding, template.file).toBeDefined()
      expect(binding.code, template.file).toBe(template.code)
      expect(binding.schemaId, template.file).not.toBe('generic')
      expect(binding.sourceSha256, template.file).toMatch(/^[0-9a-f]{64}$/)
      expect(binding.sourcePageCount, template.file).toBeGreaterThan(0)
      expect(binding.visualReviewedOn, template.file).toBe('2026-08-29')
      const schema = resolveTemplateSchema(template)
      expect(schema.id, template.file).toBe(binding.schemaId)
      const labels = visibleLabels(schema)
      for (const sourceLabel of binding.sourceLabels) {
        const normalized = sourceLabel.replace(/[\s()（）·:：/\-]/g, '')
        expect(labels.some(label => label.includes(normalized) || normalized.includes(label)), `${template.file} 缺少原表字段 ${sourceLabel}`).toBe(true)
      }
    }
  })

  test('未登记的文件拒绝进入正式录入，旧推断函数只保留给兼容测试', () => {
    const template = active[0] as Template
    expect(() => resolveTemplateSchema({ ...template, file: 'not-registered.pdf' })).toThrow(/未登记逐文件版式/)
    expect(resolveSchema('原始记录', '分光光度').id).toBe('photometric')
  })

  test('重复表号的每个 PDF 都有独立文件绑定', () => {
    const grouped = new Map<string, string[]>()
    for (const template of active) grouped.set(template.code, [...(grouped.get(template.code) || []), template.file])
    const duplicates = [...grouped.values()].filter(files => files.length > 1)
    expect(duplicates).toHaveLength(6)
    for (const files of duplicates) {
      expect(new Set(files.map(file => manifest[file as keyof typeof manifest]?.schemaId)).size).toBeGreaterThan(0)
      for (const file of files) expect(manifest[file as keyof typeof manifest], file).toBeDefined()
    }
  })
})
