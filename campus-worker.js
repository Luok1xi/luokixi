/* Campus-only public cache. Private plans are kept separately in IndexedDB. */
const scopeURL = new URL('./', self.location.href);
const scopePath = scopeURL.pathname;
const prefix = `luokixi-campus-${encodeURIComponent(scopePath)}-`;
const version = 'v1';
const names = { pages: `${prefix}${version}-pages`, assets: `${prefix}${version}-assets`, data: `${prefix}${version}-public-data` };
const pagePaths = new Set(['planner.html', 'map.html'].map((name) => new URL(name, scopeURL).pathname));
const dataPaths = new Set(['data/courses.json', 'data/campus-map/xueyuanlu.json', 'data/campus-map/shahe.json'].map((name) => new URL(name, scopeURL).pathname));
const assetPath = new URL('assets/', scopeURL).pathname;
const limits = { pages: 2, assets: 160, data: 3 };

function hashedAsset(url) {
  return url.origin === scopeURL.origin && !url.search && url.pathname.startsWith(assetPath)
    && /[-.][A-Za-z0-9_-]{6,}\.(?:js|mjs|css|woff2?|ttf|otf|svg|png|jpe?g|webp|avif|gif|ico)$/i.test(url.pathname)
    && !/%(?:2f|5c)/i.test(url.pathname);
}
function canonical(url) { return new Request(`${url.origin}${url.pathname}`, { method: 'GET' }); }
function cacheable(response, allow) {
  if (!response?.ok || !['basic', 'default'].includes(response.type)) return false;
  const cc = response.headers.get('Cache-Control') || '';
  if (/\b(?:private|no-store)\b/i.test(cc) || /(?:^|,)\s*(?:\*|cookie|authorization)\s*(?:,|$)/i.test(response.headers.get('Vary') || '')) return false;
  let final;
  try { final = new URL(response.url); } catch { return false; }
  return final.origin === scopeURL.origin && allow(final);
}
async function put(kind, url, response) {
  try {
    const cache = await caches.open(names[kind]);
    await cache.put(canonical(url), response.clone());
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - limits[kind]; i += 1) await cache.delete(keys[i]);
  } catch { /* Online responses remain usable if cache storage is full or unavailable. */ }
}
async function match(kind, url) {
  try { return await (await caches.open(names[kind])).match(canonical(url)); } catch { return undefined; }
}
function offlinePage() {
  return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>校园页面暂不可用</title><body><h1>这个校园页面还没有离线保存</h1><p>请联网访问一次，再离线查看。本机课程与日程仍保存在浏览器数据库中。</p></body></html>', { status: 503, headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' } });
}
async function navigation(request, url) {
  try {
    const response = await fetch(request);
    if (cacheable(response, (final) => pagePaths.has(final.pathname)) && /text\/html/i.test(response.headers.get('Content-Type') || '')) await put('pages', url, response);
    if (response.ok) return response;
    return await match('pages', url) || response;
  } catch { return await match('pages', url) || offlinePage(); }
}
async function campusClient(clientId) {
  if (!clientId) return false;
  const client = await self.clients.get(clientId);
  try { return pagePaths.has(new URL(client?.url).pathname); } catch { return false; }
}
async function publicResource(request, url, kind, clientId) {
  if (!await campusClient(clientId)) return fetch(request);
  if (kind === 'assets') {
    const cached = await match(kind, url);
    if (cached) return cached;
  }
  try {
    const response = await fetch(request);
    const allowed = kind === 'assets' ? hashedAsset : (final) => dataPaths.has(final.pathname) && !final.search;
    if (cacheable(response, allowed)) await put(kind, url, response);
    if (response.ok) return response;
    return await match(kind, url) || response;
  } catch {
    const cached = await match(kind, url);
    if (cached) return cached;
    if (kind === 'data') return new Response('{"error":"public_data_not_cached"}', { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    return Response.error();
  }
}

// Registration usually runs after initial assets loaded. Warm only currently
// visited campus documents and their declared hashed dependencies, so first
// serviceWorker.ready can support an offline revisit without caching other pages.
async function warmVisitedPages() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const pending = new Map();
  let visitedCampus = false;
  for (const client of clients) {
    const url = new URL(client.url);
    if (url.origin !== scopeURL.origin || !pagePaths.has(url.pathname)) continue;
    visitedCampus = true;
    try {
      const response = await fetch(canonical(url), { cache: 'no-cache', credentials: 'same-origin' });
      if (!cacheable(response, (final) => pagePaths.has(final.pathname)) || !/text\/html/i.test(response.headers.get('Content-Type') || '')) continue;
      await put('pages', url, response);
      const html = await response.text();
      for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
        const asset = new URL(match[1], url);
        if (hashedAsset(asset)) pending.set(asset.href, asset);
      }
    } catch { /* A later successful campus visit can populate the cache. */ }
  }
  // A first map load can finish before the worker controls its public JSON
  // requests. Warm this explicit public set; never read the user's IndexedDB
  // or infer which campus is stored in a private profile.
  if (visitedCampus) await Promise.all([...dataPaths].map(async (path) => {
    const url = new URL(path, scopeURL.origin);
    try {
      const response = await fetch(canonical(url), { cache: 'no-cache', credentials: 'same-origin' });
      if (cacheable(response, (final) => dataPaths.has(final.pathname) && !final.search)
          && /(?:application\/(?:[\w.+-]+\+)?json|text\/json)/i.test(response.headers.get('Content-Type') || '')) await put('data', url, response);
    } catch { /* Keep any last known public copy if this activation is offline. */ }
  }));
  // CSS and literal JS dependencies belong to the visited campus page, not
  // unrelated applications, account pages, API payloads or uploaded files.
  for (const asset of pending.values()) {
    try {
      const response = await fetch(asset.href, { cache: 'no-cache', credentials: 'same-origin' });
      if (!cacheable(response, hashedAsset)) continue;
      await put('assets', asset, response);
      if (asset.pathname.endsWith('.css')) {
        const css = await response.text();
        for (const match of css.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/gi)) {
          const dependency = new URL(match[1], asset);
          if (hashedAsset(dependency) && pending.size < limits.assets) pending.set(dependency.href, dependency);
        }
      } else if (/\.(?:js|mjs)$/.test(asset.pathname)) {
        const script = await response.text();
        // Only explicit literal module URLs in this campus dependency graph.
        // Code is never evaluated, and API requests or HTML routes are excluded.
        const references = [
          /\bimport\s*\(\s*(["'`])([^"'`]+)\1/g,
          /\b(?:import|export)\s*[^;"'`]*?\bfrom\s*(["'])([^"']+)\1/g,
          /\bimport\s*(["'])([^"']+)\1/g,
        ];
        for (const pattern of references) for (const match of script.matchAll(pattern)) {
          if (match[2].includes('${')) continue;
          const dependency = new URL(match[2], asset);
          if (hashedAsset(dependency) && pending.size < limits.assets) pending.set(dependency.href, dependency);
        }
      }
    } catch { /* Offline views report missing public resources instead of making data up. */ }
  }
}

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  const keep = new Set(Object.values(names));
  for (const name of await caches.keys()) if (name.startsWith(prefix) && !keep.has(name)) await caches.delete(name);
  await warmVisitedPages();
  await self.clients.claim();
})()));
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('Authorization')) return;
  const url = new URL(request.url);
  if (url.origin !== scopeURL.origin) return;
  if (request.mode === 'navigate') {
    if (pagePaths.has(url.pathname)) event.respondWith(navigation(request, url));
    return;
  }
  if (hashedAsset(url)) event.respondWith(publicResource(request, url, 'assets', event.clientId));
  else if (dataPaths.has(url.pathname) && !url.search) event.respondWith(publicResource(request, url, 'data', event.clientId));
});
