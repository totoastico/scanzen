// ===================================================================
// pdf.js — assemble les pages en UN SEUL PDF (jsPDF), puis propose le
// partage natif (téléphone) ou le téléchargement (ordi).
//
// Option OCR : pour chaque page, on superpose une couche de texte
// INVISIBLE (issue de l'OCR) → le PDF devient sélectionnable / cherchable
// / convertible, tout en gardant l'image visible.
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

// Construit le PDF (une page par image). Si opts.ocr, ajoute la couche
// de texte invisible. Renvoie un Blob PDF.
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
        doc.setFontSize(h * 0.72); // ~ hauteur de ligne (le texte est invisible)
        try {
          // Texte invisible (renderingMode), positionné sur la ligne.
          doc.text(ln.text, ln.bbox.x0, ln.bbox.y1, {
            renderingMode: "invisible",
            baseline: "alphabetic",
          });
        } catch (e) {
          /* certains caractères peuvent ne pas s'encoder : on ignore */
        }
      }
    }
  }
  return doc.output("blob");
}

// Propose le PDF : partage natif si possible (mobile), sinon téléchargement.
export async function exportPdf(pages, opts = {}) {
  try {
    const blob = await buildPdfBlob(pages, opts);
    const file = new File([blob], "scanzen.pdf", { type: "application/pdf" });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "Scanzen" });
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
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
  } finally {
    // On libère le moteur OCR (mémoire) après l'export.
    if (opts.ocr) terminateOcr().catch(() => {});
  }
}
