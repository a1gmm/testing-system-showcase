const capabilityBrand = Symbol('server-authorized-sensitive-attachment-capability')

export type SensitiveAttachmentCapability = { readonly [capabilityBrand]: true }

// Internal wiring seam. Production UI never derives this from a query, localStorage or client feature flag.
export const internalSensitiveAttachmentCapability: SensitiveAttachmentCapability = Object.freeze({ [capabilityBrand]: true })

export function hasSensitiveAttachmentCapability(value: unknown): value is SensitiveAttachmentCapability {
  return Boolean(value && typeof value === 'object' && (value as SensitiveAttachmentCapability)[capabilityBrand] === true)
}
