import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

describe('report preview markup', () => {
  test('wraps every report table row in a semantic table section', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/Reports.vue'), 'utf8')

    expect(source).not.toMatch(/<table[^>]*>\s*<tr/)
  })
})
