// ===================================================================
// pdf.js — assemble les pages scannées en UN SEUL PDF (jsPDF), puis
// propose le partage natif (téléphone) ou le téléchargement (ordi).
//
// jsPDF n'est chargé qu'au premier export (librairie ~300 Ko).
// ===================================================================

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

// Dimensions (en pixels) d'une image fournie en data URL.
function getDimensions(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error("Image illisible"));
    img.src = dataUrl;
  });
}

// Construit le PDF : une page par image, à la taille de l'image (donc
// sans marge ni déformation). Renvoie un Blob PDF.
async function buildPdfBlob(pages) {
  await ensureJsPdf();
  const { jsPDF } = window.jspdf;

  // On récupère d'abord les dimensions de toutes les pages.
  const dims = await Promise.all(pages.map(getDimensions));

  // Le document démarre à la taille de la 1re page.
  const doc = new jsPDF({
    unit: "px",
    format: [dims[0].w, dims[0].h],
    orientation: dims[0].w > dims[0].h ? "landscape" : "portrait",
    compress: true,
  });
  doc.addImage(pages[0], "JPEG", 0, 0, dims[0].w, dims[0].h);

  // Puis une nouvelle page (à sa propre taille) pour chaque image suivante.
  for (let i = 1; i < pages.length; i++) {
    doc.addPage(
      [dims[i].w, dims[i].h],
      dims[i].w > dims[i].h ? "landscape" : "portrait"
    );
    doc.addImage(pages[i], "JPEG", 0, 0, dims[i].w, dims[i].h);
  }

  return doc.output("blob");
}

// Propose le PDF : feuille de partage native si possible (mobile),
// sinon téléchargement classique (ordinateur).
export async function exportPdf(pages) {
  const blob = await buildPdfBlob(pages);
  const file = new File([blob], "scanzen.pdf", { type: "application/pdf" });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Scanzen" });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return; // partage annulé : on s'arrête
      // autre erreur : on retombe sur le téléchargement ci-dessous
    }
  }

  // Téléchargement classique
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "scanzen.pdf";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
