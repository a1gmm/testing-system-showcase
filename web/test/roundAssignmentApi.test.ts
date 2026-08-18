import { expect, test, vi } from 'vitest'

const post = vi.fn(async () => ({ data: { id: 'R1' } }))
vi.mock('axios', () => ({
  default: {
    create: () => ({
      get: vi.fn(), post,
      interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    }),
  },
}))

test('assignRound 客户端协议只提交 immutable samplerIds', async () => {
  const { api } = await import('../src/api')
  await api.assignRound('R1', ['same-a', 'same-b'], '2026-08-01')
  expect(post).toHaveBeenCalledWith('/rounds/R1/assign', {
    samplerIds: ['same-a', 'same-b'], planDate: '2026-08-01',
  })
})
