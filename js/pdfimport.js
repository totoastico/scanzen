// ===================================================================
// pdfimport.js — importer un PDF existant.
//
// Un PDF n'est pas une image : on le "rend" page par page en IMAGE
// (via la bibliothèque pdf.js), puis chaque page rejoint EXACTEMENT le
// même parcours que les photos (recadrage → filtre → liste → export).
//
// pdf.js est lourd : on ne le charge depuis le CDN qu'à la première
// utilisation (comme OpenCV ou Tesseract).
// ===================================================================

const PDFJS_VERSION = "3.11.174";
const CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build`;

let pdfjsPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Chargement de pdf.js impossible (connexion ?)"));
    document.head.appendChild(s);
  });
}

// Charge pdf.js une seule fois et configure son "worker".
async function ensurePdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  if (!pdfjsPromise) {
    pdfjsPromise = loadScript(`${CDN}/pdf.min.js`).then(() => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${CDN}/pdf.worker.min.js`;
      return window.pdfjsLib;
    });
  }
  return pdfjsPromise;
}

// Vrai si le fichier est un PDF.
export function isPdf(file) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

// Rend chaque page du PDF en image (data URL JPEG).
// onProgress(pageActuelle, total) sert à afficher l'avancement.
export async function pdfToImages(file, onProgress) {
  const lib = await ensurePdfJs();
  const buf = await file.arrayBuffer();
  const pdf = await lib.getDocument({ data: buf }).promise;

  const images = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    if (onProgress) onProgress(i, pdf.numPages);
    const page = await pdf.getPage(i);

    // On vise ~1600 px de large : bon compromis netteté / OCR / poids.
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, 1600 / base.width);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    // willReadFrequently : contexte "logiciel" (CPU). On lit les pixels
    // ensuite (toDataURL) ; ça évite aussi un blocage du rendu observé
    // sur certains navigateurs sans accélération graphique.
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    await page.render({ canvasContext: ctx, viewport }).promise;

    images.push(canvas.toDataURL("image/jpeg", 0.92));
    page.cleanup();
  }
  return images;
}
