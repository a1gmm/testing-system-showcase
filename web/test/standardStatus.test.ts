import { describe, expect, test } from 'vitest'
import { resolveStandard } from '../src/data/standardLink'
import templatesRaw from '../src/data/templates.json'

describe('标准状态判定', () => {
  const cases = [
    { basis: '', expected: 'pending' },
    { basis: 'NOT-A-STANDARD', expected: 'pending' },
    { basis: 'GB/T5750.6-2006', expected: 'outdated' },
    { basis: 'GB/T5750.6-2023', expected: 'verified' },
    { basis: 'GB／T5750.6-2023', expected: 'verified' },
    { basis: 'HJ77.1—2025', expected: 'verified' },
    { basis: 'HJ1082-2019', expected: 'verified' },
  ] as const

  test.each(cases)('前端对 $basis 返回 $expected', ({ basis, expected }) => {
    expect(resolveStandard(basis).kind).toBe(expected)
  })

  test('现行标准的核验状态不再与本地全文混为一谈', () => {
    const gb = resolveStandard('GB/T5750.6-2023')
    const hj = resolveStandard('HJ77.1—2025')

    expect(gb.kind).toBe('verified')
    expect(hj.kind).toBe('verified')
    if (gb.kind === 'verified') expect(gb.documentAvailable).toBe(false)
    if (hj.kind === 'verified') expect(hj.documentAvailable).toBe(false)
  })

  test.each([
    ['GB/T5750.5-2006', 'GB/T5750.5-2023'],
    ['GB/T5750.6-2006', 'GB/T5750.6-2023'],
  ])('旧版 %s 提供明确替代编号 %s', (basis, replacement) => {
    const status = resolveStandard(basis)
    expect(status.kind).toBe('outdated')
    if (status.kind === 'outdated') expect(status.info.currentCode).toBe(replacement)
  })

  test('13 个启用模板固定使用对应的 2023 标准', () => {
    const expectedBasis = {
      'HJ-TC-019': 'GB/T5750.6-2023',
      'HJ-TC-020': 'GB/T5750.6-2023',
      'HJ-TC-074': 'GB/T5750.6-2023',
      'HJ-TC-076': 'GB/T5750.6-2023',
      'HJ-TC-077': 'GB/T5750.6-2023',
      'HJ-TC-079': 'GB/T5750.6-2023',
      'HJ-TC-080': 'GB/T5750.6-2023',
      'HJ-TC-081': 'GB/T5750.6-2023',
      'HJ-TC-083': 'GB/T5750.6-2023',
      'HJ-TC-396': 'GB/T5750.6-2023',
      'HJ-TC-646': 'GB/T5750.6-2023',
      'HJ-TC-647': 'GB/T5750.6-2023',
      'HJ-TC-428': 'GB/T5750.5-2023',
    } as const

    for (const [code, basis] of Object.entries(expectedBasis)) {
      const active = templatesRaw.filter((template) => template.code === code && !template.retired)
      expect(active, code).toHaveLength(1)
      expect(active[0]?.meta?.basis, code).toBe(basis)
    }
  })
})
