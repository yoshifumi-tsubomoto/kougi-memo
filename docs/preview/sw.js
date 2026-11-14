// 講義メモ：アプリ一式をブラウザにしまっておき、ネットがなくても開けるようにする。
// 新しい版が届いても、利用者が「更新する」を押すまでは切り替えない。
const VERSION = '0.6.0';
const CACHE = 'kougi-memo-' + VERSION;
const FONT_CACHE = 'kougi-memo-fonts';
const FILES = ['./', 'index.html', 'style.css', 'js/app.js', 'js/store.js', 'js/media.js', 'js/link.js', 'js/phone.js', 'phone.html', 'bench.html', 'js/bench.js', 'vendor/peerjs.min.js', 'vendor/qrcode.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== FONT_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // 試験版（preview/）にはさわらない。いつも最新のファイルを取りに行かせる
    if (url.pathname.startsWith(new URL('preview/', self.registration.scope).pathname)) return;
    // アプリ本体：しまってあるものを使う（更新は新しい版のインストールで行う）
    e.respondWith((async () => {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try { return await fetch(req); }
      catch (err) {
        if (req.mode === 'navigate') { const top = await caches.match('./'); if (top) return top; }   // ネットがないときは本体を開く
        throw err;
      }
    })());
  } else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONT_CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
  }
});
