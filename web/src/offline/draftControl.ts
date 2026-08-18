import type { FieldTaskDraft } from './fieldTaskDraft'

export type DraftTerminalState = 'active' | 'conflict' | 'revoked' | 'logout' | 'authorization_expired' | 'clock_untrusted' | 'integrity_failure' | 'storage_error' | 'submitted'
export type DraftControlEnvelope = {
  version: 1; roundId: string; ownerId: string; packageSignature: string; taskVersion: string; ruleVersion: string
  revision: number; trustedServerTime: string; wallTimeAtTrust: number; lastWallTime: number; terminal: DraftTerminalState
  business: { global: Record<string, unknown>; rows: FieldTaskDraft['payload']['rows'] }
}
