// ===================================================================
// service-worker.js — rend Scanzen installable et utilisable hors-ligne.
//
// Stratégie "réseau d'abord, sans cache HTTP" pour nos fichiers : on
// va toujours chercher la version FRAÎCHE sur le serveur, et on ne
// bascule sur le cache que si tu es hors-ligne.
// ===================================================================

const CACHE = "scanzen-v11";

const SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./js/camera.js",
  "./js/scanner.js",
  "./js/filters.js",
  "./js/pages.js",
  "./js/pdf.js",
  "./js/ocr.js",
  "./js/contract.js",
  "./js/pdfimport.js",
  "./js/livescan.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/panda.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const sameOrigin = new URL(req.url).origin === self.location.origin;
  const fetcher = sameOrigin
    ? fetch(new Request(req.url, { cache: "no-store" }))
    : fetch(req);

  event.respondWith(
    fetcher
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(req))
  );
});
