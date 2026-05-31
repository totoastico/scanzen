// ===================================================================
// scanner.js — détection des coins du document + redressement.
//
// On s'appuie sur jscanify, qui s'appuie lui-même sur OpenCV.js.
// Ces deux librairies sont lourdes : on ne les charge QU'UNE FOIS,
// et seulement au premier recadrage (pas au démarrage de l'app).
// ===================================================================

const OPENCV_URL = "https://docs.opencv.org/4.7.0/opencv.js";
const JSCANIFY_URL =
  "https://cdn.jsdelivr.net/gh/ColonelParrot/jscanify@master/src/jscanify.min.js";

// Éléments de l'écran de recadrage
const cropImage = document.getElementById("crop-image");
const overlay = document.getElementById("crop-overlay");
const loading = document.getElementById("crop-loading");

// Ordre des coins pour tracer le quadrilatère (sens horaire).
const CORNER_KEYS = [
  "topLeftCorner",
  "topRightCorner",
  "bottomRightCorner",
  "bottomLeftCorner",
];

let enginePromise = null; // promesse de chargement du moteur (1 seule fois)
let scanner = null; // instance jscanify
let corners = null; // coins courants, EN PIXELS DE L'IMAGE D'ORIGINE
let poly = null; // le polygone SVG
let handleEls = {}; // les poignées SVG, rangées par coin
let dragKey = null; // quel coin est en train d'être déplacé

const SVGNS = "http://www.w3.org/2000/svg";

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

// Charge OpenCV, attend que son moteur WASM soit prêt, puis charge
// jscanify et crée l'instance. Mémorisé pour ne le faire qu'une fois.
export function ensureEngineLoaded() {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    await loadScript(OPENCV_URL);
    // OpenCV se charge en deux temps : le script, puis le moteur WASM.
    await new Promise((resolve) => {
      const check = () => {
        if (window.cv && window.cv.Mat) resolve();
        else if (window.cv) window.cv.onRuntimeInitialized = resolve;
        else setTimeout(check, 30); // cv pas encore défini, on réessaie
      };
      check();
    });
    await loadScript(JSCANIFY_URL);
    scanner = new window.jscanify();
  })();
  return enginePromise;
}

// --- Détection des coins -------------------------------------------

function loadImage(imgEl, src) {
  return new Promise((resolve, reject) => {
    imgEl.onload = () => resolve();
    imgEl.onerror = () => reject(new Error("Image illisible"));
    imgEl.src = src;
  });
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Quadrilatère "par défaut" (marge de 8 %), au cas où la détection
// automatique échoue : l'utilisateur ajustera les coins à la main.
function defaultCorners(img) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const mx = w * 0.08;
  const my = h * 0.08;
  return {
    topLeftCorner: { x: mx, y: my },
    topRightCorner: { x: w - mx, y: my },
    bottomRightCorner: { x: w - mx, y: h - my },
    bottomLeftCorner: { x: mx, y: h - my },
  };
}

// Vérifie que les coins détectés sont plausibles (pas de NaN, aire
// suffisante). Sinon on retombe sur les coins par défaut.
function validCorners(c, img) {
  for (const k of CORNER_KEYS) {
    const p = c[k];
    if (!p || !isFinite(p.x) || !isFinite(p.y)) return false;
  }
  // Aire du quadrilatère (formule du lacet) sur l'ordre TL, TR, BR, BL.
  const pts = CORNER_KEYS.map((k) => c[k]);
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  area = Math.abs(area) / 2;
  return area > 0.15 * img.naturalWidth * img.naturalHeight;
}

function detectCorners(img) {
  try {
    const src = window.cv.imread(img);
    const contour = scanner.findPaperContour(src);
    let c = null;
    if (contour) {
      try {
        c = scanner.getCornerPoints(contour);
      } catch (e) {
        c = null;
      }
      if (contour.delete) contour.delete();
    }
    src.delete();
    return c && validCorners(c, img) ? c : defaultCorners(img);
  } catch (e) {
    console.warn("Détection auto impossible, coins par défaut.", e);
    return defaultCorners(img);
  }
}

// --- Affichage du quadrilatère et des poignées ---------------------

// Rapport entre la taille AFFICHÉE de l'image et sa taille RÉELLE.
function currentScale() {
  const rect = cropImage.getBoundingClientRect();
  return rect.width / cropImage.naturalWidth;
}

function buildOverlay() {
  overlay.innerHTML = "";

  poly = document.createElementNS(SVGNS, "polygon");
  poly.setAttribute("class", "crop__poly");
  overlay.appendChild(poly);

  handleEls = {};
  for (const key of CORNER_KEYS) {
    const dot = document.createElementNS(SVGNS, "circle"); // poignée visible
    dot.setAttribute("class", "crop__dot");
    dot.setAttribute("r", "10");

    const hit = document.createElementNS(SVGNS, "circle"); // zone tactile
    hit.setAttribute("class", "crop__hit");
    hit.setAttribute("r", "22");
    hit.dataset.corner = key;
    hit.addEventListener("pointerdown", onHandleDown);

    overlay.appendChild(dot);
    overlay.appendChild(hit);
    handleEls[key] = { dot, hit };
  }
}

// Place le polygone et les poignées d'après les coins courants.
function updatePositions() {
  if (!corners || !poly) return;
  const s = currentScale();
  const pts = CORNER_KEYS.map((k) => [corners[k].x * s, corners[k].y * s]);
  poly.setAttribute("points", pts.map((p) => p.join(",")).join(" "));
  CORNER_KEYS.forEach((k, i) => {
    const { dot, hit } = handleEls[k];
    dot.setAttribute("cx", pts[i][0]);
    dot.setAttribute("cy", pts[i][1]);
    hit.setAttribute("cx", pts[i][0]);
    hit.setAttribute("cy", pts[i][1]);
  });
}

function onHandleDown(e) {
  dragKey = e.currentTarget.dataset.corner;
  e.preventDefault();
}

function onHandleMove(e) {
  if (!dragKey) return;
  const rect = overlay.getBoundingClientRect();
  const s = currentScale();
  // Position du doigt → pixels de l'image d'origine, bornée à l'image.
  let x = (e.clientX - rect.left) / s;
  let y = (e.clientY - rect.top) / s;
  x = Math.max(0, Math.min(cropImage.naturalWidth, x));
  y = Math.max(0, Math.min(cropImage.naturalHeight, y));
  corners[dragKey] = { x, y };
  updatePositions();
}

function onHandleUp() {
  dragKey = null;
}

// Écouteurs "globaux" : le doigt est suivi même s'il sort de la
// poignée. Ajoutés une seule fois (au chargement du module).
window.addEventListener("pointermove", onHandleMove);
window.addEventListener("pointerup", onHandleUp);
window.addEventListener("resize", updatePositions);

// --- Fonctions utilisées par app.js --------------------------------

// Prépare l'écran de recadrage à partir de la photo capturée.
export async function initCrop(imageDataUrl) {
  loading.hidden = false;
  try {
    await ensureEngineLoaded();
    await loadImage(cropImage, imageDataUrl);
    corners = detectCorners(cropImage);
    buildOverlay();
    updatePositions();
  } catch (e) {
    console.error(e);
    loading.textContent = "Erreur : moteur de détection indisponible.";
    return;
  }
  loading.hidden = true;
}

// Redresse le document selon les coins courants et renvoie l'image
// à plat (data URL JPEG).
export function dewarp() {
  const c = corners;
  const w = Math.max(
    distance(c.topLeftCorner, c.topRightCorner),
    distance(c.bottomLeftCorner, c.bottomRightCorner)
  );
  const h = Math.max(
    distance(c.topLeftCorner, c.bottomLeftCorner),
    distance(c.topRightCorner, c.bottomRightCorner)
  );
  const outW = Math.max(1, Math.round(w));
  const outH = Math.max(1, Math.round(h));
  const resultCanvas = scanner.extractPaper(cropImage, outW, outH, c);
  return resultCanvas.toDataURL("image/jpeg", 0.92);
}
