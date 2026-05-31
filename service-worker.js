// ===================================================================
// service-worker.js — rend Scanzen installable et utilisable hors-ligne.
//
// Stratégie "réseau d'abord" : on tente toujours le réseau (donc tu as
// la version à jour), et on bascule sur le cache uniquement si tu es
// hors-ligne. Ça évite de rester bloqué sur une ancienne version.
// ===================================================================

const CACHE = "scanzen-v1";

// Les fichiers de l'app (mis en cache dès l'installation).
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
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
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
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // On garde une copie en cache (utile hors-ligne, y compris OpenCV).
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
