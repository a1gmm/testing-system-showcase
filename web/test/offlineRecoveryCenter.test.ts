import { mount } from '@vue/test-utils'
import { describe, expect, test, vi } from 'vitest'

import OfflineRecoveryCenter from '../src/offline/OfflineRecoveryCenter.vue'
import { MemoryOfflineDatabase, type StoredDraft } from '../src/offline/offlineVault'

const stored: StoredDraft = {
  id: 'draft-a', ownerId: 'user-a', schemaVersion: 1, updatedAt: '2026-08-16T10:00:00.000Z',
  payload: { customer: '不得展示', value: 'secret' },
}

describe('session-bound recovery center', () => {
  test('unauthenticated state has no recovery enumeration entry', () => {
    const wrapper = mount(OfflineRecoveryCenter, { props: { userId: null } })

    expect(wrapper.find('[data-testid="offline-recovery-entry"]').exists()).toBe(false)
  })

  test('retained identity mode explicitly denies login, API, and write authority', async () => {
    const wrapper = mount(OfflineRecoveryCenter, {
      props: { userId: 'user-a', recoveryOnly: true, databaseFactory: () => new MemoryOfflineDatabase({ schemaVersion: 1, drafts: [] }) },
    })
    await wrapper.get('[data-testid="offline-recovery-entry"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.text()).toContain('这不是有效登录'))
    expect(wrapper.text()).toContain('不授予业务接口或写入权限')
  })

  test('opens the vault for the immutable session user and shows only safe recovery metadata', async () => {
    const factory = vi.fn((userId: string) => new MemoryOfflineDatabase({
      schemaVersion: 1,
      drafts: userId === 'user-a' ? [stored] : [],
    }))
    const wrapper = mount(OfflineRecoveryCenter, {
      props: {
        userId: 'user-a',
        databaseFactory: factory,
        storageApi: { persisted: async () => true, persist: async () => true, estimate: async () => ({ usage: 90, quota: 100 }) },
      },
    })

    await wrapper.get('[data-testid="offline-recovery-entry"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[data-testid="draft-count"]').text()).toBe('1 份'))

    expect(factory).toHaveBeenCalledWith('user-a')
    expect(wrapper.text()).toContain('容量即将用尽')
    expect(wrapper.text()).not.toContain('不得展示')
    expect(wrapper.text()).not.toContain('secret')
    expect(wrapper.get('[data-testid="diagnostic-export"]').attributes('disabled')).toBeUndefined()
  })

  test('switching session identity closes the previous view and never reuses its count', async () => {
    const factory = (userId: string) => new MemoryOfflineDatabase({ schemaVersion: 1, drafts: userId === 'user-a' ? [stored] : [] })
    const wrapper = mount(OfflineRecoveryCenter, { props: { userId: 'user-a', databaseFactory: factory } })
    await wrapper.get('[data-testid="offline-recovery-entry"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[data-testid="draft-count"]').text()).toBe('1 份'))

    await wrapper.setProps({ userId: 'user-b' })
    expect(wrapper.find('[data-testid="draft-count"]').exists()).toBe(false)
    await wrapper.get('[data-testid="offline-recovery-entry"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[data-testid="draft-count"]').text()).toBe('0 份'))
  })

  test('newer-schema recovery displays the actual database version separately from the app version', async () => {
    const wrapper = mount(OfflineRecoveryCenter, {
      props: {
        userId: 'user-a',
        databaseFactory: () => new MemoryOfflineDatabase({ schemaVersion: 3, drafts: [{ ...stored, schemaVersion: 3 }] }),
      },
    })

    await wrapper.get('[data-testid="offline-recovery-entry"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[data-testid="schema-versions"]').text()).toContain('本机数据版本 3'))
    expect(wrapper.get('[data-testid="schema-versions"]').text()).toContain('应用支持版本 1')
  })

  test('a slow user A read cannot overwrite user B after the session identity switches', async () => {
    let resolveA!: (value: { schemaVersion: number; drafts: StoredDraft[] }) => void
    const pendingA = new Promise<{ schemaVersion: number; drafts: StoredDraft[] }>((resolve) => { resolveA = resolve })
    const factory = (userId: string) => userId === 'user-a'
      ? { snapshot: () => pendingA, migrate: async () => undefined }
      : new MemoryOfflineDatabase({ schemaVersion: 1, drafts: [] })
    const wrapper = mount(OfflineRecoveryCenter, { props: { userId: 'user-a', databaseFactory: factory } })
    await wrapper.get('[data-testid="offline-recovery-entry"]').trigger('click')

    await wrapper.setProps({ userId: 'user-b' })
    await wrapper.get('[data-testid="offline-recovery-entry"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[data-testid="draft-count"]').text()).toBe('0 份'))
    resolveA({ schemaVersion: 1, drafts: [stored] })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(wrapper.get('[data-testid="draft-count"]').text()).toBe('0 份')
  })
})
