import { existsSync,readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const css=readFileSync(resolve(process.cwd(),'src/style.css'),'utf8')

describe('approved design foundation',()=>{
  test.each([
    ['--bg','#F3F0EA'],['--surface','#FFFEFC'],['--surface-2','#E9E5DD'],['--ink','#1E2329'],['--muted','#62676E'],['--line','#CBC5BA'],
    ['--accent','#4F46E5'],['--accent-ring','#7C75F2'],['--local-saved','#176B5B'],['--warn','#B05C00'],['--good','#157347'],['--crit','#B42318'],['--info','#2563A6'],
  ])('%s uses the approved value', (token,value)=>expect(css.toUpperCase()).toContain(`${token}:${value}`.toUpperCase()))
  test('the app stays light and respects reduced motion',()=>{
    expect(css).toMatch(/color-scheme\s*:\s*light/)
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })
  test('approved self-hosted font families are declared',()=>{
    expect(css).toContain('Source Han Sans SC')
    expect(css).toContain('DM Sans')
    expect(css).toContain('IBM Plex Mono')
    expect(css).toContain('@font-face')
    for(const file of ['source-han-sans-sc-subset.woff2','source-han-sans-sc-admin.woff2','dm-sans-variable.woff2','ibm-plex-mono-regular.woff2'])expect(existsSync(resolve(process.cwd(),'public/fonts',file))).toBe(true)
  })
})
