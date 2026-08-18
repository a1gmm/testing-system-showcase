import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { describe, expect, test } from 'vitest'
import { registerFieldServiceWorker } from '../src/offline/pwaRuntime'

type Handler = (event: any) => void

class TestResponse {
  ok: boolean
  status: number
  type: string
  redirected: boolean
  headers: { get: (name: string) => string | null }
  private readonly rawHeaders: Record<string, string>
  constructor(private readonly body: string, options: { status?: number; type?: string; redirected?: boolean; headers?: Record<string, string> } = {}) {
    this.status = options.status ?? 200
    this.ok = this.status >= 200 && this.status < 300
    this.type = options.type ?? 'basic'
    this.redirected = options.redirected ?? false
    this.rawHeaders = Object.fromEntries(Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]))
    this.headers = { get: (name) => this.rawHeaders[name.toLowerCase()] ?? null }
  }
  text() { return Promise.resolve(this.body) }
  clone() { return new TestResponse(this.body, { status: this.status, type: this.type, redirected: this.redirected, headers: this.rawHeaders }) }
}

function createHarness(fetchImpl: (request: any) => Promise<TestResponse>, initial: Record<string, string[]> = {}) {
  const handlers = new Map<string, Handler>()
  const stores = new Map<string, Map<string, TestResponse>>()
  for (const [name, keys] of Object.entries(initial)) stores.set(name, new Map(keys.map((key) => [key, new TestResponse('old')])))
  const keyOf = (input: any) => typeof input === 'string' ? input : input.url
  const caches = {
    open: async (name: string) => {
      const store = stores.get(name) ?? new Map<string, TestResponse>()
      stores.set(name, store)
      return {
        put: async (key: any, response: TestResponse) => { store.set(keyOf(key), response) },
        match: async (key: any) => store.get(keyOf(key)),
      }
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (key: any) => {
      for (const store of stores.values()) {
        const hit = store.get(keyOf(key))
        if (hit) return hit
      }
    },
  }
  const self = {
    location: { origin: 'https://field.local', href: 'https://field.local/sw.js?build=test-build' },
    clients: { claim: async () => undefined },
    addEventListener: (name: string, handler: Handler) => handlers.set(name, handler),
  }
  return { handlers, stores, context: { self, caches, fetch: fetchImpl, URL, Request, Promise, console } }
}

async function loadWorker(harness: ReturnType<typeof createHarness>) {
  const source = await readFile(new URL('public/sw.js', `file://${process.cwd()}/`), 'utf8')
  vm.runInNewContext(source, harness.context, { filename: 'public/sw.js' })
}

async function dispatchWait(handler: Handler) {
  let pending: Promise<unknown> | undefined
  handler({ waitUntil: (promise: Promise<unknown>) => { pending = promise } })
  await pending
}

describe('production service worker', () => {
  test('registration URL carries a build identity so changed assets trigger a new worker install', async () => {
    let registered = ''
    const original = navigator.serviceWorker
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register: async (url: string) => { registered = url } } })
    try {
      await registerFieldServiceWorker()
    } finally {
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: original })
    }
    expect(registered).toMatch(/^\/sw\.js\?build=[A-Za-z0-9_-]+$/)
  })

  test('install discovers and caches the real hashed JS/CSS plus manifest and icon from the built shell', async () => {
    const requested: string[] = []
    const shell = '<link rel="stylesheet" href="/assets/index-ABC.css"><link rel="manifest" href="/manifest.webmanifest"><script type="module" src="/assets/index-XYZ.js"></script>'
    const manifest = '{"icons":[{"src":"/pwa-icon.svg"}]}'
    const harness = createHarness(async (request) => {
      const url = typeof request === 'string' ? request : request.url
      requested.push(url)
      if (url.endsWith('/')) return new TestResponse(shell, { headers: { 'content-type': 'text/html' } })
      if (url.endsWith('manifest.webmanifest')) return new TestResponse(manifest, { headers: { 'content-type': 'application/manifest+json' } })
      if (url.endsWith('.css')) return new TestResponse('css', { headers: { 'content-type': 'text/css' } })
      if (url.endsWith('.js')) return new TestResponse('js', { headers: { 'content-type': 'text/javascript' } })
      return new TestResponse('svg', { headers: { 'content-type': 'image/svg+xml' } })
    })
    await loadWorker(harness)

    await dispatchWait(harness.handlers.get('install')!)

    expect(harness.stores.has('field-shell-test-build')).toBe(true)
    expect(requested).toEqual(expect.arrayContaining([
      'https://field.local/',
      'https://field.local/assets/index-ABC.css',
      'https://field.local/assets/index-XYZ.js',
      'https://field.local/manifest.webmanifest',
      'https://field.local/pwa-icon.svg',
    ]))
    expect([...harness.stores.values()].flatMap((store) => [...store.keys()])).toEqual(expect.arrayContaining([
      'https://field.local/__field_public_shell__',
      'https://field.local/assets/index-ABC.css',
      'https://field.local/assets/index-XYZ.js',
    ]))
  })

  test('failed upgrade keeps the previously bootable cache', async () => {
    const harness = createHarness(async (request) => {
      const url = typeof request === 'string' ? request : request.url
      if (url.endsWith('/')) return new TestResponse('<script src="/assets/new.js"></script>', { headers: { 'content-type': 'text/html' } })
      throw new Error('asset unavailable')
    }, { 'field-shell-v1': ['https://field.local/__field_public_shell__', 'https://field.local/assets/old.js'] })
    await loadWorker(harness)

    await expect(dispatchWait(harness.handlers.get('install')!)).rejects.toThrow('asset unavailable')

    expect(harness.stores.get('field-shell-v1')?.has('https://field.local/__field_public_shell__')).toBe(true)
  })

  test.each([
    ['JavaScript', '/assets/app-ABC.js', 'text/html'],
    ['CSS', '/assets/app-ABC.css', 'text/html'],
    ['manifest', '/manifest.webmanifest', 'text/html'],
    ['icon', '/pwa-icon.svg', 'text/html'],
  ])('rejects a 200 HTML fallback for expected %s and retains the old cache', async (_label, badPath, badMime) => {
    const shell = '<link rel="stylesheet" href="/assets/app-ABC.css"><link rel="manifest" href="/manifest.webmanifest"><script src="/assets/app-ABC.js"></script>'
    const manifest = '{"icons":[{"src":"/pwa-icon.svg"}]}'
    const harness = createHarness(async (request) => {
      const path = new URL(typeof request === 'string' ? request : request.url).pathname
      if (path === '/') return new TestResponse(shell, { headers: { 'content-type': 'text/html' } })
      if (path === badPath) return new TestResponse('<html>fallback</html>', { headers: { 'content-type': badMime } })
      if (path === '/manifest.webmanifest') return new TestResponse(manifest, { headers: { 'content-type': 'application/manifest+json' } })
      if (path.endsWith('.js')) return new TestResponse('js', { headers: { 'content-type': 'text/javascript' } })
      if (path.endsWith('.css')) return new TestResponse('css', { headers: { 'content-type': 'text/css' } })
      return new TestResponse('svg', { headers: { 'content-type': 'image/svg+xml' } })
    }, { 'field-shell-previous': ['https://field.local/__field_public_shell__'] })
    await loadWorker(harness)

    await expect(dispatchWait(harness.handlers.get('install')!)).rejects.toThrow(/content type/)
    expect(harness.stores.get('field-shell-previous')?.has('https://field.local/__field_public_shell__')).toBe(true)
  })

  test.each([
    ['/assets/font-A.woff', 'font/woff'],
    ['/assets/font-A.woff2', 'font/woff2'],
    ['/assets/font-A.ttf', 'font/ttf'],
  ])('accepts expected production font MIME for %s', async (fontPath, mime) => {
    const harness = createHarness(async (request) => {
      const path = new URL(typeof request === 'string' ? request : request.url).pathname
      if (path === '/') return new TestResponse(`<link rel="preload" href="${fontPath}">`, { headers: { 'content-type': 'text/html' } })
      if (path === '/manifest.webmanifest') return new TestResponse('{"icons":[]}', { headers: { 'content-type': 'application/manifest+json' } })
      return new TestResponse('font', { headers: { 'content-type': mime } })
    })
    await loadWorker(harness)

    await expect(dispatchWait(harness.handlers.get('install')!)).resolves.toBeUndefined()
  })

  test('manifest cannot expand the install allowlist into API or unknown paths', async () => {
    const requested: string[] = []
    const harness = createHarness(async (request) => {
      const url = typeof request === 'string' ? request : request.url
      requested.push(url)
      if (url.endsWith('/')) return new TestResponse('<script src="/assets/app-ABC.js"></script>', { headers: { 'content-type': 'text/html' } })
      if (url.endsWith('manifest.webmanifest')) return new TestResponse('{"icons":[{"src":"/api/customers"},{"src":"/unknown-photo.jpg"},{"src":"/pwa-icon.svg"}]}', { headers: { 'content-type': 'application/manifest+json' } })
      if (url.endsWith('.js')) return new TestResponse('js', { headers: { 'content-type': 'text/javascript' } })
      return new TestResponse('svg', { headers: { 'content-type': 'image/svg+xml' } })
    })
    await loadWorker(harness)

    await dispatchWait(harness.handlers.get('install')!)

    expect(requested).toContain('https://field.local/pwa-icon.svg')
    expect(requested).not.toContain('https://field.local/api/customers')
    expect(requested).not.toContain('https://field.local/unknown-photo.jpg')
  })

  test.each([
    ['authorization', { url: 'https://field.local/assets/app.js', headers: { get: (name: string) => name.toLowerCase() === 'authorization' ? 'Bearer secret' : null } }],
    ['cross origin', { url: 'https://cdn.local/assets/app.js' }],
    ['credentials include', { url: 'https://field.local/assets/app.js', credentials: 'include' }],
    ['query token', { url: 'https://field.local/assets/app.js?token=secret' }],
    ['API', { url: 'https://field.local/api/me' }],
    ['attachment', { url: 'https://field.local/attachments/photo.jpg' }],
    ['unknown path', { url: 'https://field.local/customer-export.csv' }],
  ])('does not intercept unsafe %s requests', async (_name, overrides) => {
    const harness = createHarness(async () => new TestResponse('network'))
    await loadWorker(harness)
    let response: Promise<unknown> | undefined
    harness.handlers.get('fetch')!({
      request: { method: 'GET', mode: 'no-cors', destination: 'script', credentials: 'same-origin', headers: { get: () => null }, ...overrides },
      respondWith: (promise: Promise<unknown>) => { response = promise },
    })
    expect(response).toBeUndefined()
  })

  test.each([
    ['redirected', new TestResponse('login', { redirected: true })],
    ['private', new TestResponse('private', { headers: { 'cache-control': 'private' } })],
    ['no-store', new TestResponse('private', { headers: { 'cache-control': 'no-store' } })],
    ['opaque', new TestResponse('opaque', { type: 'opaque' })],
  ])('refuses to install a %s public shell response', async (_name, response) => {
    const harness = createHarness(async () => response)
    await loadWorker(harness)
    await expect(dispatchWait(harness.handlers.get('install')!)).rejects.toThrow()
  })
})
