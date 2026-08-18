import { describe, it, expect } from 'vitest'
import type { Section } from '../src/data/schemas'

describe('Section model', () => {
  it('kv section shape compiles & carries rows', () => {
    const s: Section = { type: 'kv', id: 'head', cols: 2, rows: [{ label: '受检单位', key: 'org' }] }
    expect(s.type).toBe('kv')
    expect((s as any).rows[0].key).toBe('org')
  })
})
