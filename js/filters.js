// ===================================================================
// filters.js — les 3 modes scan.
//   - original : l'image telle quelle
//   - auto     : COULEUR, éclairage ÉGALISÉ (ombres atténuées) en gardant
//                la luminosité d'origine + léger contraste/netteté
//   - bw       : NOIR & BLANC net (fond blanc + seuillage Otsu)
//
// Pour "auto", on n'écrase plus le fond vers le blanc pur (ça délavait) :
// on normalise vers la luminosité MOYENNE de la page → on enlève les
// ombres sans sur-éclairer. Repli CSS si OpenCV indisponible.
// ===================================================================

const FILTER_CSS = {
  original: "none",
  auto: "contrast(1.12) brightness(1.02)",
  bw: "grayscale(1) contrast(1.7) brightness(1.12)",
};

const QUALITY = 0.95;

function toDataURL(canvas) {
  return canvas.toDataURL("image/jpeg", QUALITY);
}

function drawCanvas(source) {
  const w = source.width || source.naturalWidth;
  const h = source.height || source.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(source, 0, 0, w, h);
  return canvas;
}

// --- Outils OpenCV --------------------------------------------------

// Estime le fond (éclairage de la page) : version réduite → fermeture
// morphologique (efface le texte, garde l'éclairage) → ré-agrandit.
function estimateBackground(gray) {
  const cv = window.cv;
  const scale = 4;
  const small = new cv.Mat();
  cv.resize(
    gray,
    small,
    new cv.Size(Math.max(1, Math.round(gray.cols / scale)), Math.max(1, Math.round(gray.rows / scale))),
    0,
    0,
    cv.INTER_AREA
  );
  let k = Math.round(Math.max(small.cols, small.rows) / 8);
  if (k < 7) k = 7;
  if (k % 2 === 0) k += 1;
  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k));
  const bgSmall = new cv.Mat();
  cv.morphologyEx(small, bgSmall, cv.MORPH_CLOSE, kernel);
  const bg = new cv.Mat();
  cv.resize(bgSmall, bg, new cv.Size(gray.cols, gray.rows), 0, 0, cv.INTER_LINEAR);
  small.delete();
  kernel.delete();
  bgSmall.delete();
  return bg;
}

// Accentuation douce (masque flou inversé) → renvoie une NOUVELLE Mat.
function unsharp(mat, amount) {
  const cv = window.cv;
  const blur = new cv.Mat();
  cv.GaussianBlur(mat, blur, new cv.Size(0, 0), 1.2);
  const out = new cv.Mat();
  cv.addWeighted(mat, 1 + amount, blur, -amount, 0, out);
  blur.delete();
  return out;
}

// Mode "Auto" : couleur, éclairage égalisé (sans sur-éclairer) + léger
// contraste + accentuation douce.
// L'égalisation se fait CANAL PAR CANAL (rouge, vert, bleu) : une ombre
// n'assombrit pas les trois couleurs de la même façon, donc on enlève
// l'ombre ET sa teinte (bleutée, jaunâtre…). Chaque canal est ramené
// vers SA propre moyenne → la teinte naturelle du papier est conservée
// (pas de blanc délavé).
function cvAuto(source) {
  const cv = window.cv;
  // Tout est déclaré d'avance et libéré dans `finally` : même si OpenCV
  // plante en cours de route (mémoire…), rien ne fuit.
  let src, rgb, channels, fixed, norm, sharp;
  const temp = [];
  try {
    src = cv.imread(drawCanvas(source));
    rgb = new cv.Mat();
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);

    channels = new cv.MatVector();
    cv.split(rgb, channels);
    fixed = new cv.MatVector();
    for (let i = 0; i < 3; i++) {
      const ch = channels.get(i);
      temp.push(ch);
      const bg = estimateBackground(ch);
      temp.push(bg);
      const out = new cv.Mat();
      temp.push(out);
      cv.divide(ch, bg, out, cv.mean(bg)[0] || 200);
      fixed.push_back(out);
    }
    norm = new cv.Mat();
    cv.merge(fixed, norm);
    cv.convertScaleAbs(norm, norm, 1.1, -5); // contraste léger
    sharp = unsharp(norm, 0.4); // accentuation douce

    const canvas = document.createElement("canvas");
    cv.imshow(canvas, sharp);
    return toDataURL(canvas);
  } finally {
    [src, rgb, norm, sharp, ...temp, channels, fixed].forEach((m) => {
      try {
        if (m) m.delete();
      } catch (_) {}
    });
  }
}

// Mode "Noir & blanc" : éclairage normalisé + netteté + seuillage Otsu.
function cvBW(source) {
  const cv = window.cv;
  let src, gray, bg, norm, sharp, dst;
  try {
    src = cv.imread(drawCanvas(source));
    gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    bg = estimateBackground(gray);
    norm = new cv.Mat();
    cv.divide(gray, bg, norm, 255);
    sharp = unsharp(norm, 0.5);

    dst = new cv.Mat();
    cv.threshold(sharp, dst, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);

    const canvas = document.createElement("canvas");
    cv.imshow(canvas, dst);
    return toDataURL(canvas);
  } finally {
    [src, gray, bg, norm, sharp, dst].forEach((m) => {
      try {
        if (m) m.delete();
      } catch (_) {}
    });
  }
}

// --- Repli sans OpenCV ---------------------------------------------

function simpleFilter(source, mode) {
  const canvas = drawCanvas(source);
  if (mode === "original") return toDataURL(canvas);
  const c2 = document.createElement("canvas");
  c2.width = canvas.width;
  c2.height = canvas.height;
  const ctx = c2.getContext("2d");
  ctx.filter = FILTER_CSS[mode] || "none";
  ctx.drawImage(canvas, 0, 0);
  return toDataURL(c2);
}

// --- Point d'entrée ------------------------------------------------

export function applyFilter(source, mode) {
  if (mode === "original") return toDataURL(drawCanvas(source));

  if (window.cv && window.cv.Mat) {
    try {
      if (mode === "auto") return cvAuto(source);
      if (mode === "bw") return cvBW(source);
    } catch (e) {
      console.warn("Filtre OpenCV impossible, repli simple.", e);
    }
  }
  return simpleFilter(source, mode);
}
