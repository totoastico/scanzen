// ===================================================================
// ocr.js — reconnaissance de texte (OCR) via Tesseract.js, en français.
//
// Le moteur + la langue (~15 Mo) se téléchargent au PREMIER usage, puis
// sont mis en cache. On garde un seul "worker" (Tesseract tourne dans un
// thread séparé, donc l'interface ne se fige pas).
// ===================================================================

const TESSERACT_URL =
  "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";

let scriptPromise = null;
let workerPromise = null;
let progressCb = null;

function loadScript() {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = TESSERACT_URL;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Échec du chargement de Tesseract"));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

async function getWorker() {
  await loadScript();
  if (!workerPromise) {
    workerPromise = window.Tesseract.createWorker("fra", 1, {
      logger: (m) => {
        if (m.status === "recognizing text" && progressCb) progressCb(m.progress);
      },
    });
  }
  return workerPromise;
}

// Reconnaît le texte d'une image (data URL) et renvoie les LIGNES avec
// leur position (bbox en pixels de l'image).
export async function ocrPage(image, onProgress) {
  progressCb = onProgress || null;
  const worker = await getWorker();
  const { data } = await worker.recognize(image);
  progressCb = null;
  return (data.lines || [])
    .map((l) => ({ text: (l.text || "").trim(), bbox: l.bbox }))
    .filter((l) => l.text.length > 0 && l.bbox);
}

// Libère le moteur OCR (mémoire) après usage.
export async function terminateOcr() {
  if (workerPromise) {
    try {
      const w = await workerPromise;
      await w.terminate();
    } catch (e) {
      /* ignore */
    }
    workerPromise = null;
  }
}
