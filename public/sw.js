/* Tandaan service worker. postbuild replaces the placeholders below. */
const CACHE_NAME = '__TANDAAN_CACHE_VERSION__'
const PRECACHE_URLS = __TANDAAN_PRECACHE_URLS__

async function cacheResponse(url, cache) {
  try {
    const response = await fetch(url, { cache: 'no-store' })
    if (response.ok || response.type === 'opaqueredirect') {
      await cache.put(url, response.clone())
      return true
    }
  } catch {
    // Ignore individual cache failures; the app should still install.
  }
  return false
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    // Cache shell URLs in parallel; individual failures do not abort SW install.
    await Promise.all(PRECACHE_URLS.map(url => cacheResponse(url, cache)))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      // Offline-first for Home Screen launches. We serve the cached shell immediately
      // when available, which is more reliable when the network is unavailable.
      const cached = await caches.match('/') || await caches.match('/index.html')
      if (cached) {
        // Refresh the shell in the background when online.
        event.waitUntil(
          fetch(request).then(response => {
            if (response.ok) return caches.open(CACHE_NAME).then(cache => cache.put('/index.html', response.clone()))
            return undefined
          }).catch(() => undefined)
        )
        return cached
      }

      try {
        const response = await fetch(request)
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME)
          await cache.put('/index.html', response.clone())
        }
        return response
      } catch {
        return new Response('Tandaan is unavailable offline. Open it once while online to cache the app.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        })
      }
    })())
    return
  }

  event.respondWith((async () => {
    const cached = await caches.match(request)
    if (cached) return cached

    try {
      const response = await fetch(request)
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME)
        await cache.put(request, response.clone())
      }
      return response
    } catch {
      return Response.error()
    }
  })())
})

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }

  const title = data.title || 'Tandaan reminder'
  const body = data.body || 'You have a task reminder.'
  const url = data.url || '/'
  const options = {
    body,
    icon: '/icons/icon-notification-192.png',
    badge: '/icons/badge-notification-96.png',
    tag: data.tag || 'tandaan-reminder',
    data: { url }
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification?.data?.url || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find(client => typeof client.focus === 'function')
      if (existing?.focus) return existing.focus()
      return self.clients.openWindow ? self.clients.openWindow(url) : undefined
    })
  )
})
