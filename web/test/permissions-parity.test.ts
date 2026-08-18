// 前后端权限矩阵必须一字不差——散掉一次就再也对不齐了
import { describe, it, expect } from 'vitest'
import { PERM as WEB } from '../src/permissions'
// vitest 跑在 node 环境，可直接引后端源码做对账
import { PERM as SERVER } from '../../server/src/permissions.ts'

describe('前后端权限矩阵对账', () => {
  it('动作清单一致', () => {
    expect(Object.keys(WEB).sort()).toEqual(Object.keys(SERVER).sort())
  })
  it('每个动作的角色清单一致', () => {
    for (const k of Object.keys(SERVER) as (keyof typeof SERVER)[]) {
      expect([...(WEB as any)[k]].sort(), `动作 ${k} 两边不一致`).toEqual([...SERVER[k]].sort())
    }
  })
})
