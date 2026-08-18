import { afterEach, expect, test, vi } from 'vitest'
import { publishAuthLogout, subscribeAuthLogout } from '../src/offline/authLifecycle'

afterEach(() => vi.unstubAllGlobals())

test('logout broadcasts across tabs even when storage listeners belong to another realm', () => {
  const channels: any[] = []
  class FakeChannel { onmessage: any; constructor(_name: string) { channels.push(this) } postMessage(data: any) { for (const c of channels) if (c !== this) c.onmessage?.({ data }) } close() {} }
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  const received = vi.fn(); const unsubscribe = subscribeAuthLogout(received)
  publishAuthLogout({ setItem: vi.fn(), removeItem: vi.fn() } as any)
  expect(received).toHaveBeenCalledOnce()
  unsubscribe()
})
