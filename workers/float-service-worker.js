import { installReiSW } from "@rei-standard/amsg-sw";

const CACHE_VERSION = "ai-phone-pwa-v5";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const INBOX_DB = "float-cloud-message-inbox-v1";
const INBOX_STORE = "messages";

const PRECACHE_URLS = ["/", "/manifest.json", "/icon-192.png", "/icon-512.png"];

function openInbox() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(INBOX_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(INBOX_STORE)) {
        db.createObjectStore(INBOX_STORE, { keyPath: "messageId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开离线消息库"));
  });
}

async function persistIncomingPayload(payload) {
  if (!payload || payload.messageKind !== "content") return;
  const messageId = String(payload.messageId || payload.id || "").trim();
  if (!messageId) throw new Error("推送缺少 messageId");
  const db = await openInbox();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(INBOX_STORE, "readwrite");
    tx.objectStore(INBOX_STORE).put({ messageId, payload, receivedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("离线消息写入失败"));
    tx.onabort = () => reject(tx.error || new Error("离线消息写入已中止"));
  });
  db.close();
}

installReiSW(self, {
  defaultIcon: "/icon-192.png",
  defaultBadge: "/icon-192.png",
  defaultTitle: "Float",
  defaultBody: "你收到一条新消息",
  multipart: { enabled: true },
  onBusinessPayload: persistIncomingPayload,
});

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => !key.startsWith(CACHE_VERSION)).map((key) => caches.delete(key))))
      .then(() => caches.open(STATIC_CACHE))
      .then((cache) => cache.add(new Request("/", { cache: "reload" })).catch(() => {}))
      .then(() => self.clients.claim())
  );
});

function isCacheableRequest(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return false;
  if (url.pathname.startsWith("/_next/static/")) return true;
  return ["font", "image", "script", "style", "worker"].includes(request.destination);
}

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    const fallback = await caches.match("/");
    if (fallback) return fallback;
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("navigate" in client) client.navigate(targetUrl);
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
  } else if (isCacheableRequest(request)) {
    event.respondWith(cacheFirst(request));
  }
});
