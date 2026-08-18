import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, test } from 'vitest'

import { createIndexedDbOfflineDatabase, IndexedDbOfflineDatabase, offlineDatabaseName } from '../src/offline/indexedDb'
import { openOfflineVault, openOfflineVaultReadonly, type OfflineDatabase } from '../src/offline/offlineVault'

const record = (id: string, ownerId: string) => ({
  id,
  ownerId,
  schemaVersion: 1,
  updatedAt: '2026-08-16T10:00:00.000Z',
  payload: { formValue: `secret-${ownerId}` },
})

async function seed(factory: IDBFactory, userId: string) {
  const adapter = new IndexedDbOfflineDatabase(userId, factory)
  await adapter.snapshot()
  const request = factory.open(offlineDatabaseName(userId), 1)
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const transaction = database.transaction(['meta', 'drafts'], 'readwrite')
  transaction.objectStore('meta').put(1, 'schemaVersion')
  transaction.objectStore('drafts').put(record('own', userId))
  transaction.objectStore('drafts').put(record('foreign', 'user-b'))
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  database.close()
  return adapter
}

describe('real IndexedDB adapter boundary', () => {
  test('Unicode and spaced usernames use a stable encoded database namespace with no raw identity', async () => {
    const name = offlineDatabaseName('张 三')
    expect(name).toBe(offlineDatabaseName('张 三'))
    expect(name).not.toContain('张')
    expect(name).not.toContain(' ')
    await expect(new IndexedDbOfflineDatabase('张 三', new IDBFactory()).snapshot()).resolves.toMatchObject({ schemaVersion: 1 })
  })

  test('control characters and non-normalized identifiers cannot select a database namespace', () => {
    expect(createIndexedDbOfflineDatabase('user\nadmin', new IDBFactory())).toBeNull()
    expect(createIndexedDbOfflineDatabase('e\u0301', new IDBFactory())).toBeNull()
    expect(createIndexedDbOfflineDatabase('\uD800', new IDBFactory())).toBeNull()
    expect(createIndexedDbOfflineDatabase('\uD801', new IDBFactory())).toBeNull()
  })
  test('valid scalar namespaces remain distinct', () => {
    expect(offlineDatabaseName('😀 张')).not.toBe(offlineDatabaseName('\uFFFD 张'))
    expect(createIndexedDbOfflineDatabase('😀 张', new IDBFactory())).not.toBeNull()
  })
  test('recovery-only open leaves a legacy real IndexedDB schema unchanged', async () => {
    const factory = new IDBFactory()
    const adapter = new IndexedDbOfflineDatabase('user-a', factory)
    await adapter.snapshot()

    const vault = await openOfflineVaultReadonly({ database: adapter, userId: 'user-a', supportedSchemaVersion: 3 })

    expect(vault).toMatchObject({ mode: 'readonly_recovery', reason: 'recovery_only', schemaVersion: 1 })
    expect((await adapter.snapshot()).schemaVersion).toBe(1)
  })
  test('recovery-only open never creates an absent database', async () => {
    const factory = new IDBFactory()
    const adapter = new IndexedDbOfflineDatabase('absent-user', factory)
    await expect(openOfflineVaultReadonly({ database: adapter, userId: 'absent-user', supportedSchemaVersion: 3 }))
      .resolves.toMatchObject({ mode: 'readonly_recovery', reason: 'storage_unavailable' })
    expect((await factory.databases()).map((entry) => entry.name)).not.toContain(offlineDatabaseName('absent-user'))
  })

  test('recovery-only open leaves an existing database without stores unchanged', async () => {
    const factory = new IDBFactory()
    const name = offlineDatabaseName('missing-store')
    const request = factory.open(name, 1)
    await new Promise<void>((resolve, reject) => { request.onsuccess = () => { request.result.close(); resolve() }; request.onerror = () => reject(request.error) })
    const before = (await factory.databases()).find((entry) => entry.name === name)?.version
    const adapter = new IndexedDbOfflineDatabase('missing-store', factory)
    await expect(openOfflineVaultReadonly({ database: adapter, userId: 'missing-store', supportedSchemaVersion: 3 }))
      .resolves.toMatchObject({ reason: 'storage_unavailable' })
    expect((await factory.databases()).find((entry) => entry.name === name)?.version).toBe(before)
  })
  test('reports owner mismatch metadata while returning only the active user values', async () => {
    const adapter = await seed(new IDBFactory(), 'user-a')

    const snapshot = await adapter.snapshot()
    const vault = await openOfflineVault({ database: adapter, userId: 'user-a', supportedSchemaVersion: 1 })

    expect(snapshot.ownerMismatch).toBe(true)
    expect(snapshot.drafts.map((item) => item.id)).toEqual(['own'])
    expect(JSON.stringify(snapshot)).not.toContain('secret-user-b')
    expect(vault).toEqual({ mode: 'readonly_recovery', reason: 'owner_mismatch', drafts: [], schemaVersion: 1 })
  })

  test('missing IndexedDB capability returns unavailable instead of throwing a ReferenceError', () => {
    expect(createIndexedDbOfflineDatabase('user-a', undefined)).toBeNull()
  })

  test('real adapter open failure enters readonly recovery without throwing', async () => {
    const factory = { open: () => { throw new Error('open failed') } } as unknown as IDBFactory
    const database = new IndexedDbOfflineDatabase('user-a', factory)

    await expect(openOfflineVault({ database, userId: 'user-a', supportedSchemaVersion: 1 })).resolves.toEqual({
      mode: 'readonly_recovery', reason: 'storage_unavailable', drafts: [],
    })
  })

  test('real adapter missing-store transaction failure enters readonly recovery without throwing', async () => {
    const factory = new IDBFactory()
    const request = factory.open(offlineDatabaseName('user-a'), 1)
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => { request.result.close(); resolve() }
      request.onerror = () => reject(request.error)
    })
    const database = new IndexedDbOfflineDatabase('user-a', factory)

    await expect(openOfflineVault({ database, userId: 'user-a', supportedSchemaVersion: 1 })).resolves.toEqual({
      mode: 'readonly_recovery', reason: 'storage_unavailable', drafts: [],
    })
  })

  test('generic transaction failure enters readonly recovery without throwing', async () => {
    const database: OfflineDatabase = {
      snapshot: async () => { throw new Error('storage failed') },
      migrate: async () => { throw new Error('storage failed') },
    }

    await expect(openOfflineVault({ database, userId: 'user-a', supportedSchemaVersion: 1 })).resolves.toEqual({
      mode: 'readonly_recovery',
      reason: 'storage_unavailable',
      drafts: [],
    })
  })
})
