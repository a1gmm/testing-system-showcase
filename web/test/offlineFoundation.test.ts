import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { mount } from '@vue/test-utils'

import {
  MemoryOfflineDatabase,
  openOfflineVault,
  openOfflineVaultReadonly,
  type StoredDraft,
} from '../src/offline/offlineVault'
import { buildSafeDiagnostic, probeStorageCapability } from '../src/offline/storageHealth'
import OfflineFoundationStatus from '../src/offline/OfflineFoundationStatus.vue'
import { offlineFeatureFlags } from '../src/offline/features'

describe('PWA shell safety boundary', () => {
  test('manifest exposes install metadata for the warm light field workspace', async () => {
    const manifest = JSON.parse(await readFile(new URL('public/manifest.webmanifest', `file://${process.cwd()}/`), 'utf8'))

    expect(manifest).toMatchObject({
      name: '现场采样工作台',
      short_name: '采样工作台',
      display: 'standalone',
      start_url: '/',
      background_color: '#F3F0EA',
      theme_color: '#F3F0EA',
    })
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ sizes: '192x192' }),
      expect.objectContaining({ sizes: '512x512' }),
    ]))
  })

})

const draft = (ownerId: string, value: string): StoredDraft => ({
  id: 'draft-1',
  ownerId,
  schemaVersion: 1,
  updatedAt: '2026-08-16T10:00:00.000Z',
  payload: { customer: '敏感客户', formValue: value, photo: 'data:image/jpeg;base64,secret' },
})

describe('offline vault identity and version safety', () => {
  test('recovery-only open never migrates a legacy schema or invokes a writer', async () => {
    const db = new MemoryOfflineDatabase({ schemaVersion: 1, drafts: [draft('user-a', 'kept')] })

    const vault = await openOfflineVaultReadonly({ database: db, userId: 'user-a', supportedSchemaVersion: 3 })

    expect(db.migrationRuns).toBe(0)
    expect(db.snapshot().schemaVersion).toBe(1)
    expect(vault).toMatchObject({ mode: 'readonly_recovery', reason: 'recovery_only', schemaVersion: 1 })
    expect(vault.drafts[0]?.payload.formValue).toBe('kept')
  })
  test('immutable user namespaces prevent user B from seeing user A drafts', async () => {
    const db = new MemoryOfflineDatabase({ schemaVersion: 1, drafts: [draft('user-a', 'A-value')] })

    const vaultA = await openOfflineVault({ database: db, userId: 'user-a', supportedSchemaVersion: 1 })
    const vaultB = await openOfflineVault({ database: db, userId: 'user-b', supportedSchemaVersion: 1 })

    expect(vaultA.drafts).toHaveLength(1)
    expect(vaultB.drafts).toEqual([])
  })

  test('an owner mismatch enters recovery without exposing the other user draft', async () => {
    const db = new MemoryOfflineDatabase({ schemaVersion: 1, drafts: [draft('user-a', 'A-value')] })

    const vaultB = await openOfflineVault({ database: db, userId: 'user-b', supportedSchemaVersion: 1 })

    expect(vaultB).toEqual({ mode: 'readonly_recovery', reason: 'owner_mismatch', drafts: [], schemaVersion: 1 })
  })

  test('only one migration writer runs and an application retry preserves drafts', async () => {
    const db = new MemoryOfflineDatabase({ schemaVersion: 1, drafts: [draft('user-a', 'kept')] })

    const [first, second] = await Promise.all([
      openOfflineVault({ database: db, userId: 'user-a', supportedSchemaVersion: 2 }),
      openOfflineVault({ database: db, userId: 'user-a', supportedSchemaVersion: 2 }),
    ])
    const retry = await openOfflineVault({ database: db, userId: 'user-a', supportedSchemaVersion: 2 })

    expect(db.migrationRuns).toBe(1)
    expect(first.drafts[0]?.payload.formValue).toBe('kept')
    expect(second.drafts[0]?.payload.formValue).toBe('kept')
    expect(retry.drafts[0]?.payload.formValue).toBe('kept')
  })

  test('a queued newer application version rechecks the schema after the active writer', async () => {
    const db = new MemoryOfflineDatabase({ schemaVersion: 1, drafts: [draft('user-a', 'kept')] })

    await Promise.all([
      openOfflineVault({ database: db, userId: 'user-a', supportedSchemaVersion: 2 }),
      openOfflineVault({ database: db, userId: 'user-a', supportedSchemaVersion: 3 }),
    ])

    expect(db.snapshot().schemaVersion).toBe(3)
    expect(db.snapshot().drafts[0]?.payload.formValue).toBe('kept')
  })

  test('migration failure retains the original database and enters readonly recovery', async () => {
    const original = draft('user-a', 'unchanged')
    const db = new MemoryOfflineDatabase({ schemaVersion: 1, drafts: [original], failMigration: true })

    const vault = await openOfflineVault({ database: db, userId: 'user-a', supportedSchemaVersion: 2 })

    expect(vault.mode).toBe('readonly_recovery')
    expect(vault.reason).toBe('migration_failed')
    expect(vault.drafts).toEqual([original])
    expect(db.snapshot()).toEqual({ schemaVersion: 1, drafts: [original] })
  })

  test('a database newer than the application stays readable but cannot be migrated backward', async () => {
    const db = new MemoryOfflineDatabase({ schemaVersion: 3, drafts: [draft('user-a', 'future')] })

    const vault = await openOfflineVault({ database: db, userId: 'user-a', supportedSchemaVersion: 2 })

    expect(vault.mode).toBe('readonly_recovery')
    expect(vault.reason).toBe('newer_schema')
    expect(vault.schemaVersion).toBe(3)
    expect(vault.drafts).toHaveLength(1)
    expect(db.migrationRuns).toBe(0)
  })
})

describe('safe recovery diagnostics and storage capability', () => {
  test('diagnostic export includes operational metadata but no form, customer, or photo values', () => {
    const diagnostic = buildSafeDiagnostic({
      userId: 'user-a',
      mode: 'readonly_recovery',
      reason: 'migration_failed',
      schemaVersion: 1,
      supportedSchemaVersion: 2,
      drafts: [draft('user-a', 'secret-value')],
      storage: { persistence: 'denied', quotaState: 'warning', usage: 90, quota: 100 },
    })
    const serialized = JSON.stringify(diagnostic)

    expect(diagnostic).toMatchObject({
      mode: 'readonly_recovery',
      reason: 'migration_failed',
      draftCount: 1,
      schemaVersion: 1,
      supportedSchemaVersion: 2,
    })
    expect(serialized).not.toContain('user-a')
    expect(serialized).not.toContain('敏感客户')
    expect(serialized).not.toContain('secret-value')
    expect(serialized).not.toContain('data:image')
  })

  test('missing persistence and quota APIs degrade safely without claiming durability', async () => {
    const health = await probeStorageCapability(undefined)

    expect(health).toEqual({
      persistence: 'unavailable',
      quotaState: 'unknown',
      usage: null,
      quota: null,
    })
  })

  test('quota pressure reports a warning while a failed persistence request reports denied', async () => {
    const health = await probeStorageCapability({
      persisted: async () => false,
      persist: async () => false,
      estimate: async () => ({ usage: 91, quota: 100 }),
    })

    expect(health).toEqual({ persistence: 'denied', quotaState: 'warning', usage: 91, quota: 100 })
  })
})

describe('truthful offline foundation state', () => {
  test('all field write and sensitive package capabilities remain disabled', () => {
    expect(offlineFeatureFlags).toEqual({
      offlineWrite: false,
      sensitiveOfflinePackage: false,
      portablePrint: false,
    })
  })

  test('offline state says the cached shell is read-only and does not claim a local save', () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: () => undefined } })
    const wrapper = mount(OfflineFoundationStatus, { props: { online: false } })

    expect(wrapper.get('[role="status"]').text()).toContain('已离线')
    expect(wrapper.text()).toContain('仅可查看本机恢复信息')
    expect(wrapper.text()).not.toContain('已保存到本机')
  })

  test('offline state reports recovery unavailable when cross-tab locks are unsupported', () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
    const wrapper = mount(OfflineFoundationStatus, { props: { online: false } })
    expect(wrapper.text()).toContain('本机恢复不可用')
    expect(wrapper.text()).not.toContain('仅可查看本机恢复信息')
  })

  test('online state does not add a decorative connectivity banner', () => {
    const wrapper = mount(OfflineFoundationStatus, { props: { online: true } })

    expect(wrapper.find('[role="status"]').exists()).toBe(false)
  })
})
