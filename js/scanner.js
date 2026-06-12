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
  })().catch((e) => {
    enginePromise = null; // échec (ex. hors-ligne) → un prochain essai repartira de zéro
    throw e;
  });
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

// "Rectangularité" d'un quadrilatère : 1 = angles droits, 0 = très
// biscornu. Une vraie feuille vue en perspective garde des angles
// proches de 90° ; une feuille fusionnée avec son ombre, non.
function rectangularityScore(pts) {
  let worst = 1;
  for (let i = 0; i < 4; i++) {
    const a = pts[(i + 3) % 4];
    const b = pts[i];
    const c = pts[(i + 1) % 4];
    const v1x = a.x - b.x, v1y = a.y - b.y;
    const v2x = c.x - b.x, v2y = c.y - b.y;
    const cos =
      Math.abs(v1x * v2x + v1y * v2y) /
      ((Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y)) || 1);
    worst = Math.min(worst, 1 - cos);
  }
  return worst;
}

// Détecte le plus grand QUADRILATÈRE CONVEXE (= la feuille) parmi les
// contours. Bien plus fiable que "le plus grand contour" : on ignore le
// fond, les petites formes, et on n'accepte que des quadrilatères
// d'allure rectangulaire (score ci-dessus).
// `pass` règle la sensibilité : Canny (bords) ou Otsu (feuille claire
// sur fond uni, quand les bords sont trop doux pour Canny).
function detectQuad(src, pass) {
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
    if (pass.otsu) {
      cv.threshold(gray, edges, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
    } else {
      cv.Canny(gray, edges, pass.cannyLo, pass.cannyHi);
    }
    kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    cv.dilate(edges, edges, kernel); // relie les bords en pointillés
    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const imgArea = small.rows * small.cols;
    const minArea = pass.minAreaPct * imgArea; // taille minimale de la feuille
    // Un quad qui couvre TOUTE l'image n'est pas un document : c'est le
    // bord du cadre lui-même (ex. fond uni → seuillage plein écran).
    const maxArea = 0.96 * imgArea;
    let bestPts = null;
    let bestScore = 0;
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const peri = cv.arcLength(cnt, true);
      let approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true); // simplifie en polygone
      if (approx.rows > 4) {
        // coins arrondis ? on retente en simplifiant un peu plus fort
        approx.delete();
        approx = new cv.Mat();
        cv.approxPolyDP(cnt, approx, 0.04 * peri, true);
      }
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const area = cv.contourArea(approx);
        if (area > minArea && area < maxArea) {
          const pts = [];
          for (let j = 0; j < 4; j++) {
            pts.push({
              x: approx.data32S[j * 2] / scale, // re-mise à l'échelle réelle
              y: approx.data32S[j * 2 + 1] / scale,
            });
          }
          const rect = rectangularityScore(pts);
          const score = area * rect; // grand ET d'allure rectangulaire
          if (rect >= 0.3 && score > bestScore) {
            bestScore = score;
            bestPts = pts;
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

// Tentatives de la plus stricte à la plus permissive. La plupart des
// photos s'arrêtent à la 1re (le coût reste donc inchangé). La dernière
// accepte un document ÉLOIGNÉ (photo prise de loin : la feuille ne
// couvre qu'une petite partie de l'image).
const DETECT_PASSES = [
  { cannyLo: 50, cannyHi: 150, minAreaPct: 0.2 },   // standard
  { cannyLo: 25, cannyHi: 80, minAreaPct: 0.15 },   // bords peu contrastés
  { otsu: true, minAreaPct: 0.15 },                 // feuille claire sur fond uni
  { cannyLo: 50, cannyHi: 150, minAreaPct: 0.06 },  // document loin dans le cadre
];

// Détection "stricte" : renvoie le quadrilatère du document, ou null si
// rien de fiable n'est trouvé. (Utilisée aussi par la visée en direct.)
// maxPasses : la visée en direct se limite aux passes rapides (Canny),
// sinon chaque image "ratée" coûterait les 3 passes toutes les 180 ms.
export function detectDocument(src, maxPasses = DETECT_PASSES.length) {
  for (const pass of DETECT_PASSES.slice(0, maxPasses)) {
    const quad = detectQuad(src, pass);
    if (quad && validCorners(quad, src)) return quad;
  }
  return null;
}

function detectCorners(src) {
  return detectDocument(src) || defaultCorners(src);
}

// ===================================================================
// Vrai format du document (rectification "à la Zhang").
// Quand on photographie une feuille DE BIAIS, ses bords paraissent plus
// courts ou plus longs qu'en vrai : prendre simplement la longueur des
// bords déforme le résultat (A4 étiré ou écrasé). Cette formule retrouve
// le VRAI rapport largeur/hauteur de la feuille à partir de la
// perspective des 4 coins. (Hypothèse standard : centre optique au
// centre de la photo.) En cas de configuration dégénérée → null, et on
// retombera sur la mesure des bords.
// ===================================================================
export function estimateAspectRatio(c, imgW, imgH) {
  const u0 = imgW / 2;
  const v0 = imgH / 2;
  // Coordonnées homogènes, recentrées sur le centre de l'image.
  const m1 = [c.topLeftCorner.x - u0, c.topLeftCorner.y - v0, 1];
  const m2 = [c.topRightCorner.x - u0, c.topRightCorner.y - v0, 1];
  const m3 = [c.bottomLeftCorner.x - u0, c.bottomLeftCorner.y - v0, 1];
  const m4 = [c.bottomRightCorner.x - u0, c.bottomRightCorner.y - v0, 1];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  const d2 = dot(cross(m2, m4), m3);
  const d3 = dot(cross(m3, m4), m2);
  if (Math.abs(d2) < 1e-9 || Math.abs(d3) < 1e-9) return null;
  const k2 = dot(cross(m1, m4), m3) / d2;
  const k3 = dot(cross(m1, m4), m2) / d3;

  // n2 = direction "largeur", n3 = direction "hauteur" (espace projectif).
  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];

  let ratio;
  if (Math.abs(n2[2]) > 1e-6 && Math.abs(n3[2]) > 1e-6) {
    // Cas général : on estime d'abord la focale f de l'appareil photo.
    const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
    if (!isFinite(f2) || f2 <= 0) return null;
    ratio =
      Math.sqrt(n2[0] * n2[0] + n2[1] * n2[1] + f2 * n2[2] * n2[2]) /
      Math.sqrt(n3[0] * n3[0] + n3[1] * n3[1] + f2 * n3[2] * n3[2]);
  } else if (Math.abs(n2[2]) < 1e-6 && Math.abs(n3[2]) < 1e-6) {
    // Feuille vue bien en face : le rapport des longueurs suffit.
    ratio = Math.hypot(n2[0], n2[1]) / Math.hypot(n3[0], n3[1]);
  } else {
    return null; // configuration ambiguë → repli sur la mesure des bords
  }

  // Garde-fou : un document réel est entre 1:5 et 5:1.
  if (!isFinite(ratio) || ratio < 0.2 || ratio > 5) return null;
  return ratio; // largeur ÷ hauteur
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

// presetCorners (optionnel) : repart des coins déjà choisis (éditeur)
// au lieu de relancer la détection automatique.
export async function initCrop(imageDataUrl, presetCorners) {
  const loadingText = document.getElementById("crop-loading-text");
  const loadingBack = document.getElementById("btn-crop-loading-back");
  loadingText.textContent = "Chargement du moteur de détection…";
  loadingBack.hidden = true;
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

    corners =
      presetCorners && validCorners(presetCorners, sourceCanvas)
        ? JSON.parse(JSON.stringify(presetCorners)) // copie (les poignées modifient)
        : detectCorners(sourceCanvas);
    buildOverlay();
    updatePositions();
  } catch (e) {
    console.error(e);
    // Pas de cul-de-sac : on explique et on offre un retour. Le moteur
    // pourra retenter son chargement au prochain essai (voir ensureEngineLoaded).
    loadingText.textContent =
      "Le moteur de détection n'a pas pu se charger. Vérifie ta connexion, puis réessaie.";
    loadingBack.hidden = false;
    return;
  }
  loading.hidden = true;
}

// Redresse le document (correction de perspective) selon les 4 coins
// et renvoie un CANVAS bien droit, plein résolution.
// Taille de sortie : on garde le plus grand côté MESURÉ (= netteté max),
// et l'autre côté est calculé d'après le VRAI format de la feuille
// (estimateAspectRatio) → fini les documents étirés ou écrasés.
// Calcule la taille de sortie du document redressé : on garde le plus
// grand côté MESURÉ (netteté max) et l'autre suit le VRAI format estimé.
function dewarpSize(c, imgW, imgH) {
  let w = Math.max(
    distance(c.topLeftCorner, c.topRightCorner),
    distance(c.bottomLeftCorner, c.bottomRightCorner)
  );
  let h = Math.max(
    distance(c.topLeftCorner, c.bottomLeftCorner),
    distance(c.topRightCorner, c.bottomRightCorner)
  );
  const edgeRatio = w / Math.max(1, h);

  // Garde-fou : si l'estimation s'écarte de plus de ×2 du rapport mesuré
  // sur les bords, c'est du bruit → on ignore.
  let ratio = estimateAspectRatio(c, imgW, imgH);
  if (!ratio || ratio < edgeRatio / 2 || ratio > edgeRatio * 2) ratio = null;
  if (ratio) {
    // On agrandit le côté sous-estimé (jamais de perte de résolution).
    if (w / h > ratio) h = w / ratio;
    else w = h * ratio;
  }
  // Plafond mémoire : ~3200 px (A4 ≈ 270 dpi) → texte NET pour l'OCR.
  // Le redressement est désormais différé (caméra coupée, par lot), donc
  // cette résolution ne coûte plus aucune fluidité à la prise de vue.
  const MAX = 3200;
  if (Math.max(w, h) > MAX) {
    const s = MAX / Math.max(w, h);
    w *= s;
    h *= s;
  }
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

// Transformation de perspective : les 4 coins → un rectangle w × h.
function warpToCanvas(srcCanvas, c, w, h) {
  const cv = window.cv;
  let src, srcPts, dstPts, M, out;
  try {
    src = cv.imread(srcCanvas);
    srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      c.topLeftCorner.x, c.topLeftCorner.y,
      c.topRightCorner.x, c.topRightCorner.y,
      c.bottomRightCorner.x, c.bottomRightCorner.y,
      c.bottomLeftCorner.x, c.bottomLeftCorner.y,
    ]);
    dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
    M = cv.getPerspectiveTransform(srcPts, dstPts);
    out = new cv.Mat();
    // INTER_CUBIC : interpolation de meilleure qualité → texte plus net
    // pour l'OCR. Le coût est négligeable (détourage différé, hors caméra).
    cv.warpPerspective(src, out, M, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
    const canvas = document.createElement("canvas");
    cv.imshow(canvas, out);
    return canvas;
  } finally {
    [src, srcPts, dstPts, M, out].forEach((x) => {
      try {
        if (x) x.delete();
      } catch (_) {}
    });
  }
}

export function cropToCanvas() {
  const { w, h } = dewarpSize(corners, sourceCanvas.width, sourceCanvas.height);
  return warpToCanvas(sourceCanvas, corners, w, h);
}

// Les coins actuellement choisis sur l'écran de rognage (copie).
export function getCropCorners() {
  return corners ? JSON.parse(JSON.stringify(corners)) : null;
}

// Détourage AUTOMATIQUE d'une photo. `hintQuad` (optionnel) : le cadre
// déjà détecté par la visée en direct au moment du déclic — c'est lui
// qu'on applique en priorité ("ce que tu vois est ce que tu obtiens"),
// même si le document est loin dans le cadre. Sinon on re-détecte sur
// la photo. Si rien de fiable → photo telle quelle.
export async function autoDewarp(dataUrl, hintQuad) {
  await ensureEngineLoaded();
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("Image illisible"));
    img.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d").drawImage(img, 0, 0);

  // 1. Le cadre de la visée, s'il est plausible, gagne.
  let quad = null;
  if (hintQuad && validCorners(hintQuad, canvas)) {
    quad = JSON.parse(JSON.stringify(hintQuad));
  }

  // 2. Sinon : détection sur une version RÉDUITE (≤900 px) — bien plus
  // rapide et léger en mémoire qu'analyser la photo 4K, pour le même
  // résultat (les coins sont remis à l'échelle ensuite).
  if (!quad) {
    const k = Math.min(1, 900 / Math.max(canvas.width, canvas.height));
    if (k < 1) {
      const small = document.createElement("canvas");
      small.width = Math.round(canvas.width * k);
      small.height = Math.round(canvas.height * k);
      small.getContext("2d").drawImage(canvas, 0, 0, small.width, small.height);
      quad = detectDocument(small);
      if (quad) {
        for (const key of CORNER_KEYS) {
          quad[key] = { x: quad[key].x / k, y: quad[key].y / k };
        }
      }
    } else {
      quad = detectDocument(canvas);
    }
  }

  // Rien de fiable détecté : on renvoie la photo telle quelle ET son canvas
  // déjà décodé (évite à l'appelant de re-décoder pour le filtre).
  if (!quad) return { dataUrl, canvas, corners: null, cropped: false };

  // 3. Redressement. Si la mémoire du téléphone ne suit pas sur la photo
  // pleine résolution, on retente sur une version réduite de moitié
  // (toujours largement suffisant pour le PDF et l'OCR).
  try {
    const { w, h } = dewarpSize(quad, canvas.width, canvas.height);
    const warped = warpToCanvas(canvas, quad, w, h);
    // On renvoie aussi le canvas redressé : l'appelant (processPage) lui
    // applique directement le filtre, sans ré-encoder/ré-décoder l'image.
    return { dataUrl: warped.toDataURL("image/jpeg", 0.95), canvas: warped, corners: quad, cropped: true };
  } catch (e) {
    console.warn("Détourage pleine résolution impossible, repli en demi-taille.", e);
    const half = document.createElement("canvas");
    half.width = Math.max(1, Math.round(canvas.width / 2));
    half.height = Math.max(1, Math.round(canvas.height / 2));
    half.getContext("2d").drawImage(canvas, 0, 0, half.width, half.height);
    const hq = {};
    for (const key of CORNER_KEYS) {
      hq[key] = { x: quad[key].x / 2, y: quad[key].y / 2 };
    }
    const { w, h } = dewarpSize(hq, half.width, half.height);
    const warped = warpToCanvas(half, hq, w, h);
    return { dataUrl: warped.toDataURL("image/jpeg", 0.95), canvas: warped, corners: quad, cropped: true };
  }
}
