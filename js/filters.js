// ===================================================================
// filters.js — les 3 modes scan, avec un vrai traitement "document".
//
//   - original : l'image telle quelle
//   - auto     : couleur, éclairage normalisé (ombres/plis atténués)
//   - bw       : noir & blanc net (fond uniforme + seuillage)
//
// Idée clé ("comme CamScanner") : on estime le FOND de la page (son
// éclairage, sans le texte) et on le neutralise → le fond redevient
// blanc uniforme, les ombres de pli s'estompent, le texte ressort.
//
// On utilise OpenCV (déjà chargé pour la détection). En cas de souci,
// on retombe sur un filtre CSS simple (repli) pour ne jamais casser.
// ===================================================================

const FILTER_CSS = {
  original: "none",
  auto: "contrast(1.3) brightness(1.05) saturate(1.1)",
  bw: "grayscale(1) contrast(1.7) brightness(1.12)",
};

const QUALITY = 0.95;

function toDataURL(canvas) {
  return canvas.toDataURL("image/jpeg", QUALITY);
}

// Dessine la source (canvas ou image) sur un nouveau canvas.
function drawCanvas(source) {
  const w = source.width || source.naturalWidth;
  const h = source.height || source.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(source, 0, 0, w, h);
  return canvas;
}

// --- Traitement OpenCV ---------------------------------------------

// Estime le fond (l'éclairage de la page) : on travaille sur une
// version réduite (rapide), on "bouche" le texte par une fermeture
// morphologique, puis on ré-agrandit. Renvoie une Mat 8U (à supprimer
// par l'appelant).
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

// Mode "Auto" : couleur avec éclairage normalisé.
function cvAuto(source) {
  const cv = window.cv;
  const src = cv.imread(drawCanvas(source)); // RGBA
  const rgb = new cv.Mat();
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  const bg = estimateBackground(gray);
  const bg3 = new cv.Mat();
  cv.cvtColor(bg, bg3, cv.COLOR_GRAY2RGB);

  const out = new cv.Mat();
  cv.divide(rgb, bg3, out, 255); // chaque canalisé / fond → ombres neutralisées
  cv.convertScaleAbs(out, out, 1.08, -6); // léger contraste

  const canvas = document.createElement("canvas");
  cv.imshow(canvas, out);

  src.delete();
  rgb.delete();
  gray.delete();
  bg.delete();
  bg3.delete();
  out.delete();
  return toDataURL(canvas);
}

// Mode "Noir & blanc" : fond uniforme puis seuillage d'Otsu → texte net.
function cvBW(source) {
  const cv = window.cv;
  const src = cv.imread(drawCanvas(source));
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  const bg = estimateBackground(gray);
  const norm = new cv.Mat();
  cv.divide(gray, bg, norm, 255); // fond ~blanc uniforme

  const dst = new cv.Mat();
  // Otsu choisit automatiquement le bon seuil (fond déjà uniformisé).
  cv.threshold(norm, dst, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);

  const canvas = document.createElement("canvas");
  cv.imshow(canvas, dst);

  src.delete();
  gray.delete();
  bg.delete();
  norm.delete();
  dst.delete();
  return toDataURL(canvas);
}

// --- Repli (sans OpenCV) -------------------------------------------

function simpleFilter(source, mode) {
  const canvas = drawCanvas(source);
  if (mode !== "original") {
    const c2 = document.createElement("canvas");
    c2.width = canvas.width;
    c2.height = canvas.height;
    const ctx = c2.getContext("2d");
    ctx.filter = FILTER_CSS[mode] || "none";
    ctx.drawImage(canvas, 0, 0);
    return toDataURL(c2);
  }
  return toDataURL(canvas);
}

// --- Point d'entrée ------------------------------------------------

// Applique le mode choisi à une source (canvas ou image) et renvoie
// une nouvelle image (data URL JPEG haute qualité).
export function applyFilter(source, mode) {
  if (mode === "original") return toDataURL(drawCanvas(source));

  const hasCv = window.cv && window.cv.Mat;
  if (hasCv) {
    try {
      if (mode === "auto") return cvAuto(source);
      if (mode === "bw") return cvBW(source);
    } catch (e) {
      console.warn("Filtre OpenCV impossible, repli simple.", e);
    }
  }
  return simpleFilter(source, mode);
}
