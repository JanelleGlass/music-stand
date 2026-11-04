// Offline support. Bump VERSION whenever you change any app file, so iPads
// pick up the new version (the app then shows an "Update now" banner).
const VERSION = '1.7.0';
const CORE_CACHE = `ms-core-${VERSION}`;
// Third-party libraries change only when their files are replaced; bump LIB
// then. Kept separate so app updates don't re-download ~15 MB of models.
const LIB_CACHE = 'ms-lib-1';

const CORE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/adjust-ui.js',
  'js/app.js',
  'js/backup.js',
  'js/data.js',
  'js/db.js',
  'js/flip.js',
  'js/gdrive-auth.js',
  'js/gdrive.js',
  'js/ink.js',
  'js/ink-draw.js',
  'js/library.js',
  'js/lists.js',
  'js/merge.js',
  'js/notes-merge.js',
  'js/notes-store.js',
  'js/notes-ui.js',
  'js/page-view.js',
  'js/paging.js',
  'js/pdfdoc.js',
  'js/scrub.js',
  'js/scrubber.js',
  'js/settings-ui.js',
  'js/sync.js',
  'js/sync-data.js',
  'js/sync-engine.js',
  'js/sync-local.js',
  'js/sync-plan.js',
  'js/sync-remote.js',
  'js/sync-ui.js',
  'js/ui.js',
  'js/views-store.js',
  'js/viewer.js',
  'js/wink-camera.js',
  'js/wink-logic.js',
  'js/zip.js',
  'icons/icon.svg',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

const LIB = [
  'vendor/pdfjs/pdf.min.mjs',
  'vendor/pdfjs/pdf.worker.min.mjs',
];

// Large wink-control files: fetched in the background at install so wink
// control works offline even if it was never switched on while online.
const LIB_OPTIONAL = [
  'vendor/mediapipe/vision_bundle.mjs',
  'vendor/mediapipe/wasm/vision_wasm_internal.js',
  'vendor/mediapipe/wasm/vision_wasm_internal.wasm',
  'vendor/models/face_landmarker.task',
];

async function cacheMissing(cacheName, urls) {
  const cache = await caches.open(cacheName);
  await Promise.all(urls.map(async (u) => {
    if (await cache.match(u)) return;
    const res = await fetch(u, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${u}: ${res.status}`);
    await cache.put(u, res);
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const core = await caches.open(CORE_CACHE);
    await core.addAll(CORE.map((u) => new Request(u, { cache: 'no-cache' })));
    await cacheMissing(LIB_CACHE, LIB);
    // Best effort; anything missed is cached the first time it's used.
    await cacheMissing(LIB_CACHE, LIB_OPTIONAL).catch(() => {});
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CORE_CACHE && key !== LIB_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
  else if (event.data === 'version' && event.source) event.source.postMessage({ version: VERSION });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Other pages (privacy.html) are their own documents, not the app.
  const appPage = url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
  if (req.mode === 'navigate' && appPage) {
    event.respondWith((async () => {
      const cached = await caches.match('index.html', { ignoreSearch: true });
      return cached || fetch(req);
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    const res = await fetch(req);
    // Cache library files (PDF.js fonts/cmaps, MediaPipe) as they're used.
    if (res.ok && url.pathname.includes('/vendor/')) {
      const copy = res.clone();
      caches.open(LIB_CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  })());
});
