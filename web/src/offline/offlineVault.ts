export type RecoveryReason = 'migration_failed' | 'newer_schema' | 'identity_unavailable' | 'owner_mismatch' | 'storage_unavailable' | 'recovery_only'
export type VaultMode = 'ready' | 'readonly_recovery'

export interface StoredDraft {
  id: string
  ownerId: string
  schemaVersion: number
  updatedAt: string
  payload: Record<string, unknown>
}

export interface DatabaseSnapshot {
  schemaVersion: number
  drafts: StoredDraft[]
  ownerMismatch?: boolean
}

export interface OfflineDatabase {
  snapshot(): Promise<DatabaseSnapshot> | DatabaseSnapshot
  snapshotReadonly?(): Promise<DatabaseSnapshot> | DatabaseSnapshot
  migrate(targetVersion: number): Promise<void>
  saveDraftAtomic?(draft: StoredDraft, expectedRevision: number, command: { scope: 'global' | 'row'; field: string; sampleSlotId?: string; value: unknown; baseValue?: unknown; savedAt: string; wallTime: number }): Promise<StoredDraft>
  renewDraftAtomic?(draft: StoredDraft, expectedRevision: number, taskPackage: import('./fieldTaskDraft').OfflineTaskPackage): Promise<StoredDraft>
  checkpointDraftClockAtomic?(draft: StoredDraft, expectedRevision: number, wallTime: number): Promise<StoredDraft>
  setDraftTerminalAtomic?(draft: StoredDraft, terminal: string, wallTime: number): Promise<StoredDraft>
  persistDraftTerminal?(draftId: string, terminal: string, wallTime: number): Promise<StoredDraft>
  installDraftAtomic?(taskPackage: import('./fieldTaskDraft').OfflineTaskPackage): Promise<StoredDraft>
  draftWriteStatus?(draft: import('./fieldTaskDraft').FieldTaskDraft): Promise<{ allowed: boolean; reason?: string }>
  denyDraftAuthority?(draft: import('./fieldTaskDraft').FieldTaskDraft, reason: string): Promise<void>
  rebuildConflictedDraftAtomic?(draft: import('./fieldTaskDraft').FieldTaskDraft, taskPackage: import('./fieldTaskDraft').OfflineTaskPackage): Promise<{ archived: StoredDraft; replacement: StoredDraft; copyCandidates: import('./draftConflictRecovery').ConflictCopyCandidates }>
}

export interface OfflineVault {
  mode: VaultMode
  reason?: RecoveryReason
  drafts: StoredDraft[]
  schemaVersion?: number
}

interface MemoryOptions extends DatabaseSnapshot {
  failMigration?: boolean
}

export class MemoryOfflineDatabase implements OfflineDatabase {
  private state: DatabaseSnapshot
  private readonly failMigration: boolean
  migrationRuns = 0

  constructor(options: MemoryOptions) {
    this.state = structuredClone({ schemaVersion: options.schemaVersion, drafts: options.drafts })
    this.failMigration = options.failMigration ?? false
  }

  snapshot(): DatabaseSnapshot {
    return structuredClone(this.state)
  }

  async migrate(targetVersion: number): Promise<void> {
    this.migrationRuns += 1
    const next = structuredClone(this.state)
    next.schemaVersion = targetVersion
    next.drafts = next.drafts.map((item) => ({ ...item, schemaVersion: targetVersion }))
    await Promise.resolve()
    if (this.failMigration) throw new Error('migration failed')
    this.state = next
  }
}

const writerLocks = new WeakMap<OfflineDatabase, Promise<void>>()

async function migrateWithSingleWriter(database: OfflineDatabase, targetVersion: number): Promise<void> {
  const active = writerLocks.get(database)
  if (active) {
    await active
    const current = await database.snapshot()
    if (current.schemaVersion < targetVersion) await migrateWithSingleWriter(database, targetVersion)
    return
  }

  const migration = database.migrate(targetVersion)
  writerLocks.set(database, migration)
  try {
    await migration
  } finally {
    writerLocks.delete(database)
  }
}

export async function openOfflineVault(options: {
  database: OfflineDatabase
  userId: string
  supportedSchemaVersion: number
}): Promise<OfflineVault> {
  let original: DatabaseSnapshot
  try {
    original = await options.database.snapshot()
  } catch {
    return { mode: 'readonly_recovery', reason: 'storage_unavailable', drafts: [] }
  }
  const ownDrafts = () => original.drafts.filter((item) => item.ownerId === options.userId)

  if (!options.userId.trim()) return { mode: 'readonly_recovery', reason: 'identity_unavailable', drafts: [], schemaVersion: original.schemaVersion }
  if (original.ownerMismatch || original.drafts.some((item) => item.ownerId !== options.userId)) {
    return { mode: 'readonly_recovery', reason: 'owner_mismatch', drafts: [], schemaVersion: original.schemaVersion }
  }
  if (original.schemaVersion > options.supportedSchemaVersion) {
    return { mode: 'readonly_recovery', reason: 'newer_schema', drafts: ownDrafts(), schemaVersion: original.schemaVersion }
  }

  if (original.schemaVersion < options.supportedSchemaVersion) {
    try {
      await migrateWithSingleWriter(options.database, options.supportedSchemaVersion)
    } catch {
      return { mode: 'readonly_recovery', reason: 'migration_failed', drafts: ownDrafts(), schemaVersion: original.schemaVersion }
    }
  }

  let current: DatabaseSnapshot
  try {
    current = await options.database.snapshot()
  } catch {
    return { mode: 'readonly_recovery', reason: 'storage_unavailable', drafts: ownDrafts(), schemaVersion: original.schemaVersion }
  }
  return {
    mode: 'ready',
    drafts: current.drafts.filter((item) => item.ownerId === options.userId),
    schemaVersion: current.schemaVersion,
  }
}

export async function openOfflineVaultReadonly(options: {
  database: OfflineDatabase
  userId: string
  supportedSchemaVersion: number
}): Promise<OfflineVault> {
  let snapshot: DatabaseSnapshot
  try {
    snapshot = await (options.database.snapshotReadonly?.() ?? options.database.snapshot())
  } catch {
    return { mode: 'readonly_recovery', reason: 'storage_unavailable', drafts: [] }
  }
  if (!options.userId.trim()) {
    return { mode: 'readonly_recovery', reason: 'identity_unavailable', drafts: [], schemaVersion: snapshot.schemaVersion }
  }
  if (snapshot.ownerMismatch || snapshot.drafts.some((item) => item.ownerId !== options.userId)) {
    return { mode: 'readonly_recovery', reason: 'owner_mismatch', drafts: [], schemaVersion: snapshot.schemaVersion }
  }
  return {
    mode: 'readonly_recovery',
    reason: snapshot.schemaVersion > options.supportedSchemaVersion ? 'newer_schema' : 'recovery_only',
    drafts: snapshot.drafts.filter((item) => item.ownerId === options.userId),
    schemaVersion: snapshot.schemaVersion,
  }
}
