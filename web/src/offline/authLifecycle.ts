const KEY = 'tc_auth_lifecycle_logout_v1'
const CHANNEL = 'tc-auth-lifecycle-v1'
export function publishAuthLogout(storage: Storage | undefined = globalThis.localStorage): void {
  const value = `${Date.now()}-${crypto.randomUUID()}`
  try { storage?.setItem(KEY, value); storage?.removeItem(KEY) } catch {}
  try { const channel = new BroadcastChannel(CHANNEL); channel.postMessage({ type: 'logout', value }); channel.close() } catch {}
}
export function subscribeAuthLogout(callback: () => void): () => void {
  const onStorage = (event: StorageEvent) => { if (event.key === KEY) callback() }
  window.addEventListener('storage', onStorage)
  let channel: BroadcastChannel | undefined
  try { channel = new BroadcastChannel(CHANNEL); channel.onmessage = event => { if (event.data?.type === 'logout') callback() } } catch {}
  return () => { window.removeEventListener('storage', onStorage); channel?.close() }
}
