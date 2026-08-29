import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('administration shell on phone widths', () => {
  it('collapses nonessential header labels into 44px controls', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/AppShell.vue'), 'utf8')
    expect(source).toContain('@media (max-width:600px)')
    expect(source).toContain('.crumb{display:none}')
    expect(source).toContain(':deep(.recovery-entry)')
    expect(source).toContain('aria-label="搜项目或跳转页面"')
  })
})
