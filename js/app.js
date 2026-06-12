// ===================================================================
// app.js — le "chef d'orchestre" de Scanzen.
//
// Il coordonne les écrans et l'état de l'app, et délègue le travail
// spécialisé aux autres fichiers (camera, scanner, filters, pages, pdf).
// ===================================================================

import { startCamera, stopCamera, capturePhoto } from "./camera.js";
import { initCrop, cropToCanvas, getCropCorners, autoDewarp } from "./scanner.js";
import { startLiveScan, stopLiveScan, getCurrentQuad } from "./livescan.js";
import { applyFilter } from "./filters.js";
import { addPage, pageCount, getPages, getPage, pageIndex, updatePage, clearPages } from "./pages.js";
import { buildPdf, sharePdf } from "./pdf.js";
import { ocrPage, terminateOcr } from "./ocr.js";
import { extractFields, buildFilename, isContractStart } from "./contract.js";
import { pdfToImages, isPdf } from "./pdfimport.js";

// --- État de l'ÉDITEUR de page (écran "résultat") ---
const state = {
  croppedCanvas: null, // base de travail (page rognée, avant rotation/filtre)
  filteredImage: null, // base + rotation + filtre (ce qui sera enregistré)
  activeFilter: "original", // effet courant
  rotation: 0, // rotation courante (0, 90, 180, 270)
};
let editorPage = null;             // la page ouverte dans l'éditeur
let editorFrom = "screen-pages";   // où revenir en sortant de l'éditeur
let replacePage = null;            // page à remplacer à la prochaine photo

let pendingPdf = null; // PDF préparé, en attente d'un appui pour le partager
let pdfGeneration = 0; // change à chaque modif de la liste → invalide un PDF en cours
const EXPORT_LABEL = "Exporter en PDF";

// --- Parcours cachet ---
let cachetPages = [];                     // images du lot cachet en cours d'analyse
let sentFirstPages = new Set();           // contrats déjà envoyés (clé = 1re page) → anti-doublon
let skippedFirstPages = new Set();        // contrats ignorés volontairement
let sentLog = [];                         // contrats réellement envoyés : [{ filename }]
let batchConfirmed = true;                // tous les envois du lot confirmés par Google ?

// Pour Google Sheets en français : la virgule décimale fait reconnaître le
// nombre (et afficher le €), contrairement au point.
const toComma = (v) => (v == null ? "" : String(v)).replace(".", ",");

// --- Éléments de la page dont on a besoin ---
const video = document.getElementById("camera-video");
const cameraError = document.getElementById("camera-error");
const cameraErrorText = document.getElementById("camera-error-text");
const resultImage = document.getElementById("result-image");
const filterButtons = document.querySelectorAll(".filter-btn");
const exportBtn = document.getElementById("btn-export");

// ===================================================================
// Navigation, voile "occupé", toast, fil d'étapes
// ===================================================================

// --- Navigation entre écrans : un seul visible à la fois ---
const screens = document.querySelectorAll(".screen");
function showScreen(id) {
  screens.forEach((screen) => screen.classList.remove("screen--active"));
  document.getElementById(id).classList.add("screen--active");
  if (id !== "screen-home") trapBack(); // bouton retour du téléphone (voir plus bas)
}

// --- Petit voile "occupé" (lecture d'un PDF, OCR…), annulable au besoin ---
const busy = document.getElementById("busy");
const busyText = document.getElementById("busy-text");
const busyCancel = document.getElementById("busy-cancel");
let busyOnCancel = null;
function showBusy(msg, onCancel) {
  busyText.textContent = msg;
  if (onCancel !== undefined) busyOnCancel = onCancel; // garde le callback pendant une boucle
  busyCancel.hidden = !busyOnCancel;
  busy.hidden = false;
}
function hideBusy() {
  busy.hidden = true;
  busyOnCancel = null;
}
busyCancel.addEventListener("click", () => {
  if (busyOnCancel) busyOnCancel();
});

// --- Toast : message furtif non bloquant (remplace les alert() de succès) ---
const toastEl = document.getElementById("toast");
let toastTimer = null;
function showToast(msg, ms = 3000) {
  toastEl.textContent = msg;
  toastEl.classList.add("toast--on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("toast--on"), ms);
}

// --- Fil d'étapes du parcours cachet (copié sur chaque écran concerné) ---
const STEP_ORDER = ["pages", "decoupage", "fiches", "envoi"];
function setStep(current) {
  const idx = STEP_ORDER.indexOf(current);
  document.querySelectorAll(".steps .step").forEach((el) => {
    const i = STEP_ORDER.indexOf(el.dataset.step);
    el.classList.toggle("step--done", i < idx);
    el.classList.toggle("step--current", i === idx);
    if (i === idx) el.setAttribute("aria-current", "step");
    else el.removeAttribute("aria-current");
  });
}

// Renvoie un canvas pivoté de `deg` degrés (90/180/270).
function rotateCanvas(canvas, deg) {
  const swap = deg === 90 || deg === 270;
  const out = document.createElement("canvas");
  out.width = swap ? canvas.height : canvas.width;
  out.height = swap ? canvas.width : canvas.height;
  const ctx = out.getContext("2d");
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

// ===================================================================
// Caméra (modes scan et cachet)
// ===================================================================

// Bouton "Terminer (N)", consigne et vignettes des pages déjà prises.
function updateCameraDone() {
  const done = document.getElementById("btn-camera-done");
  const n = pageCount();
  done.hidden = false;
  done.disabled = n === 0;
  done.textContent = `Terminer (${n})`;
  document.getElementById("camera-hint").hidden = n !== 0;
  updateCameraStrip();
}

// Reconstruit la bande de vignettes (taper une vignette = ouvrir l'éditeur).
const cameraStrip = document.getElementById("camera-strip");
function updateCameraStrip() {
  const n = pageCount();
  cameraStrip.hidden = n === 0;
  cameraStrip.innerHTML = "";
  if (n === 0) return;
  for (let i = 0; i < n; i++) {
    const page = getPage(i);
    const img = document.createElement("img");
    img.src = page.display;
    img.alt = "Page " + (i + 1);
    img.addEventListener("click", () => {
      cameraSession++;
      stopLiveScan(cameraOverlay);
      stopCamera(video);
      replacePage = null; // on change de page → on renonce au "Reprendre" en cours
      openEditor(page, "screen-camera");
    });
    cameraStrip.appendChild(img);
  }
  cameraStrip.scrollLeft = cameraStrip.scrollWidth; // la dernière prise reste visible
}

// --- Ouvrir la caméra (Scanner, Cachet, "Reprendre" ou "Ajouter une page") ---
const cameraOverlay = document.getElementById("camera-overlay");
let cameraSession = 0; // change à chaque ouverture/fermeture : une ouverture
                       // devenue obsolète (fermée pendant le démarrage) s'abandonne
async function openCamera() {
  const session = ++cameraSession;
  showScreen("screen-camera");
  cameraError.hidden = true;
  updateCameraDone();
  try {
    await startCamera(video);
    if (session !== cameraSession) {
      // L'utilisateur a fermé PENDANT le démarrage (ex. fenêtre
      // d'autorisation) : on coupe le flux qui vient d'arriver.
      stopCamera(video);
      return;
    }
    // Visée en direct : le cadre du document suit le flux vidéo.
    startLiveScan(video, cameraOverlay);
  } catch (err) {
    if (session !== cameraSession) return;
    cameraErrorText.textContent = describeCameraError(err);
    cameraError.hidden = false;
  }
}

// Traitement LOURD d'une page (détourage + filtre Auto). On le fait
// CAMÉRA COUPÉE, en lot, pour ne JAMAIS se battre avec la visée en direct
// sur le fil principal (c'était la cause des saccades).
async function processPage(page) {
  if (!page || page.processed) return;
  try {
    // 1) détourage/redressement (cadre de la visée si dispo, sinon détection)
    const r = await autoDewarp(page.original, page.hint);
    // 2) effet "Auto" (éclairage aplani) → image lisible pour l'OCR + le PDF.
    //    autoDewarp nous rend le canvas déjà décodé → pas de ré-décodage.
    const flatCanvas = r.canvas || (await imageToCanvas(r.dataUrl));
    const display = applyFilter(flatCanvas, page.filter || "auto");
    updatePage(page, { flat: r.dataUrl, display, corners: r.corners, processed: true });
  } catch (e) {
    console.error(e);
    // détourage impossible → au moins appliquer l'effet sur la photo brute
    try {
      const c = await imageToCanvas(page.original);
      const display = applyFilter(c, page.filter || "auto");
      updatePage(page, { flat: page.original, display, processed: true });
    } catch (_) {
      updatePage(page, { processed: true });
    }
  }
}

// Traite toutes les pages encore brutes, avec une progression claire.
async function processAllPages() {
  const todo = [];
  for (let i = 0; i < pageCount(); i++) {
    const p = getPage(i);
    if (p && !p.processed) todo.push(p);
  }
  if (!todo.length) return;
  for (let i = 0; i < todo.length; i++) {
    showBusy(`Traitement des pages… ${i + 1}/${todo.length}`);
    await processPage(todo[i]);
    await new Promise((r) => setTimeout(r, 0)); // laisse l'interface respirer
  }
  hideBusy();
}

// --- Fermer la caméra. Les pages déjà prises restent dans la liste
//     (rien n'est perdu) → liste si pages, sinon accueil. ---
async function closeCamera() {
  cameraSession++; // invalide une ouverture encore en cours de démarrage
  stopLiveScan(cameraOverlay);
  stopCamera(video);
  if (replacePage) {
    // On renonçait juste à refaire une photo → retour à l'éditeur.
    const page = replacePage;
    replacePage = null;
    openEditor(page, editorFrom);
    return;
  }
  await processAllPages();
  showScreen(pageCount() > 0 ? "screen-pages" : "screen-home");
}

function describeCameraError(err) {
  if (err && err.name === "NotAllowedError") {
    return "Accès à la caméra refusé. Autorisez-la dans les réglages du navigateur, puis réessayez.";
  }
  if (err && err.name === "NotFoundError") {
    return "Aucune caméra détectée sur cet appareil.";
  }
  return "Impossible d'accéder à la caméra. Vérifiez que la page est ouverte en HTTPS ou sur localhost.";
}

function setFilter(mode) {
  state.activeFilter = mode;
  const source = state.rotation
    ? rotateCanvas(state.croppedCanvas, state.rotation)
    : state.croppedCanvas;
  state.filteredImage = applyFilter(source, mode);
  resultImage.src = state.filteredImage;
  filterButtons.forEach((b) =>
    b.classList.toggle("filter-btn--active", b.dataset.filter === mode)
  );
}

function rotate(delta) {
  state.rotation = (state.rotation + delta + 360) % 360;
  setFilter(state.activeFilter);
}

// ===================================================================
// Branchement des boutons
// ===================================================================

// Accueil → "SkanZen" : la caméra (un seul parcours pour tout).
document.getElementById("btn-scan").addEventListener("click", openCamera);

// --- Téléversement d'images existantes (une ou plusieurs) ---
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Lecture impossible"));
    reader.readAsDataURL(file);
  });
}

// Convertit une image (data URL) en canvas pleine résolution, telle quelle.
function imageToCanvas(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d", { willReadFrequently: true }).drawImage(img, 0, 0);
      resolve(canvas);
    };
    img.onerror = () => reject(new Error("Image illisible"));
    img.src = dataUrl;
  });
}

// Transforme les fichiers choisis (images et/ou PDF) en une liste d'images.
// Un PDF est rendu page par page. Word/.docx non géré.
async function filesToImages(files) {
  const images = [];
  for (const file of files) {
    if (isPdf(file)) {
      showBusy("Lecture du PDF…");
      const pages = await pdfToImages(file, (i, total) =>
        showBusy(`Lecture du PDF… page ${i}/${total}`)
      );
      images.push(...pages);
    } else if (file.type.startsWith("image/")) {
      images.push(await readFileAsDataURL(file));
    } else {
      showToast(`« ${file.name} » n'est ni une image ni un PDF.`, 4500);
    }
  }
  return images;
}

// Accueil → "Téléverser" : images/PDF déjà scannés → directement la liste
// (pas de rognage : un fichier importé est déjà propre).
document.getElementById("file-input").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = ""; // permet de re-sélectionner les mêmes fichiers
  if (!files.length) return;
  try {
    const images = await filesToImages(files);
    hideBusy();
    if (!images.length) return;
    images.forEach((u) => addPage(u));
    invalidatePendingPdf();
    showScreen("screen-pages");
  } catch (err) {
    hideBusy();
    console.error(err);
    showToast("Impossible de lire ce fichier. " + (err.message || ""), 4500);
  }
});

// Liste → "Téléverser une page" : on réutilise le même sélecteur de
// fichiers que l'accueil (le gestionnaire ci-dessus ajoute les pages et
// reste sur la liste).
document.getElementById("btn-add-upload").addEventListener("click", () => {
  document.getElementById("file-input").click();
});

document.getElementById("btn-close-camera").addEventListener("click", closeCamera);
document.getElementById("btn-camera-back").addEventListener("click", closeCamera);
// Échec de chargement du moteur de détection → retour à l'éditeur (pas de cul-de-sac)
document.getElementById("btn-crop-loading-back").addEventListener("click", () => showScreen("screen-result"));

// Le contenu de la liste a changé → l'éventuel PDF préparé n'est plus valable.
function invalidatePendingPdf() {
  pendingPdf = null;
  pdfGeneration++;
  exportBtn.textContent = EXPORT_LABEL;
  exportBtn.classList.remove("btn-primary--ready");
}
// Suppressions / réordonnancements faits dans pages.js
document.addEventListener("pages-changed", invalidatePendingPdf);

// Caméra → capturer : chaque déclic ajoute une page AUTO-ROGNÉE.
// Le cadre détecté par la visée AU MOMENT du déclic sert de rognage
// ("ce que tu vois est ce que tu obtiens") ; le détourage tourne en
// arrière-plan, le déclencheur reste instantané.
document.getElementById("btn-capture").addEventListener("click", () => {
  // caméra coupée ou pas encore prête → pas de photo fantôme
  if (!video.srcObject || !video.videoWidth) return;
  const img = capturePhoto(video);
  const hint = getCurrentQuad(); // le cadre de la visée à cet instant

  // petit éclair blanc : confirme visuellement la prise
  const flash = document.getElementById("camera-flash");
  flash.classList.remove("is-on");
  void flash.offsetWidth; // relance l'animation
  flash.classList.add("is-on");

  // Cas "Reprendre cette photo" (depuis l'éditeur) : la nouvelle photo
  // REMPLACE la page, sans toucher au reste de la liste. L'éditeur la
  // traite (détourage + Auto) avant de l'afficher.
  if (replacePage) {
    const page = replacePage;
    replacePage = null;
    cameraSession++;
    stopLiveScan(cameraOverlay);
    stopCamera(video);
    updatePage(page, { original: img, hint, flat: img, display: img, corners: null, rotation: 0, filter: "auto", processed: false });
    invalidatePendingPdf();
    openEditor(page, editorFrom);
    return;
  }

  // Cas normal : on ajoute la photo BRUTE (déclencheur instantané, aucune
  // concurrence). Le détourage + Auto se fera au "Terminer", caméra coupée.
  addPage({ original: img, hint, flat: img, display: img, filter: "auto", processed: false });
  invalidatePendingPdf();
  updateCameraDone();
});

// Caméra → "Terminer" : caméra coupée, on traite tout le lot, puis la liste.
let cameraDoneRunning = false; // anti double-déclenchement (Entrée clavier…)
document.getElementById("btn-camera-done").addEventListener("click", async () => {
  if (cameraDoneRunning || pageCount() === 0) return;
  cameraDoneRunning = true;
  try {
    cameraSession++;
    replacePage = null; // terminer la session abandonne un "Reprendre" en cours
    stopLiveScan(cameraOverlay);
    stopCamera(video);
    await processAllPages();
    showScreen("screen-pages");
  } finally {
    cameraDoneRunning = false;
  }
});

// ===================================================================
// Éditeur de page (taper une vignette l'ouvre)
// ===================================================================

// Ouvre l'éditeur sur une page : on repart de sa base "flat" (rognée,
// avant rotation/filtre) et on ré-applique ses réglages enregistrés.
let editorSeq = 0; // si deux ouvertures se chevauchent, seule la dernière gagne
let pendingCrop = null; // rognage refait, en attente du "OK" (Annuler l'oublie)
async function openEditor(page, from) {
  if (!page) return;
  const seq = ++editorSeq;
  // page pas encore traitée (ouverte depuis la bande caméra) → on la
  // détoure + applique l'Auto d'abord.
  if (!page.processed) {
    showBusy("Traitement…");
    try {
      await processPage(page);
    } finally {
      hideBusy();
    }
    if (seq !== editorSeq) return;
  }
  const canvas = await imageToCanvas(page.flat);
  if (seq !== editorSeq) return; // une ouverture plus récente a pris la main
  editorPage = page;
  editorFrom = from;
  pendingCrop = null;
  state.croppedCanvas = canvas;
  state.rotation = page.rotation || 0;
  setFilter(page.filter || "original");
  showScreen("screen-result");
}

// Quitte l'éditeur : retour à la caméra ou à la liste.
function leaveEditor() {
  editorPage = null;
  if (editorFrom === "screen-camera") openCamera();
  else showScreen(pageCount() > 0 ? "screen-pages" : "screen-home");
}

// Liste → taper une vignette = APERÇU simple (visionneuse zoomable),
// sans édition. Le bouton ✎ de la carte ouvre l'éditeur.
document.addEventListener("page-preview", (e) => openViewer(getPages(), e.detail.index));
document.addEventListener("page-open", (e) => openEditor(getPage(e.detail.index), "screen-pages"));

// Filtres + rotation
filterButtons.forEach((b) =>
  b.addEventListener("click", () => setFilter(b.dataset.filter))
);
document.getElementById("btn-rotate-left").addEventListener("click", () => rotate(-90));
document.getElementById("btn-rotate-right").addEventListener("click", () => rotate(90));

// Éditeur → "Ajuster les coins" : écran de rognage sur la photo D'ORIGINE,
// en repartant des coins actuels (ou de ceux déjà refaits, en attente).
document.getElementById("btn-adjust-corners").addEventListener("click", async () => {
  if (!editorPage) return;
  showScreen("screen-crop");
  await initCrop(editorPage.original, (pendingCrop && pendingCrop.corners) || editorPage.corners);
});

// Rognage → "Annuler" : retour à l'éditeur sans rien changer.
document.getElementById("btn-crop-back").addEventListener("click", () => showScreen("screen-result"));

// Rognage → "Valider" : nouveau redressement, EN ATTENTE (il ne sera
// vraiment enregistré qu'au "OK" de l'éditeur — Annuler l'oublie).
document.getElementById("btn-crop-confirm").addEventListener("click", () => {
  try {
    const canvas = cropToCanvas();
    state.croppedCanvas = canvas;
    pendingCrop = {
      flat: canvas.toDataURL("image/jpeg", 0.95),
      corners: getCropCorners(),
    };
    setFilter(state.activeFilter);
    showScreen("screen-result");
  } catch (e) {
    console.error(e);
    showToast("Le redressement a échoué. Essaie de réajuster les coins.", 4500);
  }
});

// Éditeur → "Reprendre cette photo" : la prochaine photo remplace CETTE page.
document.getElementById("btn-result-retake").addEventListener("click", () => {
  if (!editorPage) return;
  replacePage = editorPage;
  openCamera();
});

// Éditeur → "OK" : enregistre tout d'un coup (rognage en attente compris).
document.getElementById("btn-add-to-list").addEventListener("click", () => {
  if (editorPage) {
    updatePage(editorPage, {
      ...(pendingCrop || {}),
      display: state.filteredImage,
      rotation: state.rotation,
      filter: state.activeFilter,
    });
    pendingCrop = null;
    invalidatePendingPdf();
  }
  leaveEditor();
});

// Éditeur → "Annuler" : ne change rien.
document.getElementById("btn-edit-cancel").addEventListener("click", leaveEditor);

// Liste → "+ Ajouter une page"
document.getElementById("btn-add-page").addEventListener("click", openCamera);

// ===================================================================
// Export PDF (parcours scan)
// ===================================================================

// La préférence OCR est mémorisée sur l'appareil.
const ocrToggle = document.getElementById("ocr-toggle");
ocrToggle.checked = localStorage.getItem("scanzen_ocr") !== "0";
ocrToggle.addEventListener("change", () => {
  localStorage.setItem("scanzen_ocr", ocrToggle.checked ? "1" : "0");
});

// Pendant la fabrication du PDF : on grise le reste de l'écran pour
// éviter les actions concurrentes (ajout de page, OCR relancé…).
function lockPagesScreen(on) {
  document.getElementById("screen-pages").classList.toggle("pages--locked", on);
}

// Petit panda de fin de scan 🐼 (avec "Scanzen" au-dessus).
function celebrate() {
  const c = document.getElementById("celebrate");
  c.hidden = false;
  clearTimeout(celebrate._t);
  celebrate._t = setTimeout(() => {
    c.hidden = true;
  }, 2200);
}
// taper le panda le fait disparaître tout de suite
document.getElementById("celebrate").addEventListener("click", () => {
  document.getElementById("celebrate").hidden = true;
});

// Après un export réussi : on vide la liste (le scan est terminé) et on
// revient à l'accueil — avec le panda.
function finishExport() {
  pendingPdf = null;
  exportBtn.textContent = EXPORT_LABEL;
  exportBtn.classList.remove("btn-primary--ready");
  clearPages();
  showScreen("screen-home");
  celebrate();
}

// Liste → "Exporter en PDF"
exportBtn.addEventListener("click", async () => {
  // 2e temps : un PDF est prêt → on le partage (appui = geste utilisateur frais).
  if (pendingPdf) {
    const delivered = await sharePdf(pendingPdf);
    if (delivered) finishExport(); // partagé → fin du scan
    return; // annulé → on garde le PDF pour réessayer
  }

  await processAllPages(); // garantit des pages détourées + aplanies
  const pages = getPages();
  if (pages.length === 0) return;
  const ocr = ocrToggle.checked;
  const gen = pdfGeneration; // pour détecter une modif de la liste pendant l'OCR

  exportBtn.disabled = true;
  lockPagesScreen(true);
  exportBtn.textContent = ocr ? "OCR en cours…" : "Création du PDF…";
  try {
    const blob = await buildPdf(pages, {
      ocr,
      onProgress: (i, total, p) => {
        exportBtn.textContent = `OCR ${i + 1}/${total} — ${Math.round((p || 0) * 100)}%`;
      },
    });
    if (ocr && gen !== pdfGeneration) {
      // La liste a changé pendant la fabrication : ce PDF est périmé.
      exportBtn.textContent = EXPORT_LABEL;
    } else if (ocr) {
      // L'OCR peut durer longtemps → l'autorisation de partage a expiré.
      // On garde le PDF et on attend un nouvel appui pour le partager.
      pendingPdf = blob;
      exportBtn.textContent = "📄 Partager le PDF";
      exportBtn.classList.add("btn-primary--ready");
      showToast("PDF prêt — appuie sur « Partager le PDF »", 4000);
    } else {
      exportBtn.textContent = EXPORT_LABEL;
      const delivered = await sharePdf(blob);
      if (delivered) finishExport();
    }
  } catch (e) {
    console.error(e);
    showToast("La création du PDF a échoué. Réessaie.", 4500);
    exportBtn.textContent = EXPORT_LABEL;
  } finally {
    exportBtn.disabled = false;
    lockPagesScreen(false);
  }
});

// ===================================================================
// Fiche cachet (contrat voix off) — formulaire + nom de fichier
// ===================================================================
const F = {
  projet: document.getElementById("f-projet"),
  studio: document.getElementById("f-studio"),
  employe: document.getElementById("f-employe"),
  da: document.getElementById("f-da"),
  date: document.getElementById("f-date"),
  lignes: document.getElementById("f-lignes"),
  brut: document.getElementById("f-brut"),
  net: document.getElementById("f-net"),
  role: document.getElementById("f-role"),
  type: document.getElementById("f-type"),
  cachets: document.getElementById("f-cachets"),
  heures: document.getElementById("f-heures"),
};
const fFilename = document.getElementById("f-filename");
const cachetBtn = document.getElementById("btn-cachet");
const cachetError = document.getElementById("cachet-error");

function currentFields() {
  return {
    projet: F.projet.value.trim(),
    studio: F.studio.value.trim(),
    employe: F.employe.value.trim(),
    da: F.da.value.trim(),
    date: F.date.value,
    lignes: F.lignes.value.trim(),
    brut: F.brut.value.trim(),
    net: F.net.value.trim(),
    role: F.role.value.trim() || "ND",
    typeProjet: F.type.value,
    nbCachet: F.cachets.value.trim(),
    nbHeures: F.heures.value.trim(),
  };
}

function refreshFilename() {
  fFilename.textContent = buildFilename(currentFields()) + ".pdf";
}
// le projet sert de 3e segment du nom quand il n'y a pas de DA
[F.date, F.studio, F.da, F.projet].forEach((el) =>
  el.addEventListener("input", refreshFilename)
);

// --- Montants : on accepte la virgule (clavier français) ET le point ---
function parseMoney(v) {
  const n = parseFloat(String(v || "").replace(/\s/g, "").replace(",", "."));
  return isFinite(n) ? n : NaN;
}
function formatMoney(n) {
  return n.toFixed(2).replace(".", ",");
}

// Montant net = estimation depuis le brut (≈ 78 %), sauf si saisi à la main.
// Le style italique/gris signale "estimé, pas lu sur le contrat".
const NET_PCT = 0.78; // à ajuster selon tes bulletins de paie (net ÷ brut)
let netManual = false;
function computeNet() {
  if (netManual) return;
  const brut = parseMoney(F.brut.value);
  F.net.value = isNaN(brut) ? "" : formatMoney(brut * NET_PCT);
  F.net.classList.toggle("input--est", F.net.value !== "");
}
F.brut.addEventListener("input", computeNet);
F.net.addEventListener("input", () => {
  netManual = true;
  F.net.classList.remove("input--est");
});

// --- L'employé "suit" le studio tant qu'on ne l'a pas modifié à la main
//     (même principe que netManual pour le montant net). ---
let employeFollows = true;
F.studio.addEventListener("input", () => {
  if (employeFollows) F.employe.value = F.studio.value;
});
F.employe.addEventListener("input", () => {
  employeFollows = false;
});
document.getElementById("btn-copy-studio").addEventListener("click", (e) => {
  e.preventDefault(); // bouton dans un <label> : ne pas voler le focus
  F.employe.value = F.studio.value;
  employeFollows = true;
});

// --- Nb d'heure = 12 h par cachet (estimation), sauf si saisi à la main.
//     Même principe que le net : tant qu'on n'a pas touché le champ, il
//     suit le nombre de cachets. ---
const HOURS_PER_CACHET = 12;
let heuresManual = false;
function computeHeures() {
  if (heuresManual) return;
  const n = parseInt(F.cachets.value, 10);
  F.heures.value = isFinite(n) && n > 0 ? String(n * HOURS_PER_CACHET) : "";
}
F.cachets.addEventListener("input", computeHeures);
F.heures.addEventListener("input", () => { heuresManual = true; });

// --- Entrée / "Suivant" du clavier = passer au champ suivant ---
const fieldOrder = [F.studio, F.employe, F.projet, F.da, F.role, F.date, F.lignes, F.cachets, F.heures, F.brut, F.net];
fieldOrder.forEach((el, i) => {
  el.setAttribute("enterkeyhint", i < fieldOrder.length - 1 ? "next" : "done");
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && fieldOrder[i + 1]) {
      e.preventDefault();
      fieldOrder[i + 1].focus();
    }
  });
});

function fillForm(f) {
  netManual = false;
  employeFollows = !f.employe || f.employe === f.studio;
  F.projet.value = f.projet || "";
  F.studio.value = f.studio || "";
  F.employe.value = f.employe || "";
  F.da.value = f.da || "";
  F.date.value = f.date || "";
  F.lignes.value = f.lignes || "";
  F.brut.value = toComma(f.brut || "");
  F.net.value = toComma(f.net || "");
  F.net.classList.remove("input--est");
  if (!F.net.value) computeNet(); // estime le net si absent
  F.role.value = f.role || "ND";
  // Type de projet : on garde le choix précédent (souvent constant sur un
  // même lot). Nb de cachet / Nb d'heure : on repart des valeurs par
  // défaut (1 cachet → 12 h) pour chaque nouveau contrat.
  heuresManual = false;
  F.cachets.value = "1";
  computeHeures(); // → 12 h
  refreshFilename();
}

// --- Vignettes du contrat en cours + visionneuse plein écran ---
const stripEl = document.getElementById("contract-strip");
const viewerEl = document.getElementById("viewer");
const viewerScroll = document.getElementById("viewer-scroll");

function renderContractStrip(c) {
  stripEl.innerHTML = "";
  const pages = (c && c.pages) || [];
  stripEl.hidden = pages.length === 0;
  pages.forEach((url, i) => {
    const img = document.createElement("img");
    img.src = url;
    img.alt = "Page " + (i + 1);
    img.addEventListener("click", () => openViewer(pages, i));
    stripEl.appendChild(img);
  });
}

function openViewer(pages, start) {
  viewerScroll.innerHTML = "";
  pages.forEach((url) => {
    const img = document.createElement("img");
    img.src = url;
    // taper sur l'image = zoom ×2,2 (on fait défiler pour se déplacer)
    img.addEventListener("click", () => viewerEl.classList.toggle("viewer--zoom"));
    viewerScroll.appendChild(img);
  });
  viewerEl.hidden = false;
  requestAnimationFrame(() => {
    const target = viewerScroll.children[start];
    if (target) target.scrollIntoView();
  });
}
function closeViewer() {
  viewerEl.hidden = true;
  viewerEl.classList.remove("viewer--zoom");
}
document.getElementById("btn-viewer-close").addEventListener("click", closeViewer);

// ===================================================================
// Découpage intelligent : 1 lot de pages → 1 ou plusieurs contrats
// ===================================================================
// On OCRise chaque page, on PROPOSE un découpage (1 contrat = 1 ou
// plusieurs pages), tu ajustes, puis on traite chaque contrat l'un
// après l'autre (1 PDF + 1 ligne chacun).

let pageTexts = [];        // texte OCR de chaque page (même ordre que cachetPages)
let cachetItems = [];      // [{ url, text, n }] — une entrée par page du lot
let cachetGroups = [];     // [[item, …], …] — un tableau de pages par contrat
let cachetContracts = [];  // [{ pages:[dataURL], text }]
let cachetIndex = 0;       // contrat en cours de saisie

const splitListEl = document.getElementById("split-list");
const splitCountEl = document.getElementById("split-count");

// OCR de toutes les pages, avec voile de progression ANNULABLE.
// Renvoie false si l'utilisateur a annulé.
async function ocrAllPages() {
  const pages = cachetPages;
  pageTexts = [];
  let cancelled = false;
  showBusy("Analyse du texte…", () => {
    cancelled = true;
    showBusy("Annulation…", null); // null : cache aussi le bouton Annuler
  });
  for (let i = 0; i < pages.length; i++) {
    if (cancelled) break;
    showBusy(`Analyse du texte… page ${i + 1}/${pages.length}`);
    try {
      const lines = await ocrPage(pages[i], (p) => {
        // la page en cours continue de tourner après "Annuler" : ne pas
        // écraser le message "Annulation…"
        if (!cancelled) {
          showBusy(`Analyse du texte… page ${i + 1}/${pages.length} — ${Math.round((p || 0) * 100)}%`);
        }
      });
      pageTexts.push(lines.map((l) => l.text).join("\n"));
    } catch (e) {
      console.error(e);
      pageTexts.push("");
    }
  }
  try { await terminateOcr(); } catch (e) { /* libère la mémoire OCR */ }
  return !cancelled;
}

// Propose un découpage initial : une page qui "ressemble à un début de
// contrat" ouvre un nouveau groupe, les autres suivent la précédente.
// L'utilisateur réarrange ensuite librement (glisser-déposer, ✕).
function buildInitialGroups() {
  cachetItems = cachetPages.map((url, i) => ({
    url,
    text: pageTexts[i] || "",
    n: i + 1, // numéro de page d'origine (affiché sur la vignette)
  }));
  cachetGroups = [];
  cachetItems.forEach((item, i) => {
    if (i === 0 || isContractStart(item.text)) cachetGroups.push([item]);
    else cachetGroups[cachetGroups.length - 1].push(item);
  });
}

// Transforme les groupes en contrats prêts à traiter.
function buildContracts() {
  return cachetGroups.map((g) => ({
    pages: g.map((it) => it.url),
    text: g.map((it) => it.text).join("\n"),
  }));
}

// Lance le parcours cachet sur un lot d'images : OCR → découpage (ou
// directement le formulaire s'il n'y a qu'une page).
async function startCachetFlow(images) {
  if (!images || !images.length) return;
  cachetPages = images;
  sentFirstPages = new Set(); // nouveau lot → on repart de zéro
  skippedFirstPages = new Set();
  sentLog = [];
  batchConfirmed = true;
  let ok;
  try {
    ok = await ocrAllPages();
  } finally {
    hideBusy();
  }
  if (!ok) {
    // Annulé : retour à la liste (les pages sont conservées).
    showScreen("screen-pages");
    return;
  }
  buildInitialGroups();
  if (cachetPages.length <= 1) {
    cachetContracts = buildContracts();
    startCachetContract(0);
  } else {
    renderSplit();
    setStep("decoupage");
    showScreen("screen-split");
  }
}

// Liste → bouton PANDA : envoie les pages dans l'analyse cachet.
cachetBtn.addEventListener("click", async () => {
  if (pageCount() === 0) return;
  // export PDF en cours → on ne lance pas deux gros traitements à la fois
  if (document.getElementById("screen-pages").classList.contains("pages--locked")) return;
  await processAllPages(); // garantit des images détourées + aplanies pour l'OCR
  await startCachetFlow(getPages());
});

// Dessine l'écran de découpage : une CARTE par contrat, avec ses pages en
// vignettes. On GLISSE une page d'une carte à l'autre (ou vers le carré
// "Nouveau contrat") pour réorganiser ; la pastille ✕ retire une page.
function renderSplit() {
  splitListEl.innerHTML = "";
  // Après un premier envoi, on FIGE le découpage : réorganiser mélangerait
  // des contrats déjà rangés dans Drive avec d'autres.
  const locked = sentLog.length > 0;

  cachetGroups.forEach((group, gi) => {
    const card = document.createElement("div");
    card.className = "ct-card";
    card.dataset.gi = String(gi); // index du groupe → cible de dépôt
    const isSent = sentFirstPages.has(group[0].url);
    const isSkipped = skippedFirstPages.has(group[0].url);

    // En-tête : numéro + "Contrat N" + nb de pages / statut
    const head = document.createElement("div");
    head.className = "ct-card__head";
    const badge = document.createElement("span");
    badge.className = "ct-card__badge";
    badge.textContent = String(gi + 1);
    const title = document.createElement("span");
    title.className = "ct-card__title";
    title.textContent = "Contrat " + (gi + 1);
    const meta = document.createElement("span");
    meta.className = "ct-card__meta";
    meta.textContent = isSent
      ? "· ✓ envoyé"
      : isSkipped
        ? "· ignoré"
        : "· " + group.length + (group.length > 1 ? " pages" : " page");
    head.append(badge, title, meta);
    card.appendChild(head);

    // Vignettes des pages du contrat
    const pagesRow = document.createElement("div");
    pagesRow.className = "ct-card__pages";
    group.forEach((item) => pagesRow.appendChild(makeSplitThumb(item, locked)));
    card.appendChild(pagesRow);

    splitListEl.appendChild(card);
  });

  // Carré "Nouveau contrat" : on y dépose une page pour séparer un contrat.
  if (!locked && cachetGroups.length > 0) {
    const zone = document.createElement("div");
    zone.className = "ct-new-zone";
    zone.id = "ct-new-zone";
    zone.textContent = "➕ Nouveau contrat — dépose une page ici";
    splitListEl.appendChild(zone);
  }

  const n = cachetGroups.length;
  splitCountEl.textContent = n + (n <= 1 ? " contrat" : " contrats");
  document.getElementById("btn-split-confirm").disabled = n === 0;
}

// Fabrique la vignette d'une page : numéro, pastille ✕, et glisser-déposer.
function makeSplitThumb(item, locked) {
  const cell = document.createElement("div");
  cell.className = "ct-thumb";
  const img = document.createElement("img");
  img.src = item.url;
  img.alt = "Page " + item.n;
  img.draggable = false; // on gère le glisser nous-mêmes (tactile compris)
  const n = document.createElement("span");
  n.className = "ct-thumb__n";
  n.textContent = String(item.n);
  cell.append(img, n);
  if (!locked) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ct-thumb__del";
    del.setAttribute("aria-label", "Retirer cette page");
    del.textContent = "✕";
    del.addEventListener("pointerdown", (e) => e.stopPropagation());
    del.addEventListener("click", () => removeSplitItem(item));
    cell.appendChild(del);
    cell.addEventListener("pointerdown", (e) => startThumbDrag(e, item, cell));
  }
  return cell;
}

// Retire une page du lot (elle ne sera ni envoyée, ni dans le PDF).
function removeSplitItem(item) {
  for (const g of cachetGroups) {
    const i = g.indexOf(item);
    if (i !== -1) {
      g.splice(i, 1);
      break;
    }
  }
  cachetGroups = cachetGroups.filter((g) => g.length > 0); // groupes vides → supprimés
  renderSplit();
  showToast(`Page ${item.n} retirée`);
}

// --- Glisser-déposer d'une vignette vers une autre carte ---
let thumbDrag = null; // { item, cell, ghost, target, startX, startY }

function startThumbDrag(e, item, cell) {
  e.preventDefault();
  try {
    cell.setPointerCapture(e.pointerId);
  } catch (_) {} // pointeur synthétique (tests) : pas grave
  thumbDrag = { item, cell, ghost: null, target: null, startX: e.clientX, startY: e.clientY };
  const onMove = (ev) => thumbDragMove(ev);
  const onUp = (ev) => {
    cell.removeEventListener("pointermove", onMove);
    cell.removeEventListener("pointerup", onUp);
    cell.removeEventListener("pointercancel", onUp);
    thumbDragEnd(ev);
  };
  cell.addEventListener("pointermove", onMove);
  cell.addEventListener("pointerup", onUp);
  cell.addEventListener("pointercancel", onUp);
}

function thumbDragMove(e) {
  if (!thumbDrag) return;
  // On ne "soulève" la vignette qu'après un petit déplacement (sinon un
  // simple appui la ferait bouger).
  if (!thumbDrag.ghost) {
    if (Math.hypot(e.clientX - thumbDrag.startX, e.clientY - thumbDrag.startY) < 8) return;
    const ghost = document.createElement("img");
    ghost.src = thumbDrag.item.url;
    ghost.className = "drag-ghost";
    document.body.appendChild(ghost);
    thumbDrag.ghost = ghost;
    thumbDrag.cell.classList.add("ct-thumb--dragging");
  }
  thumbDrag.ghost.style.left = e.clientX + "px";
  thumbDrag.ghost.style.top = e.clientY + "px";

  // Près du bord haut/bas ? On fait défiler la liste pour atteindre les
  // cartes hors écran.
  if (e.clientY > window.innerHeight - 80) splitListEl.scrollTop += 14;
  else if (e.clientY < 140) splitListEl.scrollTop -= 14;

  // Quelle carte est sous le doigt ? (le fantôme est insensible aux clics)
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const target = under ? under.closest(".ct-card, .ct-new-zone") : null;
  if (thumbDrag.target && thumbDrag.target !== target) {
    thumbDrag.target.classList.remove("ct-card--target");
  }
  thumbDrag.target = target;
  if (target) target.classList.add("ct-card--target");
}

function thumbDragEnd() {
  if (!thumbDrag) return;
  const { item, cell, ghost, target } = thumbDrag;
  thumbDrag = null;
  if (ghost) ghost.remove();
  cell.classList.remove("ct-thumb--dragging");
  if (!ghost || !target) return; // simple appui ou lâché dans le vide
  target.classList.remove("ct-card--target");

  // Retire la page de son groupe d'origine…
  let from = -1;
  for (let g = 0; g < cachetGroups.length; g++) {
    const i = cachetGroups[g].indexOf(item);
    if (i !== -1) {
      from = g;
      cachetGroups[g].splice(i, 1);
      break;
    }
  }
  if (from === -1) return;

  // …et dépose-la sur la cible.
  if (target.id === "ct-new-zone") {
    cachetGroups.push([item]);
  } else {
    const gi = Number(target.dataset.gi);
    if (Number.isInteger(gi) && cachetGroups[gi]) cachetGroups[gi].push(item);
    else cachetGroups[from].splice(0, 0, item); // cible disparue → on remet
  }
  cachetGroups = cachetGroups.filter((g) => g.length > 0);
  renderSplit();
}

// Quitte le parcours cachet (avec confirmation si des contrats non
// envoyés seraient perdus), puis nettoie l'état. Si des contrats ont déjà
// été envoyés, on passe par l'écran de confirmation (récapitulatif honnête).
function leaveCachetFlow() {
  const total = cachetContracts.length;
  const handled = sentFirstPages.size + skippedFirstPages.size;
  const unsentRemain = total === 0 || handled < total; // 0 = découpage pas encore validé
  // Après un envoi PARTIEL, quitter abandonne les contrats restants → on confirme.
  if (sentLog.length > 0 && unsentRemain) {
    if (!confirm("Abandonner les contrats restants (non envoyés) ?")) return;
  }
  cachetPages = [];
  cachetContracts = [];
  cachetItems = [];
  cachetGroups = [];
  if (sentLog.length > 0) {
    // Quelque chose a bien été envoyé → récapitulatif plutôt que silence.
    renderDone();
    setStep("envoi");
    showScreen("screen-done");
    return;
  }
  showScreen("screen-pages");
}

document.getElementById("btn-split-back").addEventListener("click", leaveCachetFlow);
document.getElementById("btn-split-confirm").addEventListener("click", () => {
  cachetContracts = buildContracts();
  startCachetContract(0);
});

// Fin du lot cachet : écran de confirmation (si au moins un envoi),
// sinon simple retour à l'écran d'origine (rien n'est effacé).
function finishCachet() {
  const sentSomething = sentLog.length > 0;
  // On ne vide la liste de scans QUE si quelque chose a bien été envoyé.
  if (sentSomething) clearPages();
  cachetPages = [];
  pendingPdf = null;
  exportBtn.textContent = EXPORT_LABEL;
  exportBtn.classList.remove("btn-primary--ready");
  if (!sentSomething) {
    showScreen("screen-pages"); // ex. tout a été "ignoré" → pages conservées
    return;
  }
  renderDone();
  setStep("envoi");
  showScreen("screen-done");
}

// Remplit l'écran de confirmation avec les contrats envoyés.
function renderDone() {
  const n = sentLog.length;
  document.getElementById("done-title").textContent =
    n > 1 ? `${n} contrats envoyés` : "Contrat envoyé";
  // Honnêteté : en mode "aveugle" (vieux déploiement du connecteur), on ne
  // peut pas confirmer la réception côté Google.
  document.querySelector("#screen-done .done__sub").textContent = batchConfirmed
    ? "Rangé dans Drive + ajouté à la feuille."
    : "Envoyé — vérifie la feuille (réception non confirmée).";
  const list = document.getElementById("done-list");
  list.innerHTML = "";
  sentLog.forEach((entry) => {
    const li = document.createElement("li");
    li.className = "done__item";
    const ck = document.createElement("span");
    ck.className = "done__item-check";
    ck.textContent = "✓";
    const name = document.createElement("span");
    name.className = "done__item-name";
    name.textContent = entry.filename;
    li.append(ck, name);
    list.appendChild(li);
  });
}
document.getElementById("btn-done-home").addEventListener("click", () => {
  sentLog = [];
  showScreen("screen-home");
});

// Affiche le formulaire pré-rempli pour le contrat n° i du lot. Saute les
// contrats déjà envoyés ou ignorés (anti-doublon si on revient en arrière)
// et termine le lot s'il n'en reste plus.
function startCachetContract(i) {
  while (
    cachetContracts[i] &&
    (sentFirstPages.has(cachetContracts[i].pages[0]) ||
      skippedFirstPages.has(cachetContracts[i].pages[0]))
  ) {
    i++;
  }
  if (i >= cachetContracts.length) {
    finishCachet();
    return;
  }
  cachetIndex = i;
  const total = cachetContracts.length;
  const c = cachetContracts[i];
  fillForm(extractFields(c.text || ""));
  renderContractStrip(c);
  cachetError.hidden = true;
  document.getElementById("contract-count").textContent =
    total > 1 ? `Contrat ${i + 1} sur ${total}` : "";
  document.getElementById("step-fiches-count").textContent =
    total > 1 ? ` ${i + 1}/${total}` : "";
  document.getElementById("btn-cachet-save").textContent =
    total > 1 ? `Enregistrer (${i + 1}/${total})` : "Enregistrer";
  document.getElementById("btn-cachet-skip").hidden = total <= 1;
  refreshConnectorState();
  setStep("fiches");
  showScreen("screen-contract");
}

// "Ignorer ce contrat" : ne pas l'envoyer, passer au suivant.
document.getElementById("btn-cachet-skip").addEventListener("click", () => {
  const c = cachetContracts[cachetIndex];
  if (c && c.pages[0]) skippedFirstPages.add(c.pages[0]);
  startCachetContract(cachetIndex + 1);
});

// Formulaire → "Ré-extraire (OCR)" : ré-applique l'extraction au contrat courant.
document.getElementById("btn-prefill").addEventListener("click", async () => {
  const c = cachetContracts[cachetIndex];
  if (!c) return;
  const btn = document.getElementById("btn-prefill");
  const label = btn.textContent;
  btn.disabled = true;
  try {
    let text = c.text;
    if (!text || !text.trim()) { // texte vide OU blanc (OCR raté) → on refait
      let acc = "";
      for (let i = 0; i < c.pages.length; i++) {
        btn.textContent = `Analyse ${i + 1}/${c.pages.length}…`;
        const lines = await ocrPage(c.pages[i]);
        acc += lines.map((l) => l.text).join("\n") + "\n";
      }
      c.text = text = acc.trim();
    }
    // si l'utilisateur a changé de contrat pendant l'analyse, on ne remplit pas
    if (cachetContracts[cachetIndex] !== c) return;
    fillForm(extractFields(text));
  } catch (e) {
    console.error(e);
    showToast("L'analyse OCR a échoué. Tu peux remplir la fiche à la main.", 4500);
  } finally {
    btn.textContent = label;
    btn.disabled = false;
  }
});

// Retour depuis le formulaire : vers le découpage (si lot, rien n'est
// perdu) ou sortie du parcours (avec confirmation au besoin).
document.getElementById("btn-cachet-back").addEventListener("click", () => {
  if (cachetContracts.length > 1) {
    setStep("decoupage");
    showScreen("screen-split");
    return;
  }
  leaveCachetFlow();
});

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Lecture du PDF impossible"));
    r.readAsDataURL(blob);
  });
}

// ===================================================================
// Connecteur Google (Apps Script) — réglage + envoi
// ===================================================================

// L'URL /exec est stockée sur l'appareil (pas dans le code public).
function connectorUrl() {
  return localStorage.getItem("scanzen_gas_url") || "";
}
function refreshConnectorState() {
  document.getElementById("connector-state").textContent = connectorUrl()
    ? "configuré ✓"
    : "à configurer";
  document.getElementById("connector-url").value = connectorUrl();
}
document.getElementById("btn-connector-save").addEventListener("click", () => {
  const v = document.getElementById("connector-url").value.trim();
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(v)) {
    showToast("L'URL doit commencer par https://script.google.com et finir par /exec", 4500);
    return;
  }
  localStorage.setItem("scanzen_gas_url", v);
  refreshConnectorState();
  document.getElementById("connector").open = false;
  showToast("Connecteur enregistré ✓");
});

// Envoie le contrat au connecteur. Renvoie true si la réception est
// CONFIRMÉE par Google, false si l'envoi est parti mais que le
// navigateur n'a pas pu lire la réponse. Lance une erreur si le réseau
// est indisponible (l'envoi n'est PAS parti → l'utilisateur réessaie).
//
// ⚠️ Important : un POST en text/plain est une "requête simple" — le
// navigateur l'ENVOIE toujours, même s'il refuse ensuite de nous montrer
// la réponse. Il ne faut donc JAMAIS renvoyer le même contrat en repli
// (cela créerait un doublon dans Drive). En cas de réponse illisible, on
// sonde simplement la connexion avec un GET sans effet de bord.
async function postToConnector(url, payload) {
  const body = JSON.stringify(payload);
  const headers = { "Content-Type": "text/plain;charset=utf-8" };
  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body });
  } catch (e) {
    try {
      await fetch(url, { method: "GET", mode: "no-cors", cache: "no-store" });
      return false; // le serveur répond → le POST est parti, juste non confirmé
    } catch (e2) {
      throw new Error("Réseau indisponible"); // rien n'est parti → réessayer
    }
  }
  if (!res.ok) throw new Error("HTTP " + res.status);
  return true;
}

// Fiche → "Enregistrer" : envoie le contrat COURANT au connecteur Google,
// puis passe au contrat suivant du lot (ou termine).
document.getElementById("btn-cachet-save").addEventListener("click", async () => {
  const url = connectorUrl();
  if (!url) {
    // Pas encore configuré : on ouvre le panneau au lieu d'un prompt().
    const panel = document.getElementById("connector");
    panel.open = true;
    panel.scrollIntoView({ block: "center" });
    document.getElementById("connector-url").focus();
    showToast("Règle d'abord le connecteur Google ⚙️", 4000);
    return;
  }

  const f = currentFields();
  // Montants : on valide ET on normalise ("1 234.5" → "1234,50").
  const brutN = f.brut ? parseMoney(f.brut) : NaN;
  if (f.brut && isNaN(brutN)) {
    showToast("Montant brut illisible (exemple attendu : 290,07)", 4500);
    return;
  }
  const netN = f.net ? parseMoney(f.net) : NaN;
  if (f.net && isNaN(netN)) {
    showToast("Montant net illisible (exemple attendu : 226,25)", 4500);
    return;
  }
  const filename = buildFilename(f) + ".pdf";
  const total = cachetContracts.length || 1;
  const c = cachetContracts[cachetIndex] || { pages: cachetPages };
  const btn = document.getElementById("btn-cachet-save");
  cachetError.hidden = true;
  btn.disabled = true;
  btn.textContent = "Envoi…";
  try {
    const blob = await buildPdf(c.pages, { ocr: false });
    const pdfBase64 = (await blobToDataURL(blob)).split(",")[1];
    const payload = {
      filename,
      annee: f.date ? f.date.slice(0, 4) : String(new Date().getFullYear()),
      date: f.date, typeProjet: f.typeProjet, projet: f.projet,
      studio: f.studio, employe: f.employe, da: f.da, role: f.role,
      lignes: f.lignes, nbCachet: f.nbCachet, nbHeures: f.nbHeures,
      // virgule décimale, sans espaces → la feuille reconnaît le montant (€)
      brut: f.brut ? formatMoney(brutN) : "",
      net: f.net ? formatMoney(netN) : "",
      pdfBase64,
    };
    const confirmed = await postToConnector(url, payload);
    batchConfirmed = batchConfirmed && confirmed;
    if (c.pages && c.pages[0]) sentFirstPages.add(c.pages[0]); // anti-doublon
    sentLog.push({ filename });
    if (total > 1) showToast(`Contrat ${cachetIndex + 1}/${total} envoyé ✓`);
    startCachetContract(cachetIndex + 1); // contrat suivant (ou fin du lot)
  } catch (e) {
    console.error(e);
    cachetError.hidden = false; // bandeau : saisies conservées, réessaie
    btn.textContent = total > 1 ? `Enregistrer (${cachetIndex + 1}/${total})` : "Enregistrer";
  } finally {
    btn.disabled = false;
  }
});

// ===================================================================
// Bouton retour du téléphone : navigue dans l'app au lieu de la quitter
// ===================================================================
// On garde UN cran d'historique en réserve ; un appui "retour" revient à
// l'écran précédent (même logique que les boutons à l'écran). Sur
// l'accueil, un 2e appui quitte réellement.
let backTrapped = false;
function trapBack() {
  if (!backTrapped) {
    history.pushState({ scanzen: true }, "");
    backTrapped = true;
  }
}
window.addEventListener("popstate", () => {
  backTrapped = false;
  // Opération en cours (OCR, fabrication du PDF…) : on ignore le retour.
  if (!busy.hidden ||
      document.getElementById("screen-pages").classList.contains("pages--locked")) {
    trapBack();
    return;
  }
  if (!viewerEl.hidden) {
    // la visionneuse est ouverte → le retour la ferme
    closeViewer();
    trapBack();
    return;
  }
  const active = document.querySelector(".screen--active");
  const id = active ? active.id : "screen-home";
  if (id === "screen-home") return; // accueil : l'appui suivant sort vraiment
  goBackFrom(id);
  trapBack();
});
function goBackFrom(id) {
  if (id === "screen-camera") closeCamera();
  else if (id === "screen-crop") showScreen("screen-result"); // rognage → éditeur
  else if (id === "screen-result") document.getElementById("btn-edit-cancel").click();
  else if (id === "screen-pages") showScreen("screen-home"); // les pages restent en mémoire
  else if (id === "screen-split") leaveCachetFlow();
  else if (id === "screen-contract") document.getElementById("btn-cachet-back").click();
  else if (id === "screen-done") document.getElementById("btn-done-home").click();
  else showScreen("screen-home");
}

// État initial du panneau connecteur.
refreshConnectorState();

// --- PWA : enregistre le service worker (installation + hors-ligne) ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("service-worker.js", { updateViaCache: "none" })
      .catch((err) => console.warn("Service worker non enregistré :", err));
  });
}
