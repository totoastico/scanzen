// ===================================================================
// filters.js — les 3 "modes scan" appliqués à une image.
//   - original : l'image telle quelle
//   - auto     : contraste / luminosité rehaussés (rendu "scan couleur")
//   - bw       : noir & blanc (document épuré)
//
// Technique : on redessine l'image sur un <canvas> en appliquant un
// filtre (ctx.filter), puis on récupère une nouvelle image (data URL).
// ===================================================================

// Réglages de chaque mode = valeur de la propriété CSS "filter".
const FILTER_CSS = {
  original: "none",
  auto: "contrast(1.35) brightness(1.06) saturate(1.12)",
  bw: "grayscale(1) contrast(1.7) brightness(1.12)",
};

// Applique le mode choisi à une image DÉJÀ chargée (HTMLImageElement)
// et renvoie une nouvelle image au format data URL (JPEG).
export function applyFilter(img, mode) {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;

  const ctx = canvas.getContext("2d");
  ctx.filter = FILTER_CSS[mode] || "none";
  ctx.drawImage(img, 0, 0);

  return canvas.toDataURL("image/jpeg", 0.92);
}
