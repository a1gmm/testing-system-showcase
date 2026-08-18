import type { StoredDraft } from './offlineVault'
import type { DraftControlEnvelope } from './draftControl'

export const HJ_TC_136_GLOBAL_FIELDS = ['org', 'orgSign', 'samplingDate'] as const
export const HJ_TC_136_ROW_FIELDS = ['sampleSlotId', 'sampleNo', 'point', 'time', 'item', 'volume', 'preserve', 'waterColor', 'smell', 'oil', 'floating', 'anomaly', 'note'] as const

export type SignedOfflineTaskPayload = {
  schemaVersion: 1
  roundId: string
  assigneeId: string
  deviceId: string
  deviceBindingPublicKeySpki: string
  deviceBindingFingerprint: string
  formCode: 'HJ-TC-136'
  ruleVersion: string
  taskVersion: string
  taskVersionOrdinal: number
  samplingDate: string
  sampleSlots: { sampleSlotId: string; temporaryId: string; qrPayload: string; matrix: string; items: string[] }[]
  formSchema: { globalFields: string[]; rowFields: string[] }
  authorization: {
    scope: 'field-draft-write'; deviceId: string; attestationId: string; nonce: string
    issuedAt: string; serverTime: string; expiresAt: string
  }
}

export type OfflineTaskPackage = { signedPayload: SignedOfflineTaskPayload; signature: string }
export type FieldRow = Record<(typeof HJ_TC_136_ROW_FIELDS)[number], unknown> & { sampleSlotId: string }

export type FieldTaskPayload = {
  kind: 'field-task'
  package: OfflineTaskPackage
  draftRevision: number
  global: Record<string, unknown>
  rows: FieldRow[]
  localSavedAt?: string
  clock: { trustedServerTime: string; wallTimeAtTrust: number; lastWallTime: number }
  control?: DraftControlEnvelope
  controlSeal?: string
}

export type FieldTaskDraft = StoredDraft & { payload: FieldTaskPayload }
export type OfflineEditability = { editable: true } | { editable: false; reason: 'signature_invalid' | 'authorization_expired' | 'clock_untrusted' | 'assignment_changed' | 'task_version_changed' | 'rule_version_changed' | 'owner_mismatch' | 'scope_invalid' }

export function draftShapeValid(draft: FieldTaskDraft): boolean {
  const slots = draft.payload.package.signedPayload.sampleSlots.map(x => x.sampleSlotId)
  const rows = draft.payload.rows
  const exactKeys = (value: Record<string, unknown>, expected: readonly string[]) => JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  if (rows.length !== slots.length || new Set(slots).size !== slots.length || new Set(rows.map(x => x.sampleSlotId)).size !== rows.length) return false
  if (rows.some((row, index) => row.sampleSlotId !== slots[index] || !exactKeys(row, HJ_TC_136_ROW_FIELDS))) return false
  return exactKeys(draft.payload.global, HJ_TC_136_GLOBAL_FIELDS)
    && draft.payload.global.samplingDate === draft.payload.package.signedPayload.samplingDate
}

function pemBytes(pem: string): Uint8Array | null {
  const match = pem.match(/-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----/)
  if (!match) return null
  try { return Uint8Array.from(atob(match[1].replace(/\s/g, '')), c => c.charCodeAt(0)) } catch { return null }
}

function signatureBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
    const canonical = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
    return canonical === value ? bytes : null
  } catch { return null }
}

function canonicalAuthorizationTimes(authorization: SignedOfflineTaskPayload['authorization']): boolean {
  const parse = (value: string): number | null => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null
  }
  const issuedAt = parse(authorization?.issuedAt), serverTime = parse(authorization?.serverTime), expiresAt = parse(authorization?.expiresAt)
  return issuedAt !== null && serverTime !== null && expiresAt !== null && issuedAt <= serverTime && serverTime < expiresAt
}

export async function verifyOfflineTaskPackage(pkg: OfflineTaskPackage, publicKeyPem: string, cryptoApi: Crypto = crypto): Promise<boolean> {
  const keyBytes = pemBytes(publicKeyPem)
  const signature = signatureBytes(pkg?.signature)
  const p = pkg?.signedPayload
  if (!keyBytes || !signature || !cryptoApi?.subtle || p?.schemaVersion !== 1 || p.formCode !== 'HJ-TC-136'
    || p.authorization?.scope !== 'field-draft-write' || p.deviceId !== p.authorization.deviceId
    || !canonicalAuthorizationTimes(p.authorization)
    || !pemBytes(p.deviceBindingPublicKeySpki) || !/^[a-f0-9]{64}$/.test(p.deviceBindingFingerprint)
    || p.assigneeId.length === 0 || !Number.isSafeInteger(p.taskVersionOrdinal) || p.taskVersionOrdinal < 1 || p.sampleSlots.some(slot => !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(slot.sampleSlotId)||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(slot.temporaryId)||slot.qrPayload!==`TC1:${slot.temporaryId.toLowerCase()}`)
    || JSON.stringify(p.formSchema.globalFields) !== JSON.stringify(HJ_TC_136_GLOBAL_FIELDS)
    || JSON.stringify(p.formSchema.rowFields) !== JSON.stringify(HJ_TC_136_ROW_FIELDS)) return false
  try {
    const bindingKeyBytes = pemBytes(p.deviceBindingPublicKeySpki)
    if (!bindingKeyBytes) return false
    const bindingData = bindingKeyBytes.buffer.slice(bindingKeyBytes.byteOffset, bindingKeyBytes.byteOffset + bindingKeyBytes.byteLength) as ArrayBuffer
    const bindingDigest = new Uint8Array(await cryptoApi.subtle.digest('SHA-256', bindingData))
    const bindingFingerprint = Array.from(bindingDigest, byte => byte.toString(16).padStart(2, '0')).join('')
    if (bindingFingerprint !== p.deviceBindingFingerprint) return false
    const keyData = keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer
    const signatureData = signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength) as ArrayBuffer
    const encoded = new TextEncoder().encode(JSON.stringify(p)); const payloadData = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer
    const key = await cryptoApi.subtle.importKey('spki', keyData, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    return cryptoApi.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signatureData, payloadData)
  } catch { return false }
}

export function createFieldTaskDraft(pkg: OfflineTaskPackage, receivedWallTime: number): FieldTaskDraft {
  const p = pkg.signedPayload
  return {
    id: `${p.roundId}:${p.formCode}`, ownerId: p.assigneeId, schemaVersion: 1, updatedAt: p.authorization.serverTime,
    payload: {
      kind: 'field-task', package: pkg, draftRevision: 0,
      global: { org: '', orgSign: '', samplingDate: p.samplingDate },
      rows: p.sampleSlots.map(slot => ({ sampleSlotId: slot.sampleSlotId, sampleNo: '', point: '', time: '', item: slot.items.join('、'), volume: '', preserve: '', waterColor: '', smell: '', oil: '', floating: '', anomaly: '', note: '' })),
      clock: { trustedServerTime: p.authorization.serverTime, wallTimeAtTrust: receivedWallTime, lastWallTime: receivedWallTime },
    },
  }
}

export function evaluateOfflineAuthorization(draft: FieldTaskDraft, wallNow = Date.now()): OfflineEditability {
  const p = draft.payload.package.signedPayload
  if (draft.ownerId !== p.assigneeId) return { editable: false, reason: 'owner_mismatch' }
  if (p.authorization.scope !== 'field-draft-write') return { editable: false, reason: 'scope_invalid' }
  const clock = draft.payload.clock
  if (clock.trustedServerTime !== p.authorization.serverTime) return { editable: false, reason: 'clock_untrusted' }
  const elapsed = wallNow - clock.wallTimeAtTrust
  if (!Number.isFinite(elapsed) || wallNow < clock.lastWallTime || elapsed < 0 || elapsed > 48 * 3600_000) return { editable: false, reason: 'clock_untrusted' }
  const trustedNow = Date.parse(clock.trustedServerTime) + elapsed
  if (!Number.isFinite(trustedNow) || trustedNow >= Date.parse(p.authorization.expiresAt)) return { editable: false, reason: 'authorization_expired' }
  return { editable: true }
}

export async function verifyFieldTaskDraft(draft: FieldTaskDraft, publicKeyPem: string, wallNow = Date.now(), cryptoApi: Crypto = crypto, localDeviceId: string | null = null): Promise<OfflineEditability> {
  if (!await verifyOfflineTaskPackage(draft.payload.package, publicKeyPem, cryptoApi)) return { editable: false, reason: 'signature_invalid' }
  if (!draftShapeValid(draft)) return { editable: false, reason: 'scope_invalid' }
  if (draft.payload.control?.terminal && draft.payload.control.terminal !== 'active') return { editable: false, reason: 'scope_invalid' }
  if (!localDeviceId || localDeviceId !== draft.payload.package.signedPayload.deviceId) return { editable: false, reason: 'scope_invalid' }
  return evaluateOfflineAuthorization(draft, wallNow)
}

export function reconcileTaskDraft(draft: FieldTaskDraft, current: OfflineTaskPackage): OfflineEditability {
  const old = draft.payload.package.signedPayload
  const next = current.signedPayload
  if (draft.ownerId !== old.assigneeId) return { editable: false, reason: 'owner_mismatch' }
  if (old.assigneeId !== next.assigneeId) return { editable: false, reason: 'assignment_changed' }
  if (old.ruleVersion !== next.ruleVersion) return { editable: false, reason: 'rule_version_changed' }
  if (old.taskVersion !== next.taskVersion) return { editable: false, reason: 'task_version_changed' }
  return { editable: true }
}

export function renewTaskAuthorization(draft: FieldTaskDraft, pkg: OfflineTaskPackage, receivedWallTime: number): FieldTaskDraft {
  return { ...draft, payload: { ...draft.payload, package: pkg, clock: { trustedServerTime: pkg.signedPayload.authorization.serverTime, wallTimeAtTrust: receivedWallTime, lastWallTime: receivedWallTime } } }
}

export function renewalValid(draft: FieldTaskDraft, pkg: OfflineTaskPackage): boolean {
  const old = draft.payload.package.signedPayload, next = pkg.signedPayload
  if (old.roundId !== next.roundId || old.assigneeId !== next.assigneeId || old.deviceId !== next.deviceId
    || old.deviceBindingPublicKeySpki !== next.deviceBindingPublicKeySpki || old.deviceBindingFingerprint !== next.deviceBindingFingerprint
    || old.formCode !== next.formCode || old.ruleVersion !== next.ruleVersion || next.authorization.scope !== 'field-draft-write') return false
  if (Date.parse(next.authorization.serverTime) <= Date.parse(old.authorization.serverTime) || Date.parse(next.authorization.issuedAt) < Date.parse(old.authorization.issuedAt) || Date.parse(next.authorization.expiresAt) <= Date.parse(old.authorization.expiresAt)) return false
  return next.taskVersion === old.taskVersion && next.taskVersionOrdinal===old.taskVersionOrdinal
}
