/* Minimal service worker: it only makes the application installable and
   serves the shell offline. Data always goes over the network, we never cache a
   task (a stale list is worse than a missing list). */
const SHELL = 'agenda-shell-v1'
const ASSETS = ['/', '/index.html', '/manifest.webmanifest']

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (url.pathname.startsWith('/api')) return
  if (e.request.mode === 'navigate') {
    // The shell kept offline is refreshed on every successful visit. Without
    // that it ages forever and ends up pointing at a bundle that no longer
    // exists on the server: white screen on the first trip underground.
    e.respondWith(
      fetch(e.request)
        .then(r => {
          const copy = r.clone()
          caches.open(SHELL).then(c => c.put('/index.html', copy)).catch(() => {})
          return r
        })
        .catch(() => caches.match('/index.html'))
    )
    return
  }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)))
})
