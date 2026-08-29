import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('login shell dependency boundary', () => {
  it('does not load the administration UI library before authentication', () => {
    const source = readFileSync(join(process.cwd(), 'src/pages/Login.vue'), 'utf8')
    expect(source).not.toContain("from 'element-plus'")
    expect(source).toContain('role="alert"')
    expect(source).toContain('首次登录 · 修改密码')
  })
})
