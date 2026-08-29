import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('field task unavailable state', () => {
  it('offers a clear route back to online login', () => {
    const source = readFileSync(join(process.cwd(), 'src/pages/FieldTask.vue'), 'utf8')
    expect(source).toContain('返回登录并重新授权')
    expect(source).toContain('href="/login"')
  })
})
