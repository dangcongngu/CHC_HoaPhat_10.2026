/* Service worker: lưu sẵn giao diện để mở nhanh và vẫn mở được khi mạng yếu. Dữ liệu bệnh nhân KHÔNG được cache. */
const CACHE = 'luom-lua-checkout-v6';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET') return;
  const sameOrigin = url.origin === self.location.origin;
  const libCdn = url.hostname === 'cdn.jsdelivr.net';
  if (!sameOrigin && !libCdn) return;                       // gọi Supabase: luôn đi thẳng ra mạng
  // Ưu tiên bản mới từ mạng, mất mạng thì dùng bản đã lưu.
  e.respondWith(fetch(req).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then((hit) => hit || caches.match('index.html'))));
});
