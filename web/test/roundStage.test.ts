import { describe, it, expect } from 'vitest'
import { defaultStage } from '../src/utils/roundStage'

describe('采样派工三段式：默认展开段', () => {
  it('没派工 → 排产派工段', () => {
    expect(defaultStage({ status: 'todo', sampler: null })).toBe('dispatch')
    expect(defaultStage({ status: 'todo', sampler: '' })).toBe('dispatch')
  })

  it('已派工未入库 → 现场采样段', () => {
    expect(defaultStage({ status: 'assigned', sampler: '赵采样、许技术' })).toBe('field')
  })

  it('未采成（改期中）→ 回到派工段', () => {
    expect(defaultStage({ status: 'failed', sampler: null })).toBe('dispatch')
  })

  it('未采成但仍有采样员 → 现场段（可直接改期重采）', () => {
    expect(defaultStage({ status: 'failed', sampler: '赵采样' })).toBe('field')
  })

  it('已入库 → 样品与质控段', () => {
    expect(defaultStage({ status: 'done', sampler: '赵采样' })).toBe('stock')
  })
})
