/* AXIA AI Office — 最小のService Worker
   ・インストール（ホーム画面追加）を成立させるのが目的
   ・HTMLは常にネット優先（古い画面が残らんように）。落ちたときだけキャッシュ */
const CACHE = 'axia-office-v1';
const SHELL = ['./AXIA_AI_Office.html', './office.webmanifest', './office-icon-192.png', './office-icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;   // Supabase等はそのまま
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
