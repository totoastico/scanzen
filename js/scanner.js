// ===================================================================
// scanner.js — recadrage RECTANGULAIRE du document.
//
// On détecte automatiquement le document (jscanify/OpenCV) pour placer
// un rectangle de départ, puis l'utilisateur ajuste les 4 CÔTÉS
// (haut / bas / gauche / droite). Le recadrage est un simple découpage
// 1:1 (donc net, sans rééchantillonnage). Pas de correction de
// perspective : adapté aux documents photographiés bien à plat.
//
// ⚠️ cv.imread(<img>) lit l'image à sa taille AFFICHÉE, pas à sa
// résolution réelle. On dessine donc la photo sur un canvas à sa vraie
// résolution et on travaille dessus.
// ===================================================================

const OPENCV_URL = "https://docs.opencv.org/4.7.0/opencv.js";
const JSCANIFY_URL =
  "https://cdn.jsdelivr.net/gh/ColonelParrot/jscanify@master/src/jscanify.min.js";

const cropImage = document.getElementById("crop-image");
const overlay = document.getElementById("crop-overlay");
const loading = document.getElementById("crop-loading");

const EDGES = ["top", "bottom", "left", "right"];
const MIN_SIZE = 40; // taille mini du rectangle, en pixels réels
const SVGNS = "http://www.w3.org/2000/svg";

let enginePromise = null;
let scanner = null;
let sourceCanvas = null; // la photo à sa VRAIE résolution
let rect = null; // { left, top, right, bottom } en pixels réels
let cropRect = null; // le rectangle SVG
let shades = {}; // les 4 zones sombres autour du rectangle
let handleEls = {}; // les poignées de bord
let dragEdge = null;

// --- Chargement des librairies -------------------------------------

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Échec du chargement : " + src));
    document.head.appendChild(s);
  });
}

export function ensureEngineLoaded() {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    await loadScript(OPENCV_URL);
    await new Promise((resolve) => {
      const check = () => {
        if (window.cv && window.cv.Mat) resolve();
        else if (window.cv) window.cv.onRuntimeInitialized = resolve;
        else setTimeout(check, 30);
      };
      check();
    });
    await loadScript(JSCANIFY_URL);
    scanner = new window.jscanify();
  })();
  return enginePromise;
}

// --- Détection du rectangle de départ ------------------------------

function loadImage(imgEl, src) {
  return new Promise((resolve, reject) => {
    imgEl.onload = () => resolve();
    imgEl.onerror = () => reject(new Error("Image illisible"));
    imgEl.src = src;
  });
}

// Rectangle par défaut : marge de 6 % (si la détection échoue).
function defaultRect(src) {
  const mx = src.width * 0.06;
  const my = src.height * 0.06;
  return { left: mx, top: my, right: src.width - mx, bottom: src.height - my };
}

// Détecte le document et renvoie sa "boîte englobante" (rectangle droit).
function detectRect(src) {
  try {
    const mat = window.cv.imread(src);
    const contour = scanner.findPaperContour(mat);
    let r = null;
    if (contour) {
      let c = null;
      try {
        c = scanner.getCornerPoints(contour);
      } catch (e) {
        c = null;
      }
      if (contour.delete) contour.delete();
      if (c) {
        const xs = [
          c.topLeftCorner, c.topRightCorner, c.bottomLeftCorner, c.bottomRightCorner,
        ].filter(Boolean).map((p) => p.x);
        const ys = [
          c.topLeftCorner, c.topRightCorner, c.bottomLeftCorner, c.bottomRightCorner,
        ].filter(Boolean).map((p) => p.y);
        if (xs.length === 4 && ys.every(isFinite) && xs.every(isFinite)) {
          const left = Math.max(0, Math.min(...xs));
          const top = Math.max(0, Math.min(...ys));
          const right = Math.min(src.width, Math.max(...xs));
          const bottom = Math.min(src.height, Math.max(...ys));
          // garde-fou : le rectangle doit être assez grand pour être crédible
          if (right - left > src.width * 0.2 && bottom - top > src.height * 0.2) {
            r = { left, top, right, bottom };
          }
        }
      }
    }
    mat.delete();
    return r || defaultRect(src);
  } catch (e) {
    console.warn("Détection auto impossible, rectangle par défaut.", e);
    return defaultRect(src);
  }
}

// --- Affichage du rectangle et des poignées ------------------------

function currentScale() {
  const r = cropImage.getBoundingClientRect();
  return r.width / cropImage.naturalWidth;
}

function mkEl(tag, cls) {
  const el = document.createElementNS(SVGNS, tag);
  el.setAttribute("class", cls);
  return el;
}

function buildOverlay() {
  overlay.innerHTML = "";

  // Zones sombres autour du rectangle (pour bien voir la découpe).
  shades = {};
  for (const k of ["top", "bottom", "left", "right"]) {
    shades[k] = mkEl("rect", "crop__shade");
    overlay.appendChild(shades[k]);
  }

  // Le rectangle de découpe.
  cropRect = mkEl("rect", "crop__rect");
  overlay.appendChild(cropRect);

  // Une poignée au milieu de chaque côté.
  handleEls = {};
  for (const edge of EDGES) {
    const dot = mkEl("circle", "crop__dot");
    dot.setAttribute("r", "9");
    const hit = mkEl("circle", "crop__hit");
    hit.setAttribute("r", "24");
    hit.dataset.edge = edge;
    hit.addEventListener("pointerdown", onHandleDown);
    overlay.appendChild(dot);
    overlay.appendChild(hit);
    handleEls[edge] = { dot, hit };
  }
}

function setRectAttr(el, x, y, w, h) {
  el.setAttribute("x", x);
  el.setAttribute("y", y);
  el.setAttribute("width", Math.max(0, w));
  el.setAttribute("height", Math.max(0, h));
}

function updatePositions() {
  if (!rect || !cropRect) return;
  const s = currentScale();
  const L = rect.left * s, T = rect.top * s, R = rect.right * s, B = rect.bottom * s;
  const W = cropImage.naturalWidth * s, H = cropImage.naturalHeight * s;

  setRectAttr(cropRect, L, T, R - L, B - T);
  setRectAttr(shades.top, 0, 0, W, T);
  setRectAttr(shades.bottom, 0, B, W, H - B);
  setRectAttr(shades.left, 0, T, L, B - T);
  setRectAttr(shades.right, R, T, W - R, B - T);

  const place = (edge, x, y) => {
    const { dot, hit } = handleEls[edge];
    dot.setAttribute("cx", x); dot.setAttribute("cy", y);
    hit.setAttribute("cx", x); hit.setAttribute("cy", y);
  };
  place("top", (L + R) / 2, T);
  place("bottom", (L + R) / 2, B);
  place("left", L, (T + B) / 2);
  place("right", R, (T + B) / 2);
}

function onHandleDown(e) {
  dragEdge = e.currentTarget.dataset.edge;
  e.preventDefault();
}

function onHandleMove(e) {
  if (!dragEdge) return;
  const r = overlay.getBoundingClientRect();
  const s = currentScale();
  const x = (e.clientX - r.left) / s; // pixels réels
  const y = (e.clientY - r.top) / s;
  const W = cropImage.naturalWidth, H = cropImage.naturalHeight;

  if (dragEdge === "top") rect.top = Math.max(0, Math.min(y, rect.bottom - MIN_SIZE));
  else if (dragEdge === "bottom") rect.bottom = Math.min(H, Math.max(y, rect.top + MIN_SIZE));
  else if (dragEdge === "left") rect.left = Math.max(0, Math.min(x, rect.right - MIN_SIZE));
  else if (dragEdge === "right") rect.right = Math.min(W, Math.max(x, rect.left + MIN_SIZE));

  updatePositions();
}

function onHandleUp() {
  dragEdge = null;
}

window.addEventListener("pointermove", onHandleMove);
window.addEventListener("pointerup", onHandleUp);
window.addEventListener("resize", updatePositions);

// --- Fonctions utilisées par app.js --------------------------------

export async function initCrop(imageDataUrl) {
  loading.hidden = false;
  try {
    await ensureEngineLoaded();
    await loadImage(cropImage, imageDataUrl);

    // Photo à sa VRAIE résolution (voir l'avertissement en tête de fichier).
    sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = cropImage.naturalWidth;
    sourceCanvas.height = cropImage.naturalHeight;
    sourceCanvas
      .getContext("2d")
      .drawImage(cropImage, 0, 0, sourceCanvas.width, sourceCanvas.height);

    rect = detectRect(sourceCanvas);
    buildOverlay();
    updatePositions();
  } catch (e) {
    console.error(e);
    loading.textContent = "Erreur : moteur de détection indisponible.";
    return;
  }
  loading.hidden = true;
}

// Découpe le rectangle choisi et renvoie un CANVAS plein résolution
// (pas de JPEG ici : on garde la qualité maximale pour le filtre).
export function cropToCanvas() {
  const left = Math.round(rect.left);
  const top = Math.round(rect.top);
  const w = Math.max(1, Math.round(rect.right - rect.left));
  const h = Math.max(1, Math.round(rect.bottom - rect.top));

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  // Découpage 1:1 depuis la photo pleine résolution → net.
  out.getContext("2d").drawImage(sourceCanvas, left, top, w, h, 0, 0, w, h);
  return out;
}
