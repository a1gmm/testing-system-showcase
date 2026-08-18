import { describe, it, expect } from 'vitest'
import { resolveSchema } from '../src/data/schemas'

describe('resolveSchema by code', () => {
  it('228 hits the ringelmann layout schema, not generic', () => {
    const s = resolveSchema('原始记录', '', 'HJ-TC-228')
    expect(s.id).toBe('ringelmann')
    expect(s.layout && s.layout.length).toBeGreaterThan(0)
  })
  it('falls back to method when no code match', () => {
    expect(resolveSchema('原始记录', '分光光度').id).toBe('photometric')
  })
})
