import { expect, test, vi } from 'vitest'

const get = vi.fn(async () => ({ data: { status: 'uploaded_staged' } })), post = vi.fn(async () => ({ data: { receiptId: 'r-1' } }))
vi.mock('axios', () => ({ default: { create: () => ({ get, post, interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } } }) } }))

test('staged attachment API sends encoded immutable scope and whole-file identity', async () => {
  const { api } = await import('../src/api')
  const file = new Blob(['abc'], { type: 'image/jpeg' })
  const proof={nonce:'nonce-1234567890123456',issuedAt:'2026-08-17T00:00:00.000Z',signature:'sig'}
  await api.stageRoundAttachment('round-1', 'round-1:水:1', { attachmentId: 'local-1', hash: 'a'.repeat(64), size: 3, revision: 2 }, file,proof)
  expect(post).toHaveBeenCalledWith('/rounds/round-1/staged-attachments', file, { headers: { 'Content-Type': 'image/jpeg', 'X-Client-Attachment-Id': 'local-1', 'X-Sample-Slot-Id': encodeURIComponent('round-1:水:1'), 'X-Content-Sha256': 'a'.repeat(64), 'X-Content-Size': '3', 'X-Content-Revision': '2','X-Device-Nonce':proof.nonce,'X-Device-Issued-At':proof.issuedAt,'X-Device-Signature':proof.signature }, timeout: 120_000 })
  await api.getStagedRoundAttachment('round-1', 'local-1',proof)
  await api.cancelStagedRoundAttachment('round-1', 'local-1',proof)
  expect(get).toHaveBeenCalledWith('/rounds/round-1/staged-attachments/local-1',{headers:{'X-Device-Nonce':proof.nonce,'X-Device-Issued-At':proof.issuedAt,'X-Device-Signature':proof.signature}})
  expect(post).toHaveBeenCalledWith('/rounds/round-1/staged-attachments/local-1?action=cancel',undefined,{headers:{'X-Device-Nonce':proof.nonce,'X-Device-Issued-At':proof.issuedAt,'X-Device-Signature':proof.signature}})
})
