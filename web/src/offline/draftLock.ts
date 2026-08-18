type LockApi = { request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T> | T): Promise<T> }
const queues = new Map<string, Promise<unknown>>()

export function fieldDraftLockName(draftId: string) { return `tc-field-draft-v1:${draftId}` }

export async function withFieldDraftLock<T>(draftId: string, callback: () => Promise<T>, locks: LockApi | undefined = globalThis.navigator?.locks as LockApi | undefined): Promise<T> {
  if (!locks) throw new Error('DRAFT_LOCK_UNAVAILABLE')
  const name = fieldDraftLockName(draftId)
  const prior = queues.get(name) ?? Promise.resolve()
  let release!: () => void
  const turn = new Promise<void>(resolve => { release = resolve })
  const queued = prior.catch(() => undefined).then(() => turn)
  queues.set(name, queued)
  await prior.catch(() => undefined)
  try { return await locks.request(name, { mode: 'exclusive' }, callback) }
  finally { release(); if (queues.get(name) === queued) queues.delete(name) }
}
