// ===================================================================
// filters.js — les 3 "modes scan" + accentuation (netteté du texte).
//   - original : l'image telle quelle
//   - auto     : contraste/luminosité rehaussés + accentuation
//   - bw       : noir & blanc + accentuation
//
// On dessine la source sur un <canvas> avec un filtre (ctx.filter),
// puis (pour auto/bw) on applique une "accentuation" qui précise les
// contours du texte, et enfin on exporte en JPEG haute qualité.
// ===================================================================

const FILTER_CSS = {
  original: "none",
  auto: "contrast(1.32) brightness(1.05) saturate(1.1)",
  bw: "grayscale(1) contrast(1.65) brightness(1.12)",
};

// Accentuation par "masque flou inversé" (unsharp mask) : on compare
// l'image à une version floutée et on accentue les écarts → contours
// (donc le texte) plus nets. `amount` = force de l'effet.
function unsharp(canvas, amount) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d");
  const original = ctx.getImageData(0, 0, w, h);

  // version floutée de la même image
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext("2d");
  tctx.filter = "blur(1.1px)";
  tctx.drawImage(canvas, 0, 0);
  const blurred = tctx.getImageData(0, 0, w, h);

  const o = original.data;
  const b = blurred.data;
  for (let i = 0; i < o.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const v = o[i + k] + amount * (o[i + k] - b[i + k]);
      o[i + k] = v < 0 ? 0 : v > 255 ? 255 : v; // on borne à [0,255]
    }
  }
  ctx.putImageData(original, 0, 0);
}

// Applique le mode choisi à une source (canvas ou image déjà chargée)
// et renvoie une nouvelle image au format data URL (JPEG haute qualité).
export function applyFilter(source, mode) {
  const w = source.width || source.naturalWidth;
  const h = source.height || source.naturalHeight;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.filter = FILTER_CSS[mode] || "none";
  ctx.drawImage(source, 0, 0, w, h);
  ctx.filter = "none";

  // Auto et N&B : on accentue pour préciser l'écriture.
  if (mode === "auto" || mode === "bw") unsharp(canvas, 0.6);

  return canvas.toDataURL("image/jpeg", 0.95);
}
