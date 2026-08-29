import { describe, expect, test } from 'vitest'
import { FORMS } from '../src/data/forms'
import { resolveSchema } from '../src/data/schemas'
import templates from '../src/data/templates.json'

const remainingCodes = [
  'HJ-TC-033', 'HJ-TC-039', 'HJ-TC-045', 'HJ-TC-047', 'HJ-TC-0656',
  'HJ-TC-088', 'HJ-TC-102', 'HJ-TC-125', 'HJ-TC-138', 'HJ-TC-175',
  'HJ-TC-179', 'HJ-TC-197', 'HJ-TC-199', 'HJ-TC-232', 'HJ-TC-355',
  'HJ-TC-376', 'HJ-TC-394', 'HJ-TC-401', 'HJ-TC-402', 'HJ-TC-403',
  'HJ-TC-421', 'HJ-TC-423', 'HJ-TC-429', 'HJ-TC-431', 'HJ-TC-437',
  'HJ-TC-438', 'HJ-TC-442', 'HJ-TC-444', 'HJ-TC-458', 'HJ-TC-52',
  'HJ-TC-551', 'HJ-TC-552', 'HJ-TC-553', 'HJ-TC-562', 'HJ-TC-563',
  'HJ-TC-575', 'HJ-TC-576', 'HJ-TC-588', 'HJ-TC-598', 'HJ-TC-617',
  'HJ-TC-626', 'HJ-TC-636', 'HJ-TC-641', 'HJ-TC-648', 'HJ-TC-378',
  'HJ-TC-405', 'HJ-TC-637', 'HJ-TC-642', 'HJ-TC-655', 'HJ-TC-705',
  'HJ-TC-707', 'HJ-TC-716', 'HJ-TC-717', 'HJ-TC-718', 'HJ-TC-133',
  'HJ-TC-461', 'HJ-TC-561',
] as const

const byCode = new Map(templates.map(template => [template.code, template]))
const columns = (code: string) => {
  const schema = FORMS[code]
  return schema.layout?.flatMap(section => section.type === 'table' ? section.columns : []) ?? schema.columns
}

describe('剩余模板专用录入版式', () => {
  test('57 个原表全部精确命中专用版式，不再落入通用兜底', () => {
    expect(new Set(remainingCodes).size).toBe(57)
    for (const code of remainingCodes) {
      const template = byCode.get(code)
      expect(template, code).toBeDefined()
      expect(FORMS[code], code).toBeDefined()
      const schema = resolveSchema(template!.sheetType, template!.method, code, template!.meta?.methodFull)
      expect(schema.id, code).not.toBe('generic')
    }
  })

  test('空气和废气分析表使用标干体积与 mg/m³，不混入水样结果单位', () => {
    const codes = ['HJ-TC-039', 'HJ-TC-045', 'HJ-TC-088', 'HJ-TC-175', 'HJ-TC-376', 'HJ-TC-442', 'HJ-TC-444']
    for (const code of codes) {
      const cols = columns(code)
      expect(cols.some(column => column.key === 'vnd'), code).toBe(true)
      expect(cols.some(column => column.unit === 'mg/m³'), code).toBe(true)
      expect(cols.some(column => column.label === '取样量' && /m[lL]/.test(column.unit ?? '')), code).toBe(false)
    }
    for (const code of ['HJ-TC-401', 'HJ-TC-402', 'HJ-TC-403']) {
      const cols = columns(code)
      expect(cols.some(column => column.key === 'vnd'), code).toBe(true)
      expect(cols.some(column => column.unit === 'μg/m³'), code).toBe(true)
    }
  })

  test('pH、电导率、溶解氧和透明度保留各自的直读字段', () => {
    for (const code of ['HJ-TC-047', 'HJ-TC-551', 'HJ-TC-552', 'HJ-TC-553', 'HJ-TC-562', 'HJ-TC-626', 'HJ-TC-641'])
      expect(columns(code).some(column => column.key === 'ph'), code).toBe(true)
    for (const code of ['HJ-TC-0656', 'HJ-TC-563', 'HJ-TC-717'])
      expect(columns(code).some(column => column.key === 'ec'), code).toBe(true)
    expect(columns('HJ-TC-716').some(column => column.key === 'do')).toBe(true)
    expect(columns('HJ-TC-718').some(column => column.key === 'avg')).toBe(true)
  })

  test('颗粒物重量表记录前后重量、标干体积和浓度', () => {
    for (const code of ['HJ-TC-642', 'HJ-TC-655', 'HJ-TC-707']) {
      const keys = columns(code).map(column => column.key)
      expect(keys, code).toEqual(expect.arrayContaining(['w0_1', 'w1_1', 'vol', 'dustMeasured']))
    }
  })

  test('固体汞表不展示不适用的可编辑波长栏', () => {
    for (const code of ['HJ-TC-033', 'HJ-TC-421']) {
      const labels = FORMS[code].layout?.flatMap(section => section.type === 'kv' ? section.rows.map(row => row.label) : []) ?? []
      expect(labels, code).not.toContain('测定波长')
    }
    expect(columns('HJ-TC-033').some(column => column.unit === 'mg/kg')).toBe(true)
    expect(columns('HJ-TC-421').some(column => column.unit === 'μg/L')).toBe(true)
  })

  test('油烟和 CEMS 使用已按原件还原的现场版式', () => {
    expect(FORMS['HJ-TC-133'].id).toBe('field133')
    expect(FORMS['HJ-TC-461'].id).toBe('field461')
    expect(FORMS['HJ-TC-561'].id).toBe('field561')
  })

  test('关键换算按原表单位计算，摩尔与毫摩尔浓度不混用', () => {
    const ctx = { reg: { a: 0, b: 2 }, meta: {} as Record<string, any> }
    expect(FORMS['HJ-TC-197'].compute!({ a0: 0, a: 0.2, sample: 50, k: 1 }, ctx).rho).toBe(0.002)
    expect(FORMS['HJ-TC-138'].compute!({ v: 100, v1: 10, k: 1 }, { ...ctx, meta: { c: 0.01 } }).rho).toBe(100.09)
    expect(FORMS['HJ-TC-438'].compute!({ v: 100, v1: 10, k: 1 }, { ...ctx, meta: { c: 1 } }).rho).toBe(10.01)
    expect(FORMS['HJ-TC-355'].compute!({ v: 100, v1: 8, v2: 10 }, { ...ctx, meta: { c: 0.01 } }).rho).toBe(1.6)
    expect(FORMS['HJ-TC-401'].compute!({ rhoSolution: 2, vdef: 50, vnd: 1, k: 1 }, ctx).rhoGas).toBe(100)
    expect(FORMS['HJ-TC-718'].compute!({ v1: 10, v2: 11, v3: 12 }, ctx).avg).toBe(11)
  })

  test('环境空气检出限使用气体浓度单位并保留原表科学计数值', () => {
    expect(byCode.get('HJ-TC-039')?.meta?.detectionLimit).toBe('5×10⁻⁴mg/m³')
    expect(byCode.get('HJ-TC-376')?.meta?.detectionLimit).toBe('0.004mg/m³')
  })
})
