import { installReiSW } from "@rei-standard/amsg-sw";

const CACHE_VERSION = "ai-phone-pwa-v13-custom";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const INBOX_DB = "float-cloud-message-inbox-v1";
const INBOX_STORE = "messages";
const PRECACHE_URLS = ["/", "/manifest.json", "/icon-192.png", "/icon-512.png"];

function readPushJson(event) {
  if (!event.data) return null;
  try { return event.data.json(); } catch { return null; }
}

function isReiPushPayload(payload) {
  return Boolean(payload && typeof payload === "object" && typeof payload.messageKind === "string");
}

function openInbox() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(INBOX_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(INBOX_STORE)) db.createObjectStore(INBOX_STORE, { keyPath: "messageId" });
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

// Both push systems share the same PWA scope. Forward only Rei envelopes to
// rei-standard so upstream personal-push payloads are not rendered twice.
const reiScope = {
  clients: self.clients,
  registration: self.registration,
  addEventListener(type, listener, options) {
    if (type === "push") {
      self.addEventListener("push", (event) => {
        if (isReiPushPayload(readPushJson(event))) listener.call(self, event);
      }, options);
      return;
    }
    self.addEventListener(type, listener, options);
  },
};

installReiSW(reiScope, {
  defaultIcon: "/icon-192.png",
  defaultBadge: "/icon-192.png",
  defaultTitle: "Float",
  defaultBody: "你收到一条新消息",
  multipart: { enabled: true },
  onBusinessPayload: persistIncomingPayload,
});

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting()));
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

// Upstream personal-push / reality-bridge notifications. Rei payloads are
// handled above and ignored here to prevent duplicate notifications.
self.addEventListener("push", (event) => {
  let data = readPushJson(event);
  if (isReiPushPayload(data)) return;
  if (!data) {
    try { data = { body: event.data ? event.data.text() : "" }; } catch { data = {}; }
  }
  const declarative = data.web_push === 8030 && data.notification && typeof data.notification === "object" ? data.notification : null;
  const notificationData = declarative && declarative.data && typeof declarative.data === "object" ? declarative.data : data;
  const title = (declarative && declarative.title) || data.title || "小手机";
  event.waitUntil((async () => {
    if (notificationData.type === "chat_outbox") {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const visible = windows.filter((client) => client.visibilityState === "visible");
      if (visible.length > 0) {
        visible.forEach((client) => client.postMessage({ type: "push_outbox_ready" }));
        return;
      }
    }
    if (notificationData.type === "incoming_call") {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const visible = windows.filter((client) => client.visibilityState === "visible");
      if (visible.length > 0) {
        visible.forEach((client) => client.postMessage({ type: "incoming_call_push", sessionId: notificationData.sessionId || "", callTs: notificationData.callTs || 0 }));
        visible.forEach((client) => client.postMessage({ type: "push_outbox_ready" }));
        return;
      }
    }
    await self.registration.showNotification(title, {
      body: (declarative && declarative.body) || data.body || "",
      icon: (declarative && declarative.icon) || data.icon || "/icon-192.png",
      badge: (declarative && declarative.badge) || "/icon-192.png",
      tag: (declarative && declarative.tag) || data.tag || `push-${Date.now()}`,
      data: {
        url: (declarative && declarative.navigate) || notificationData.url || "/",
        type: notificationData.type || "",
        commandId: notificationData.commandId || "",
        sessionId: notificationData.sessionId || "",
        callTs: notificationData.callTs || 0,
      },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const notificationData = event.notification.data || {};
  const targetUrl = notificationData.url || "/";
  if (notificationData.type === "shortcut_command") {
    event.waitUntil((async () => {
      const absoluteUrl = new URL(targetUrl, self.location.origin).href;
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if ("focus" in client) {
          client.postMessage({ type: "run_shortcut", url: absoluteUrl });
          return client.focus();
        }
      }
      return self.clients.openWindow(absoluteUrl);
    })());
    return;
  }
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if ("focus" in client) {
        if (notificationData.type === "chat_outbox") client.postMessage({ type: "push_outbox_ready" });
        if (notificationData.type === "incoming_call") {
          client.postMessage({ type: "incoming_call_push", sessionId: notificationData.sessionId || "", callTs: notificationData.callTs || 0 });
          client.postMessage({ type: "push_outbox_ready" });
        }
        return client.focus();
      }
    }
    return self.clients.openWindow(targetUrl);
  }));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.mode === "navigate") event.respondWith(networkFirst(request));
  else if (isCacheableRequest(request)) event.respondWith(cacheFirst(request));
});
