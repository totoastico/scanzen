// ===================================================================
// livescan.js — visée en direct : pendant la prise de photo, on détecte
// le document sur le flux vidéo et on dessine son cadre en temps réel
// (comme les applis de scan de notes de frais).
//
// Principe : ~5 fois par seconde, on copie une version RÉDUITE de la
// vidéo (rapide), on y cherche le document (detectDocument), puis on
// dessine le cadre sur un canvas posé par-dessus la vidéo. Les coins
// sont LISSÉS d'une image à l'autre pour que le cadre "glisse" au lieu
// de trembler.
// ===================================================================

import { detectDocument, ensureEngineLoaded } from "./scanner.js";

const KEYS = ["topLeftCorner", "topRightCorner", "bottomRightCorner", "bottomLeftCorner"];

let running = false;
let generation = 0;  // une seule boucle active à la fois (anti-doublon)
let timer = null;    // boucle de DÉTECTION (~5×/s)
let rafId = null;    // boucle de DESSIN (60 images/s, fluide)
let target = null;   // dernier cadre détecté (en pixels VIDÉO)
let smooth = null;   // cadre affiché, qui GLISSE vers target à chaque image
let missCount = 0;   // détections ratées d'affilée → on efface le cadre

// Petit canvas de travail réutilisé (≈360 px de large : assez pour
// détecter, très rapide à analyser).
const sample = document.createElement("canvas");
const sampleCtx = sample.getContext("2d", { willReadFrequently: true });

// Interpolation douce entre l'ancien cadre et le nouveau (t = vitesse).
export function lerpCorners(a, b, t) {
  const out = {};
  for (const k of KEYS) {
    out[k] = {
      x: a[k].x + (b[k].x - a[k].x) * t,
      y: a[k].y + (b[k].y - a[k].y) * t,
    };
  }
  return out;
}

// La vidéo est affichée en "cover" (elle remplit l'écran, quitte à
// déborder) : on calcule la transformation pixels vidéo → pixels écran.
export function coverTransform(videoW, videoH, elW, elH) {
  const s = Math.max(elW / videoW, elH / videoH);
  return { s, ox: (elW - videoW * s) / 2, oy: (elH - videoH * s) / 2 };
}

export function startLiveScan(videoEl, overlayEl) {
  stopLiveScan(overlayEl);
  running = true;
  const gen = ++generation;
  // OpenCV se charge en arrière-plan ; la visée démarre dès qu'il est prêt.
  ensureEngineLoaded()
    .then(() => {
      if (running && gen === generation) {
        detectTick(videoEl, gen); // détection ~5×/s (coûteuse)
        drawTick(videoEl, overlayEl, gen); // dessin 60 img/s (léger)
      }
    })
    .catch(() => {}); // hors-ligne : pas de visée, la caméra marche quand même
}

export function stopLiveScan(overlayEl) {
  running = false;
  clearTimeout(timer);
  cancelAnimationFrame(rafId);
  target = null;
  smooth = null;
  missCount = 0;
  if (overlayEl && overlayEl.width) {
    overlayEl.getContext("2d").clearRect(0, 0, overlayEl.width, overlayEl.height);
  }
}

// --- Boucle de détection : cherche le document dans le flux (~5×/s) ---
function detectTick(videoEl, gen) {
  if (!running || gen !== generation) return;
  try {
    detectStep(videoEl);
  } catch (e) {
    // une analyse ratée ne doit jamais casser la caméra
  }
  timer = setTimeout(() => detectTick(videoEl, gen), 200);
}

function detectStep(videoEl) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return; // flux pas encore prêt

  // Photo réduite du flux (480 px). La visée n'est qu'un GUIDE visuel :
  // 1 seule passe suffit et reste légère sur le téléphone. Le vrai
  // détourage (au "Terminer", caméra coupée) refait une détection complète.
  const w = 480;
  const h = Math.max(1, Math.round((vh * w) / vw));
  sample.width = w;
  sample.height = h;
  sampleCtx.drawImage(videoEl, 0, 0, w, h);

  // 1 passe : assez pour le cadre-guide, sans saturer le fil principal.
  const quad = detectDocument(sample, 1);
  if (quad) {
    const scaled = {};
    for (const k of KEYS) {
      scaled[k] = { x: (quad[k].x * vw) / w, y: (quad[k].y * vh) / h };
    }
    target = scaled;
    missCount = 0;
  } else if (++missCount > 4) {
    target = null; // plus de document depuis ~1 s → on efface
  }
}

// Le cadre actuellement détecté (en pixels VIDÉO), ou null. Utilisé au
// moment du déclic : "ce que tu vois est ce que tu obtiens".
export function getCurrentQuad() {
  return target ? JSON.parse(JSON.stringify(target)) : null;
}

// --- Boucle de dessin : le cadre GLISSE vers la dernière détection,
//     à chaque image écran → mouvement fluide, plus de saccades. ---
function drawTick(videoEl, overlayEl, gen) {
  if (!running || gen !== generation) return;
  if (target) {
    smooth = smooth ? lerpCorners(smooth, target, 0.22) : target;
  } else {
    smooth = null;
  }
  draw(videoEl, overlayEl);
  rafId = requestAnimationFrame(() => drawTick(videoEl, overlayEl, gen));
}

function draw(videoEl, overlayEl) {
  const ew = videoEl.clientWidth;
  const eh = videoEl.clientHeight;
  if (!ew || !eh) return;
  // Taille en pixels PHYSIQUES (sinon le trait est flou sur mobile).
  const dpr = window.devicePixelRatio || 1;
  const bw = Math.round(ew * dpr);
  const bh = Math.round(eh * dpr);
  if (overlayEl.width !== bw) overlayEl.width = bw;
  if (overlayEl.height !== bh) overlayEl.height = bh;
  const ctx = overlayEl.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // on continue à dessiner en px CSS
  ctx.clearRect(0, 0, ew, eh);
  if (!smooth) return;

  const { s, ox, oy } = coverTransform(videoEl.videoWidth, videoEl.videoHeight, ew, eh);
  const pts = KEYS.map((k) => [smooth[k].x * s + ox, smooth[k].y * s + oy]);

  // Voile léger autour du document…
  ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
  ctx.fillRect(0, 0, ew, eh);
  ctx.globalCompositeOperation = "destination-out";
  tracePath(ctx, pts);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";

  // …le cadre bleu par-dessus…
  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  tracePath(ctx, pts);
  ctx.stroke();

  // …et les 4 points de coins (comme les poignées de l'écran de rognage).
  for (const [x, y] of pts) {
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#2563eb";
    ctx.stroke();
  }
}

function tracePath(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}
