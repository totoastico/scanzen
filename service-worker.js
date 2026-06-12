// ===================================================================
// service-worker.js — rend Scanzen installable et utilisable hors-ligne.
//
// Stratégie "réseau d'abord, sans cache HTTP" pour nos fichiers : on
// va toujours chercher la version FRAÎCHE sur le serveur, et on ne
// bascule sur le cache que si tu es hors-ligne.
// ===================================================================

const CACHE = "scanzen-v17";

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

  // --- Bibliothèques tierces (OpenCV, Tesseract, jsPDF, pdf.js + leurs
  //     fichiers wasm/données) : leur URL contient une VERSION FIGÉE, donc
  //     leur contenu ne change jamais. On les sert d'abord depuis le CACHE
  //     (instantané, marche hors-ligne) et on ne télécharge que si absent.
  //     C'est le gros gain de vitesse aux ouvertures suivantes. ---
  if (!sameOrigin) {
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          return response;
        });
      })
    );
    return;
  }

  // --- Notre propre code (même origine) : réseau D'ABORD, sans cache HTTP,
  //     pour toujours avoir la version fraîche ; cache en secours hors-ligne. ---
  event.respondWith(
    fetch(new Request(req.url, { cache: "no-store" }))
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(req))
  );
});
