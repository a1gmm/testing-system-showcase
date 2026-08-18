export type ServiceWorkerState = 'unsupported' | 'registered' | 'registration_failed'
const SERVICE_WORKER_REVISION = 'sw3'

function currentBuildIdentity(): string {
  const file = new URL(import.meta.url).pathname.split('/').at(-1) || 'app'
  return file.replace(/[^A-Za-z0-9_-]/g, '-')
}

export async function registerFieldServiceWorker(): Promise<ServiceWorkerState> {
  if (!('serviceWorker' in navigator)) return 'unsupported'
  try {
    await navigator.serviceWorker.register(`/sw.js?build=${currentBuildIdentity()}-${SERVICE_WORKER_REVISION}`, { scope: '/', updateViaCache: 'none' })
    return 'registered'
  } catch {
    return 'registration_failed'
  }
}
