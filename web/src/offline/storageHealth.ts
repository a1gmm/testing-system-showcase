import type { RecoveryReason, StoredDraft, VaultMode } from './offlineVault'

export type PersistenceState = 'granted' | 'denied' | 'unavailable'
export type QuotaState = 'healthy' | 'warning' | 'unknown'

export interface StorageHealth {
  persistence: PersistenceState
  quotaState: QuotaState
  usage: number | null
  quota: number | null
}

export interface StorageCapabilityApi {
  persisted?: () => Promise<boolean>
  persist?: () => Promise<boolean>
  estimate?: () => Promise<{ usage?: number; quota?: number }>
}

export async function probeStorageCapability(api: StorageCapabilityApi | undefined): Promise<StorageHealth> {
  if (!api) return { persistence: 'unavailable', quotaState: 'unknown', usage: null, quota: null }

  let persistence: PersistenceState = 'unavailable'
  if (api.persisted && api.persist) {
    try {
      persistence = (await api.persisted()) || (await api.persist()) ? 'granted' : 'denied'
    } catch {
      persistence = 'unavailable'
    }
  }

  if (!api.estimate) return { persistence, quotaState: 'unknown', usage: null, quota: null }
  try {
    const estimate = await api.estimate()
    const usage = typeof estimate.usage === 'number' ? estimate.usage : null
    const quota = typeof estimate.quota === 'number' ? estimate.quota : null
    const ratio = usage !== null && quota !== null && quota > 0 ? usage / quota : null
    return { persistence, quotaState: ratio === null ? 'unknown' : ratio >= 0.85 ? 'warning' : 'healthy', usage, quota }
  } catch {
    return { persistence, quotaState: 'unknown', usage: null, quota: null }
  }
}

export function buildSafeDiagnostic(input: {
  userId: string
  mode: VaultMode
  reason?: RecoveryReason
  schemaVersion: number
  supportedSchemaVersion: number
  drafts: StoredDraft[]
  storage: StorageHealth
}) {
  return {
    format: 'field-offline-diagnostic-v1',
    generatedAt: new Date().toISOString(),
    mode: input.mode,
    reason: input.reason,
    schemaVersion: input.schemaVersion,
    supportedSchemaVersion: input.supportedSchemaVersion,
    draftCount: input.drafts.length,
    oldestDraftUpdatedAt: input.drafts.map((item) => item.updatedAt).sort()[0] ?? null,
    newestDraftUpdatedAt: input.drafts.map((item) => item.updatedAt).sort().at(-1) ?? null,
    storage: input.storage,
  }
}
