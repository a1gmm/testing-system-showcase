import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, test } from 'vitest'
import { ManagedDeviceKeyStore } from '../src/offline/managedDevice'
import { createHash, createPublicKey } from 'node:crypto'

describe('managed-device private-key possession', () => {
  test('only the enrolled device with a non-extractable private key proves the signed binding', async () => {
    const deviceA = new ManagedDeviceKeyStore(new IDBFactory(), crypto), deviceB = new ManagedDeviceKeyStore(new IDBFactory(), crypto)
    const binding = await deviceA.enroll()
    expect(binding.fingerprint).toBe(createHash('sha256').update(createPublicKey(binding.publicKeySpki).export({ type: 'spki', format: 'der' })).digest('hex'))
    expect(await deviceA.prove(binding.publicKeySpki, binding.fingerprint, 'round|nonce|signature')).toBe(true)
    expect(await deviceB.prove(binding.publicKeySpki, binding.fingerprint, 'round|nonce|signature')).toBe(false)
    expect(await deviceA.prove(binding.publicKeySpki, binding.fingerprint, 'different-challenge')).toBe(true)
    expect(await deviceA.prove(binding.publicKeySpki, '00'.repeat(32), 'round|nonce|signature')).toBe(false)
  })
})
