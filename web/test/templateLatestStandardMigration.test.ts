import { describe, expect, test } from 'vitest'
import templatesRaw from '../src/data/templates.json'
import evidenceRaw from '../src/data/templateStandardEvidence.json'
import { resolveTemplateStandard } from '../src/data/standardLink'

const templates = new Map(templatesRaw.map(template => [template.file, template]))
const evidence = evidenceRaw as Record<string, { kind: string; basis?: string[]; note: string }>

describe('旧表按现行标准迁移', () => {
  test.each([
    ['0021.pdf', ['HJ 491-2019']],
    ['0022.pdf', ['HJ 491-2019']],
    ['0028.pdf', ['HJ 491-2019']],
    ['0029.pdf', ['HJ 491-2019']],
    ['0043.pdf', ['GB/T 7494-1987']],
    ['0138.pdf', ['GB 12348-2008', 'GB 3096-2008', 'GB 22337-2008', 'GB 12523-2025']],
    ['0165.pdf', ['GB/T 5750.4-2023']],
    ['0202.pdf', ['GB 17378.4-2007']],
    ['0237.pdf', ['DZ/T 0064.49-2021']],
    ['0240.pdf', ['DB37/T 3460-2018']],
    ['0241.pdf', ['DB37/T 3461-2018']],
    ['0242.pdf', ['DB37/T 3461-2018']],
    ['0301.pdf', ['HJ 1147-2020']],
    ['0303.pdf', ['HJ 1147-2020']],
    ['0414.pdf', ['GB 17378.4-2007']],
    ['0437.pdf', ['HJ 1453-2026']],
    ['0438.pdf', ['HJ 1453-2026']],
  ])('%s 只使用已实施的现行依据', (file, basis) => {
    const template = templates.get(file)
    expect(template).toBeTruthy()
    expect(resolveTemplateStandard(template!).kind).toBe('verified')
    expect(resolveTemplateStandard(template!).basis).toEqual(basis)
    expect(template!.meta?.basis).toBe(basis.join('、'))
  })

  test('升级后的关键方法常量与官方标准一致', () => {
    expect(templates.get('0028.pdf')?.meta?.detectionLimit).toBe('3 mg/kg')
    expect(templates.get('0437.pdf')?.meta?.detectionLimit).toBe('0.7 μg/L（总铅）')
    expect(templates.get('0438.pdf')?.meta?.detectionLimit).toBe('0.09 μg/L（总镉）')
    expect(templates.get('0043.pdf')?.meta?.detectionLimit).toBe('0.05 mg/L')
  })

  test.each([
    '0040.pdf', '0041.pdf', '0083.pdf', '0084.pdf', '0109.pdf', '0110.pdf',
    '0229.pdf', '0259.pdf', '0282.pdf', '0324.pdf', '0343.pdf', '0344.pdf',
    '0345.pdf', '0355.pdf', '0357.pdf', '0367.pdf', '0416.pdf', '0417.pdf',
    '0419.pdf', '0428.pdf', '0442.pdf', '0453.pdf', '0454.pdf',
  ])('%s 明确列为机构受控方法，不冒充现行国标', (file) => {
    const decision = evidence[file]
    expect(decision?.kind).toBe('controlled')
    expect(decision?.basis?.length).toBeGreaterThan(0)
    expect(decision?.note).toContain('不得显示为现行国家标准')
    expect(resolveTemplateStandard(templates.get(file)!).kind).toBe('controlled')
  })
})
