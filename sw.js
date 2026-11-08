// Offline service worker: precaches the whole app (shell, engine wasm, encrypted data.bin); cache-first.
// mobile/build.py fills in VERSION (hash of every file) and PRECACHE (every file in dist/).
const VERSION = '4e8f31902a528b4a';
const PRECACHE = [
"./",
"apple-touch-icon.png",
"css/mobile.css",
"data.bin",
"data.meta.json",
"icon-180.png",
"icon-192.png",
"icon-512.png",
"index.html",
"js/boot.js",
"js/coach-stub.js",
"js/data.js",
"js/idb.js",
"js/impl-real.js",
"js/impl.js",
"js/inflate.js",
"js/localapi.js",
"js/sync.js",
"js/unlock.js",
"manifest.webmanifest",
"pieces/bB.svg",
"pieces/bK.svg",
"pieces/bN.svg",
"pieces/bP.svg",
"pieces/bQ.svg",
"pieces/bR.svg",
"pieces/wB.svg",
"pieces/wK.svg",
"pieces/wN.svg",
"pieces/wP.svg",
"pieces/wQ.svg",
"pieces/wR.svg",
"src/coach/analyze.js",
"src/coach/board.js",
"src/coach/coach.js",
"src/coach/index.js",
"src/coach/options.js",
"src/coach/position.js",
"src/coach/pyset.js",
"src/coach/strategy.js",
"src/coach/util.js",
"src/engine.js",
"static/analysis.js",
"static/app.js",
"static/board.js",
"static/insight.js",
"static/play.js",
"static/sound.js",
"static/style.css",
"static/ui.js",
"vendor/chess.js/SOURCE.md",
"vendor/chess.js/chess.js",
"vendor/stockfish/SOURCE.md",
"vendor/stockfish/package.json",
"vendor/stockfish/stockfish-19-lite-single.js",
"vendor/stockfish/stockfish-19-lite-single.wasm",
"build.json"
];
const CACHE = `chess-coach-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('chess-coach-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => { if (event.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // chess.com sync goes straight to the network
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req.mode === 'navigate' ? new URL('./', self.registration.scope).href : req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (e) {
      if (req.mode === 'navigate') {
        const shell = await cache.match('index.html');
        if (shell) return shell;
      }
      throw e;
    }
  })());
});
