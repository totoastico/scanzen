// ===================================================================
// scanner.js — détection des 4 COINS du document + redressement par
// correction de perspective (dewarp).
//
// On détecte automatiquement les 4 coins (jscanify/OpenCV), l'utilisateur
// peut les ajuster, puis on "déforme" l'image pour que le document
// devienne un rectangle bien droit (texte horizontal) — même si la photo
// a été prise de travers.
//
// ⚠️ cv.imread(<img>) lit l'image à sa taille AFFICHÉE. On dessine donc
// la photo sur un canvas à sa VRAIE résolution et on travaille dessus.
// ===================================================================

const OPENCV_URL = "https://docs.opencv.org/4.7.0/opencv.js";
const JSCANIFY_URL =
  "https://cdn.jsdelivr.net/gh/ColonelParrot/jscanify@master/src/jscanify.min.js";

const cropImage = document.getElementById("crop-image");
const overlay = document.getElementById("crop-overlay");
const loading = document.getElementById("crop-loading");

// Ordre des coins (sens horaire) pour le tracé du quadrilatère.
const CORNER_KEYS = [
  "topLeftCorner",
  "topRightCorner",
  "bottomRightCorner",
  "bottomLeftCorner",
];
const SVGNS = "http://www.w3.org/2000/svg";

let enginePromise = null;
let scanner = null;
let sourceCanvas = null; // photo à sa vraie résolution
let corners = null; // { topLeftCorner:{x,y}, ... } en pixels réels
let shade = null;
let poly = null;
let handleEls = {};
let dragKey = null;

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

// 4 coins par défaut (marge de 8 %), si la détection échoue.
function defaultCorners(src) {
  const mx = src.width * 0.08;
  const my = src.height * 0.08;
  return {
    topLeftCorner: { x: mx, y: my },
    topRightCorner: { x: src.width - mx, y: my },
    bottomRightCorner: { x: src.width - mx, y: src.height - my },
    bottomLeftCorner: { x: mx, y: src.height - my },
  };
}

function validCorners(c, src) {
  for (const k of CORNER_KEYS) {
    const p = c[k];
    if (!p || !isFinite(p.x) || !isFinite(p.y)) return false;
  }
  // aire suffisante (au moins 15 % de l'image) pour éviter une fausse détection
  const pts = CORNER_KEYS.map((k) => c[k]);
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2 > 0.15 * src.width * src.height;
}

// Ordonne 4 points quelconques en TL, TR, BR, BL.
function orderCorners(pts) {
  const bySum = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => a.y - a.x - (b.y - b.x));
  return {
    topLeftCorner: bySum[0], // plus petite somme x+y
    bottomRightCorner: bySum[3], // plus grande somme
    topRightCorner: byDiff[0], // plus petite différence y-x
    bottomLeftCorner: byDiff[3], // plus grande différence
  };
}

// Détecte le plus grand QUADRILATÈRE CONVEXE (= la feuille) parmi les
// contours. Bien plus fiable que "le plus grand contour" : on ignore le
// fond, les petites formes, et on n'accepte que des quadrilatères.
function detectQuad(src) {
  const cv = window.cv;
  let m, small, gray, edges, kernel, contours, hierarchy;
  try {
    m = cv.imread(src);
    // On travaille sur une version réduite (rapide + moins de bruit).
    const maxDim = 900;
    const scale = Math.min(1, maxDim / Math.max(m.cols, m.rows));
    small = new cv.Mat();
    cv.resize(m, small, new cv.Size(Math.max(1, Math.round(m.cols * scale)), Math.max(1, Math.round(m.rows * scale))), 0, 0, cv.INTER_AREA);
    gray = new cv.Mat();
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    edges = new cv.Mat();
    cv.Canny(gray, edges, 50, 150); // contours
    kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    cv.dilate(edges, edges, kernel); // relie les bords en pointillés
    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const imgArea = small.rows * small.cols;
    let bestPts = null;
    let bestArea = 0.2 * imgArea; // la feuille doit faire au moins 20 % de l'image
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true); // simplifie en polygone
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const area = cv.contourArea(approx);
        if (area > bestArea) {
          bestArea = area;
          bestPts = [];
          for (let j = 0; j < 4; j++) {
            bestPts.push({
              x: approx.data32S[j * 2] / scale, // re-mise à l'échelle réelle
              y: approx.data32S[j * 2 + 1] / scale,
            });
          }
        }
      }
      approx.delete();
      cnt.delete();
    }
    return bestPts ? orderCorners(bestPts) : null;
  } catch (e) {
    console.warn("Détection des coins échouée.", e);
    return null;
  } finally {
    [m, small, gray, edges, kernel, contours, hierarchy].forEach((x) => {
      try {
        if (x) x.delete();
      } catch (_) {}
    });
  }
}

function detectCorners(src) {
  const quad = detectQuad(src);
  return quad && validCorners(quad, src) ? quad : defaultCorners(src);
}

// --- Affichage du quadrilatère et des poignées ---------------------

function currentScale() {
  return cropImage.getBoundingClientRect().width / cropImage.naturalWidth;
}

function buildOverlay() {
  overlay.innerHTML = "";

  // Zone sombre autour du quadrilatère (règle pair-impair = "trou" sur le doc).
  shade = document.createElementNS(SVGNS, "path");
  shade.setAttribute("class", "crop__shade");
  shade.setAttribute("fill-rule", "evenodd");
  overlay.appendChild(shade);

  // Le quadrilatère.
  poly = document.createElementNS(SVGNS, "polygon");
  poly.setAttribute("class", "crop__poly");
  overlay.appendChild(poly);

  // Une poignée par coin.
  handleEls = {};
  for (const key of CORNER_KEYS) {
    const dot = document.createElementNS(SVGNS, "circle");
    dot.setAttribute("class", "crop__dot");
    dot.setAttribute("r", "10");
    const hit = document.createElementNS(SVGNS, "circle");
    hit.setAttribute("class", "crop__hit");
    hit.setAttribute("r", "24");
    hit.dataset.corner = key;
    hit.addEventListener("pointerdown", onHandleDown);
    overlay.appendChild(dot);
    overlay.appendChild(hit);
    handleEls[key] = { dot, hit };
  }
}

function updatePositions() {
  if (!corners || !poly) return;
  const s = currentScale();
  const W = cropImage.naturalWidth * s;
  const H = cropImage.naturalHeight * s;
  const pts = CORNER_KEYS.map((k) => [corners[k].x * s, corners[k].y * s]);

  poly.setAttribute("points", pts.map((p) => p.join(",")).join(" "));
  shade.setAttribute(
    "d",
    `M0,0 L${W},0 L${W},${H} L0,${H} Z ` +
      `M${pts[0][0]},${pts[0][1]} L${pts[1][0]},${pts[1][1]} ` +
      `L${pts[2][0]},${pts[2][1]} L${pts[3][0]},${pts[3][1]} Z`
  );
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
  const r = overlay.getBoundingClientRect();
  const s = currentScale();
  let x = (e.clientX - r.left) / s;
  let y = (e.clientY - r.top) / s;
  x = Math.max(0, Math.min(cropImage.naturalWidth, x));
  y = Math.max(0, Math.min(cropImage.naturalHeight, y));
  corners[dragKey] = { x, y };
  updatePositions();
}

function onHandleUp() {
  dragKey = null;
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

    sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = cropImage.naturalWidth;
    sourceCanvas.height = cropImage.naturalHeight;
    sourceCanvas
      .getContext("2d")
      .drawImage(cropImage, 0, 0, sourceCanvas.width, sourceCanvas.height);

    corners = detectCorners(sourceCanvas);
    buildOverlay();
    updatePositions();
  } catch (e) {
    console.error(e);
    loading.textContent = "Erreur : moteur de détection indisponible.";
    return;
  }
  loading.hidden = true;
}

// Redresse le document (correction de perspective) selon les 4 coins
// et renvoie un CANVAS bien droit, plein résolution.
export function cropToCanvas() {
  const c = corners;
  const w = Math.max(
    1,
    Math.round(
      Math.max(
        distance(c.topLeftCorner, c.topRightCorner),
        distance(c.bottomLeftCorner, c.bottomRightCorner)
      )
    )
  );
  const h = Math.max(
    1,
    Math.round(
      Math.max(
        distance(c.topLeftCorner, c.bottomLeftCorner),
        distance(c.topRightCorner, c.bottomRightCorner)
      )
    )
  );
  // extractPaper applique la transformation de perspective et renvoie un canvas.
  return scanner.extractPaper(sourceCanvas, w, h, c);
}
