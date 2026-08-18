import { beforeEach, describe, expect, test, vi } from 'vitest'

const http = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }))
const recovery = vi.hoisted(() => ({ issue: vi.fn(async () => true), clear: vi.fn() }))
vi.mock('axios', () => ({
  default: {
    create: () => ({
      ...http,
      interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    }),
  },
}))
vi.mock('../src/offline/recoveryIdentity', () => ({
  issueAuthenticatedRecoveryCredential: recovery.issue,
  clearRecoveryIdentity: recovery.clear,
}))

import { api, currentUser } from '../src/api'

describe('authentication integration for recovery identity', () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', { configurable: true, value: {
      clear: () => values.clear(), getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key), setItem: (key: string, value: string) => values.set(key, value),
    } })
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: window.localStorage })
    http.post.mockReset()
    http.get.mockReset()
    recovery.issue.mockClear()
    recovery.clear.mockClear()
    currentUser.value = null
  })

  test('successful login and me replace the hint with the server-authenticated immutable username', async () => {
    http.post.mockResolvedValueOnce({ data: { token: 'token-a', user: { username: 'user-a', name: 'A', roles: [], status: 'active', created_at: '' } } })
    await api.login('typed-name-is-not-trusted', 'password')
    expect(recovery.issue).toHaveBeenLastCalledWith('user-a')

    http.get.mockResolvedValueOnce({ data: { username: 'user-b', name: 'B', roles: [], status: 'active', created_at: '' } })
    await api.me()
    expect(recovery.issue).toHaveBeenLastCalledWith('user-b')
  })

  test('network failure keeps a retained hint while currentUser remains null for read-only cold recovery', async () => {
    http.get.mockRejectedValueOnce(new Error('offline'))

    await expect(api.me()).rejects.toThrow('offline')

    expect(currentUser.value).toBeNull()
    expect(recovery.issue).not.toHaveBeenCalled()
  })

  test('explicit logout clears token and hint even when the server is unreachable', async () => {
    window.localStorage.setItem('tc_token', 'token-a')
    http.post.mockRejectedValueOnce(new Error('offline'))

    await api.logout()

    expect(window.localStorage.getItem('tc_token')).toBeNull()
    expect(recovery.clear).toHaveBeenCalledOnce()
    expect(currentUser.value).toBeNull()
  })

  test('credential cleanup failure cannot reject logout or retain authenticated UI state', async () => {
    window.localStorage.setItem('tc_token', 'token-a')
    currentUser.value = { username: 'user-a', name: 'A', roles: [], status: 'active', created_at: '' }
    http.post.mockRejectedValueOnce(new Error('offline'))
    recovery.clear.mockRejectedValueOnce(new Error('storage failed'))
    await expect(api.logout()).resolves.toBeUndefined()
    expect(window.localStorage.getItem('tc_token')).toBeNull()
    expect(currentUser.value).toBeNull()
  })
})
