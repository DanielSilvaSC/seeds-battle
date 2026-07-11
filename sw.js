/* Seeds Battle — service worker (PWA)
   Estratégia:
   - Firebase (dados/auth): sempre rede, nunca cache.
   - Navegação (index.html): rede primeiro (pega atualizações), cache como fallback offline.
   - Demais estáticos (fontes, CDN, ícone): cache primeiro.
   Ao publicar uma mudança grande, aumente a versão do CACHE para forçar atualização. */
const CACHE = 'seeds-battle-v1';
const SHELL = ['./', './index.html', './manifest.json', './icon.svg'];

/* hosts que NUNCA devem ser cacheados (dados ao vivo e autenticação) */
const LIVE_HOSTS = ['firebaseio.com', 'identitytoolkit.googleapis.com', 'securetoken.googleapis.com', 'firebasestorage.app'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (LIVE_HOSTS.some(h => url.hostname.endsWith(h) || url.hostname.includes(h))) return;

  /* navegação: rede primeiro, cache offline como fallback */
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put('./index.html', cp)); return r; })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  /* estáticos: cache primeiro, rede e guarda */
  e.respondWith(
    caches.match(e.request).then(hit =>
      hit || fetch(e.request).then(r => {
        if (r.ok) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); }
        return r;
      })
    )
  );
});
