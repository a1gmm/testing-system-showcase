import { describe, it, expect } from 'vitest'
import { settled, settleAll } from '../src/utils/settle'

// 工作台一屏要并发拉 7 个接口。原来用 Promise.all——任一个挂掉（网络抖动/超时）
// 整个 await 就抛，一屏数据全空。检测员在现场用手机热点，这事迟早发生。
//
// 但"静默降级成 0"更危险：合规系统里假的「0 待办」会让人以为没活儿干。
// 所以约定：失败的用兜底值渲染，同时必须能把「有东西没加载出来」这件事报上去。

describe('settled：单个 promise 失败降级', () => {
  it('成功时原样返回', async () => {
    expect(await settled(Promise.resolve(42), 0)).toBe(42)
  })

  it('失败时返回兜底值，不抛', async () => {
    expect(await settled(Promise.reject(new Error('503')), 0)).toBe(0)
  })

  it('兜底值可以是数组（列表接口的常见形态）', async () => {
    expect(await settled(Promise.reject(new Error('boom')), [] as number[])).toEqual([])
  })

  it('null 兜底（对象接口，如 statsOverview）', async () => {
    expect(await settled(Promise.reject(new Error('boom')), null)).toBeNull()
  })

  it('resolve 出 falsy 值时不能被兜底值顶掉', async () => {
    expect(await settled(Promise.resolve(0), 99)).toBe(0)
    expect(await settled(Promise.resolve(''), 'fallback')).toBe('')
  })
})

describe('settleAll：一组接口整体降级', () => {
  it('全成功：值按序返回，failed 为 0', async () => {
    const r = await settleAll([
      { p: Promise.resolve('a'), fallback: '' },
      { p: Promise.resolve('b'), fallback: '' },
    ] as const)
    expect(r.values).toEqual(['a', 'b'])
    expect(r.failed).toBe(0)
    expect(r.ok).toBe(true)
  })

  it('部分失败：挂的用兜底，好的照常返回——不是全军覆没', async () => {
    const r = await settleAll([
      { p: Promise.resolve('a'), fallback: '' },
      { p: Promise.reject(new Error('503')), fallback: 'FB' },
      { p: Promise.resolve('c'), fallback: '' },
    ] as const)
    expect(r.values).toEqual(['a', 'FB', 'c'])
    expect(r.failed).toBe(1)
    expect(r.ok).toBe(false)
  })

  it('全失败：全兜底，ok 为 false——调用方据此提示"数据不全"', async () => {
    const r = await settleAll([
      { p: Promise.reject(new Error('x')), fallback: 1 },
      { p: Promise.reject(new Error('y')), fallback: 2 },
    ] as const)
    expect(r.values).toEqual([1, 2])
    expect(r.failed).toBe(2)
    expect(r.ok).toBe(false)
  })

  it('整体永不抛——这是它存在的全部意义', async () => {
    await expect(settleAll([
      { p: Promise.reject(new Error('boom')), fallback: null },
    ] as const)).resolves.toBeDefined()
  })

  it('空数组不炸', async () => {
    const r = await settleAll([] as const)
    expect(r.values).toEqual([])
    expect(r.ok).toBe(true)
  })
})
