import { describe, expect, test } from 'vitest'
import templatesJson from '../src/data/templates.json'
import { isTemplateReadyForEntry } from '../src/data/templateEntry'
import { templatePhase } from '../src/data/phase'
import {
  laboratoryTemplateCoverage,
  templateMatchesAnalyte,
  type LaboratoryTemplate,
} from '../src/data/laboratoryTemplateMatching'

const templates = templatesJson as LaboratoryTemplate[]

describe('实验室记录表项目匹配', () => {
  test('只按规范项目名或明确别名匹配，不使用包含关系猜测', () => {
    const hexavalent = { code: 'A', file: 'a.pdf', analyte: '六价铬', sheetType: '原始记录' }
    const chromium = { code: 'B', file: 'b.pdf', analyte: '铬', sheetType: '原始记录' }
    expect(templateMatchesAnalyte(hexavalent, '六价铬')).toBe(true)
    expect(templateMatchesAnalyte(hexavalent, '铬')).toBe(false)
    expect(templateMatchesAnalyte(chromium, '六价铬')).toBe(false)
  })

  test('常用规范别名仍能找到同一检测项目', () => {
    const cod = { code: 'HJ-TC-103', file: '0100.pdf', analyte: '化学需氧量', sheetType: '原始记录' }
    expect(templateMatchesAnalyte(cod, 'COD')).toBe(true)
    expect(templateMatchesAnalyte(cod, 'CODcr')).toBe(true)
    expect(templateMatchesAnalyte({ code: 'PH', file: 'ph.pdf', analyte: 'pH', sheetType: '原始记录' }, 'pH值')).toBe(true)
  })

  test('每个项目都返回可录、待开放、现场或缺表中的一种明确状态', () => {
    const cod = templates.find(template => template.code === 'HJ-TC-103' && template.analyte === '化学需氧量')!
    const coverage = laboratoryTemplateCoverage([
      cod,
      { code: 'PENDING', file: 'pending.pdf', analyte: '锌', matrix: '废水', sheetType: '原始记录' },
      { code: 'FIELD', file: 'field.pdf', analyte: '水温', matrix: '废水', sheetType: '采样记录' },
    ], '废水', ['COD', '锌', '水温', '未知项目'])

    expect(coverage.map(item => [item.item, item.status])).toEqual([
      ['COD', 'ready'],
      ['锌', 'pending'],
      ['水温', 'field'],
      ['未知项目', 'missing'],
    ])
  })

  test('全库已开放且标明基质的实验室原始记录都能被自身项目检索到', () => {
    const readyLaboratoryRecords = templates.filter(template => isTemplateReadyForEntry(template)
      && template.sheetType === '原始记录' && templatePhase(template) === '实验室'
      && template.analyte && (template.applicableMatrices?.length || template.matrix))

    const failures = readyLaboratoryRecords.flatMap(template => {
      const matrices = template.applicableMatrices?.length ? template.applicableMatrices : [template.matrix!]
      return matrices.filter(matrix => laboratoryTemplateCoverage(templates, matrix, [template.analyte!])[0]?.status !== 'ready')
        .map(matrix => `${template.code}:${matrix}:${template.analyte}`)
    })

    expect(failures).toEqual([])
  })
})
