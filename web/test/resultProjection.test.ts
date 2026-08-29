import { describe, expect, it } from 'vitest'
import { projectResultSummary } from '../src/data/resultProjection'
import type { Schema } from '../src/data/schemas'

function schema(result: Schema['result']): Schema {
  return {
    id: 'fixture',
    title: () => 'fixture',
    columns: [
      { key: 'id', label: '样品编号', kind: 'id' },
      { key: 'result', label: '结果', unit: 'mg/L', kind: 'input' },
      { key: 'note', label: '备注', kind: 'input' },
    ],
    result,
    meta: [],
    signRoles: [],
    seed: () => [],
  }
}

describe('projectResultSummary', () => {
  it('preserves a non-numeric reported value when the schema allows text', () => {
    const summary = projectResultSummary(
      schema({ key: 'result', allowText: true }),
      [{ id: 'S-1', result: '<0.05' }],
      '目标物',
      () => ({}),
    )

    expect(summary).toEqual({ analyte: '目标物', value: '<0.05', unit: 'mg/L' })
  })

  it('still averages numeric replicates for a text-capable result column', () => {
    const summary = projectResultSummary(
      schema({ key: 'result', allowText: true }),
      [{ result: '1.2' }, { result: 1.4 }, { result: 99, note: '空白' }],
      '目标物',
      () => ({}),
    )

    expect(summary).toEqual({ analyte: '目标物', value: 1.3, unit: 'mg/L' })
  })
})
