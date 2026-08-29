const CACHE_PREFIX = 'field-shell-'
const BUILD_ID = new URL(self.location.href).searchParams.get('build') || 'development'
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID.replace(/[^A-Za-z0-9_-]/g, '')}`
const SHELL_KEY = '/__field_public_shell__'
const MANIFEST_PATH = '/manifest.webmanifest'
const IMMUTABLE_ASSET_PATH = /^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|woff2?|ttf)$/
const PUBLIC_FONT_PATHS = new Set(['/fonts/source-han-sans-sc-subset.woff2','/fonts/source-han-sans-sc-admin.woff2','/fonts/dm-sans-variable.woff2','/fonts/ibm-plex-mono-regular.woff2'])
const PUBLIC_METADATA_PATHS = new Set([MANIFEST_PATH, '/favicon.svg', '/pwa-icon.svg'])
const isPublicAssetPath = (path) => IMMUTABLE_ASSET_PATH.test(path) || PUBLIC_FONT_PATHS.has(path) || PUBLIC_METADATA_PATHS.has(path)

function absolute(path) {
  return new URL(path, self.location.origin).href
}

function cacheControlIsSensitive(response) {
  const value = response.headers.get('cache-control') || ''
  return /(?:^|,)\s*(?:no-store|private)(?:\s|,|$)/i.test(value)
}

function assertPublicResponse(response, label) {
  if (!response || !response.ok) throw new Error(`${label} unavailable`)
  if (response.redirected) throw new Error(`${label} redirected`)
  if (response.type === 'opaque' || response.type === 'opaqueredirect') throw new Error(`${label} is opaque`)
  if (cacheControlIsSensitive(response)) throw new Error(`${label} is private`)
  return response
}

function assertExpectedContentType(response, path) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  const valid = path === '/'
    ? contentType.includes('text/html')
    : path.endsWith('.js')
      ? /(?:java|ecma)script/.test(contentType)
      : path.endsWith('.css')
        ? contentType.includes('text/css')
        : path === MANIFEST_PATH
          ? /application\/(?:manifest\+json|json)/.test(contentType)
          : path.endsWith('.woff2')
            ? contentType.includes('font/woff2')
            : path.endsWith('.woff')
              ? contentType.includes('font/woff')
              : path.endsWith('.ttf')
                ? /(?:font\/ttf|application\/x-font-ttf)/.test(contentType)
          : path.endsWith('.svg')
            ? contentType.includes('image/svg+xml')
            : false
  if (!valid) throw new Error(`asset ${path} has unexpected content type`)
  return response
}

function publicRequest(path) {
  return new Request(absolute(path), { method: 'GET', credentials: 'omit', redirect: 'manual', cache: 'no-store' })
}

function discoverShellAssets(html) {
  const found = new Set([MANIFEST_PATH])
  const pattern = /(?:src|href)=["']([^"']+)["']/g
  for (const match of html.matchAll(pattern)) {
    const url = new URL(match[1], self.location.origin)
    if (url.origin === self.location.origin && isPublicAssetPath(url.pathname) && !url.search) found.add(url.pathname)
  }
  return [...found]
}

async function installPublicShell() {
  const cache = await caches.open(CACHE_NAME)
  try {
    const shellResponse = assertExpectedContentType(assertPublicResponse(await fetch(publicRequest('/')), 'public shell'), '/')
    const html = await shellResponse.clone().text()
    const assetPaths = discoverShellAssets(html)
    const manifestResponse = assertExpectedContentType(assertPublicResponse(await fetch(publicRequest(MANIFEST_PATH)), 'manifest'), MANIFEST_PATH)
    const manifest = JSON.parse(await manifestResponse.clone().text())
    const iconPaths = Array.isArray(manifest.icons)
      ? manifest.icons.map((icon) => new URL(icon.src, self.location.origin)).filter((url) => url.origin === self.location.origin && !url.search && url.pathname === '/pwa-icon.svg').map((url) => url.pathname)
      : []

    await cache.put(absolute(SHELL_KEY), shellResponse)
    await cache.put(absolute(MANIFEST_PATH), manifestResponse)
    for (const path of [...assetPaths.filter((path) => path !== MANIFEST_PATH), ...iconPaths]) {
      const response = assertExpectedContentType(assertPublicResponse(await fetch(publicRequest(path)), `asset ${path}`), path)
      await cache.put(absolute(path), response)
    }
  } catch (error) {
    await caches.delete(CACHE_NAME)
    throw error
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(installPublicShell())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const current = await caches.open(CACHE_NAME)
    if (!await current.match(absolute(SHELL_KEY))) return
    const keys = await caches.keys()
    await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)))
    await self.clients.claim()
  })())
})

function hasUnsafeRequestMetadata(request, url) {
  return request.method !== 'GET'
    || url.origin !== self.location.origin
    || Boolean(url.search)
    || Boolean(request.headers.get('authorization'))
}

async function publicNavigation(request) {
  const cache = await caches.open(CACHE_NAME)
  try {
    return assertPublicResponse(await fetch(publicRequest(new URL(request.url).pathname)), 'navigation')
  } catch {
    return cache.match(absolute(SHELL_KEY))
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (hasUnsafeRequestMetadata(request, url)) return

  if (request.mode === 'navigate') {
    event.respondWith(publicNavigation(request))
    return
  }

  if (request.credentials === 'include') return
  if (!isPublicAssetPath(url.pathname)) return
  event.respondWith(caches.open(CACHE_NAME).then(async(cache)=>{
    const cached=await cache.match(absolute(url.pathname));if(cached)return cached
    const response=assertExpectedContentType(assertPublicResponse(await fetch(publicRequest(url.pathname)),`asset ${url.pathname}`),url.pathname)
    await cache.put(absolute(url.pathname),response.clone());return response
  }))
})
