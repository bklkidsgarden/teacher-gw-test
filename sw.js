/* 外殼頁的 service worker：只存外殼頁自己這幾個公開的檔案，斷網時也打得開。
 * 系統的回應（頁面、照片、下載檔）一律不存：那些走加密通道、送往 script.google.com，這裡完全不碰，
 * 不在手機上留下任何資料（PWA施作規劃書 §3）。
 * build.py 產生 sw.js 時填入 VERSION（這次產生的檔案內容的雜湊）：外殼頁一改，sw.js 跟著變，手機才會換新版。
 */
const VERSION = '559601aec176';
const FILES = ["./", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"];
const SCOPE = new URL('./', self.location).href;
// 同一個網域底下可能有好幾個 App（同仁的智慧校園、家長的聯絡簿），快取是整個網域共用的：
// 名字帶上自己的路徑，換版時只清自己的舊版，不會把別的 App 的外殼刪掉
const MINE = 'shell:' + new URL(SCOPE).pathname + ':';
const CACHE = MINE + VERSION;
const OWN = new Set(FILES.map((f) => new URL(f, SCOPE).href));
// 開頁時先問網路：有網路一定拿最新版。等這麼久還沒回應（或斷網），才拿存好的那份。
const NAV_WAIT_MS = 4000;

self.addEventListener('install', (e) => {
  // cache: 'reload'＝跳過瀏覽器自己的快取（GitHub Pages 預設給 10 分鐘），存進來的一定是這一版
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    // 'shell-' 開頭的是改名前的舊版（只會有同仁版的），一起清掉
    .then((keys) => Promise.all(keys.filter((k) => (k.startsWith(MINE) && k !== CACHE) || k.startsWith('shell-'))
      .map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;   // 送往 Google 的加密請求：不碰
  if (req.mode === 'navigate') { e.respondWith(openPage(e)); return; }
  if (!OWN.has(req.url)) return;
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});

/** 開頁：外殼頁只有一個 index.html，不管網址後面帶什麼（例如 LINE 的 ?openExternalBrowser=1）都是同一份，存在 ./ 底下。 */
async function openPage(e) {
  // 只把「自己這一頁」存起來：同一個網域底下的另一個 App（例如家長版聯絡簿）不能被存成這個 App 的外殼
  const mine = new URL(e.request.url).pathname === new URL(SCOPE).pathname;
  const net = fetch(e.request, { cache: 'no-cache' }).then((r) => {
    if (mine && r.ok && !r.redirected) {
      const copy = r.clone();
      e.waitUntil(caches.open(CACHE).then((c) => c.put(SCOPE, copy)));
    }
    return r;
  });
  net.catch(() => { /* 斷網：下面用存好的 */ });
  let r = null;
  try {
    r = await Promise.race([net, new Promise((resolve) => setTimeout(resolve, NAV_WAIT_MS, null))]);
  } catch (err) { /* 斷網 */ }
  if (r) return r;
  return (mine && (await caches.match(SCOPE))) || net;
}

// ── 推播（PWA施作規劃書 P4）：帳號中心從主機送來的通知。內容只有標題、一句話、要打開的頁面（#p= 後面那段）。
// iPhone 規定每一則推播都要真的顯示出來，所以一律 showNotification，不做背景偷偷更新。
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '智慧校園系統', {
    body: d.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { path: typeof d.path === 'string' && d.path.startsWith('/') ? d.path : '' },
  }));
});

// 點通知：已經開著就切過去、換到那一頁；沒開就開一個新的。
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const path = (e.notification.data && e.notification.data.path) || '';
  const url = SCOPE + (path ? '#p=' + encodeURIComponent(path) : '');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.startsWith(SCOPE));
    if (open) return open.focus().then((c) => (c && path ? c.navigate(url) : c)).catch(() => self.clients.openWindow(url));
    return self.clients.openWindow(url);
  }));
});
