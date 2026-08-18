import { beforeEach, expect, test } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { SubmissionOutbox, syncSubmission, type SubmissionReceipt } from '../src/offline/submissionOutbox'

const draft = {
  id: 'round-1:HJ-TC-136', ownerId: 'sampler-a', updatedAt: '2026-08-17T01:00:00.000Z',
  payload: {
    draftRevision: 7,
    package: { signedPayload: { roundId: 'round-1', assigneeId: 'sampler-a', deviceId: 'device-a', taskVersion: 'task-v1', ruleVersion: 'rule-v1', formCode: 'HJ-TC-136' } },
    global: { org: '企业', samplingDate: '2026-08-17' }, rows: [{ sampleSlotId: 'round-1:水:1', point: '排口' }],
  },
} as any

let factory: IDBFactory
beforeEach(() => { factory = new IDBFactory() })

test('one immutable submission id is durably bound to one draft revision and canonical hash', async () => {
  const ids = ['submission-local-00000001', 'submission-local-00000002'], outbox = new SubmissionOutbox('sampler-a', factory, () => ids.shift()!)
  const first = await outbox.create(draft, ['receipt-b', 'receipt-a']), again = await outbox.create(draft, ['receipt-a', 'receipt-b'])
  expect(again.clientSubmissionId).toBe(first.clientSubmissionId)
  expect(again.payloadHash).toBe(first.payloadHash)
  expect(again.attachmentReceipts).toEqual(['receipt-a', 'receipt-b'])
  expect((await new SubmissionOutbox('sampler-a', factory).get(first.clientSubmissionId))?.status).toBe('queued')
})

test('lost create response changes to unknown_commit and only queries the receipt on every recovery', async () => {
  const outbox = new SubmissionOutbox('sampler-a', factory, () => 'submission-local-00000003'), local = await outbox.create(draft, [])
  let creates = 0, queries = 0
  const unavailable = { create: async () => { creates++; throw new Error('timeout') }, query: async () => { queries++; throw Object.assign(new Error('not found'), { status: 404 }) } }
  const first = await syncSubmission(outbox, local.clientSubmissionId, unavailable)
  expect(first.status).toBe('unknown_commit'); expect(creates).toBe(1); expect(queries).toBe(1)
  const second = await syncSubmission(outbox, local.clientSubmissionId, unavailable)
  expect(second.status).toBe('unknown_commit'); expect(creates).toBe(1); expect(queries).toBe(2)
})

test('receipt query resolves an unknown commit without clearing the frozen local payload', async () => {
  const outbox = new SubmissionOutbox('sampler-a', factory, () => 'submission-local-00000004'), local = await outbox.create(draft, [])
  await outbox.markUnknown(local.clientSubmissionId)
  const receipt: SubmissionReceipt = { clientSubmissionId: local.clientSubmissionId, receiptId: 'server-receipt-1', status: 'complete', payloadHash: local.payloadHash }
  const result = await syncSubmission(outbox, local.clientSubmissionId, { create: async () => { throw new Error('must not create') }, query: async () => receipt })
  expect(result.status).toBe('complete'); expect(result.canonicalPayload).toBe(local.canonicalPayload); expect(result.serverReceipt?.receiptId).toBe('server-receipt-1')
})

test('a server receipt with a different payload hash is a visible integrity failure, not a network retry', async()=>{
  const outbox=new SubmissionOutbox('sampler-a',factory,()=> 'submission-local-00000005'),local=await outbox.create(draft,[]);await outbox.markUnknown(local.clientSubmissionId)
  await expect(syncSubmission(outbox,local.clientSubmissionId,{create:async()=>{throw new Error('must not create')},query:async()=>({clientSubmissionId:local.clientSubmissionId,receiptId:'wrong',status:'complete',payloadHash:'0'.repeat(64)})})).rejects.toThrow('SUBMISSION_RECEIPT_MISMATCH')
  expect((await outbox.get(local.clientSubmissionId))?.status).toBe('invalid')
})

test('reopened page finds the durable status for its exact draft revision',async()=>{
  const outbox=new SubmissionOutbox('sampler-a',factory,()=> 'submission-local-00000006'),local=await outbox.create(draft,[]);await outbox.markSubmitting(local.clientSubmissionId);await outbox.recordReceipt(local.clientSubmissionId,{clientSubmissionId:local.clientSubmissionId,receiptId:'server-pending',status:'pending',payloadHash:local.payloadHash})
  const reopened=new SubmissionOutbox('sampler-a',factory),found=await reopened.findForDraft(draft)
  expect(found?.clientSubmissionId).toBe(local.clientSubmissionId);expect(found?.status).toBe('pending')
})
