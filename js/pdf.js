// ===================================================================
// pdf.js — assemble les pages en UN SEUL PDF (jsPDF).
//
// Deux étapes séparées :
//   - buildPdf()  : fabrique le PDF (long si OCR) → renvoie un Blob.
//   - sharePdf()  : ouvre le partage natif / téléchargement.
// On les sépare car le partage exige un "geste utilisateur récent" :
// après un OCR long, on attend un nouvel appui pour partager de façon
// fiable.
//
// Option OCR : couche de texte INVISIBLE par page → PDF sélectionnable.
// ===================================================================

import { ocrPage, terminateOcr } from "./ocr.js";

const JSPDF_URL =
  "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js";

let jspdfPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Échec du chargement : " + src));
    document.head.appendChild(s);
  });
}

function ensureJsPdf() {
  if (!jspdfPromise) jspdfPromise = loadScript(JSPDF_URL);
  return jspdfPromise;
}

function getDimensions(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error("Image illisible"));
    img.src = dataUrl;
  });
}

async function buildPdfBlob(pages, opts) {
  await ensureJsPdf();
  const { jsPDF } = window.jspdf;
  const dims = await Promise.all(pages.map(getDimensions));
  const orient = (d) => (d.w > d.h ? "landscape" : "portrait");

  const doc = new jsPDF({
    unit: "px",
    format: [dims[0].w, dims[0].h],
    orientation: orient(dims[0]),
    compress: true,
  });

  for (let i = 0; i < pages.length; i++) {
    if (i > 0) doc.addPage([dims[i].w, dims[i].h], orient(dims[i]));
    doc.addImage(pages[i], "JPEG", 0, 0, dims[i].w, dims[i].h);

    if (opts.ocr) {
      const lines = await ocrPage(pages[i], (p) => {
        if (opts.onProgress) opts.onProgress(i, pages.length, p);
      });
      doc.setTextColor(0, 0, 0);
      for (const ln of lines) {
        const h = Math.max(1, ln.bbox.y1 - ln.bbox.y0);
        doc.setFontSize(h * 0.72);
        try {
          doc.text(ln.text, ln.bbox.x0, ln.bbox.y1, {
            renderingMode: "invisible",
            baseline: "alphabetic",
          });
        } catch (e) {
          /* caractère non encodable : on ignore */
        }
      }
    }
  }
  return doc.output("blob");
}

// Fabrique le PDF (Blob). Long si OCR.
export async function buildPdf(pages, opts = {}) {
  try {
    return await buildPdfBlob(pages, opts);
  } finally {
    if (opts.ocr) terminateOcr().catch(() => {});
  }
}

// Ouvre le partage natif (mobile) ou télécharge (ordi). À appeler depuis
// un appui utilisateur (sinon le partage est bloqué par le navigateur).
export async function sharePdf(blob) {
  const file = new File([blob], "scanzen.pdf", { type: "application/pdf" });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Scanzen" });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return; // partage annulé
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "scanzen.pdf";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
