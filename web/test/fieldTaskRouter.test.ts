import { beforeEach, describe, expect, test } from 'vitest'
import router from '../src/router'

describe('offline field task route', () => {
  beforeEach(() => Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, removeItem: () => undefined } }))

  test('cold-start route is reachable without a login token and component is eagerly present in the main graph', async () => {
    const resolved = router.resolve('/field-tasks/ROUND-1')
    expect(resolved.matched.at(-1)?.components?.default).toBeTypeOf('object')
    await router.push('/field-tasks/ROUND-1')
    expect(router.currentRoute.value.fullPath).toBe('/field-tasks/ROUND-1')
    expect(router.currentRoute.value.meta.offlinePackage).toBe(true)
  })

  test('stale login token cannot force an offline field task through the network auth guard', async () => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => 'stale-token', removeItem: () => undefined } })
    await router.push('/field-tasks/ROUND-OFFLINE')
    expect(router.currentRoute.value.fullPath).toBe('/field-tasks/ROUND-OFFLINE')
  })
})
