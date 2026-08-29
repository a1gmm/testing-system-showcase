import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('administration UI registration', () => {
  it('registers the loading directive used by administration pages', () => {
    const source = readFileSync(join(process.cwd(), 'src/adminUi.ts'), 'utf8')
    expect(source).toContain('ElLoading')
    expect(source).toContain("app.directive('loading', ElLoading.directive)")
  })
})
