// 前后端权限矩阵必须一字不差——散掉一次就再也对不齐了
import { describe, it, expect } from 'vitest'
import { PERM as WEB } from '../src/permissions'
// vitest 跑在 node 环境，可直接引后端源码做对账
import { PERM as SERVER } from '../../server/src/permissions.ts'

describe('前后端权限矩阵对账', () => {
  it('动作清单一致', () => {
    expect(Object.keys(WEB).sort()).toEqual(Object.keys(SERVER).sort())
  })
  it('动作及角色清单按声明顺序完全一致', () => {
    expect(JSON.stringify(WEB)).toBe(JSON.stringify(SERVER))
  })
})
