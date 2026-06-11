// ===================================================================
// app.js — le "chef d'orchestre" de Scanzen.
//
// Il coordonne les écrans et l'état de l'app, et délègue le travail
// spécialisé aux autres fichiers (camera, scanner, filters, pages, pdf).
// ===================================================================

import { startCamera, stopCamera, capturePhoto } from "./camera.js";
import { initCrop, cropToCanvas } from "./scanner.js";
import { applyFilter } from "./filters.js";
import { addPage, pageCount, getPages, clearPages } from "./pages.js";
import { buildPdf, sharePdf } from "./pdf.js";
import { ocrPage, terminateOcr } from "./ocr.js";
import { extractFields, buildFilename, isContractStart } from "./contract.js";
import { pdfToImages, isPdf } from "./pdfimport.js";

// --- État partagé de l'app ---
const state = {
  capturedImage: null, // photo brute prise par la caméra
  croppedCanvas: null, // le rognage (canvas plein résolution, avant filtre)
  filteredImage: null, // rognage + rotation + filtre (ce qui sera ajouté)
  activeFilter: "auto", // mode de filtre courant
  rotation: 0, // rotation appliquée au résultat (0, 90, 180, 270)
  fromImport: false, // la page affichée vient d'un téléversement (pas de la caméra)
};

let pendingPdf = null; // PDF préparé, en attente d'un appui pour le partager
let pdfGeneration = 0; // change à chaque modif de la liste → invalide un PDF en cours
const EXPORT_LABEL = "Exporter en PDF";

// --- Mode de la caméra / parcours cachet ---
let cameraMode = "scan";                  // "scan" (Scanner) ou "cachet" (Contrat)
let cachetPages = [];                     // images du lot cachet en cours (≠ pages scan)
let cachetReturnScreen = "screen-home";   // où revenir depuis le découpage
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
const previewImage = document.getElementById("preview-image");
const resultImage = document.getElementById("result-image");
const filterButtons = document.querySelectorAll(".filter-btn");
const exportBtn = document.getElementById("btn-export");
const resultRetakeBtn = document.getElementById("btn-result-retake");

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

// En mode cachet : bouton "Terminer (N)", consigne et vignettes des pages.
function updateCameraDone() {
  const done = document.getElementById("btn-camera-done");
  if (cameraMode === "cachet") {
    done.hidden = false;
    done.disabled = cachetPages.length === 0;
    done.textContent = `Terminer (${cachetPages.length})`;
  } else {
    done.hidden = true;
  }
  document.getElementById("camera-hint").hidden =
    !(cameraMode === "cachet" && cachetPages.length === 0);
  updateCachetStrip();
}

// Reconstruit la bande de vignettes des pages déjà prises (mode cachet).
const cameraStrip = document.getElementById("camera-strip");
function updateCachetStrip() {
  const show = cameraMode === "cachet" && cachetPages.length > 0;
  cameraStrip.hidden = !show;
  cameraStrip.innerHTML = "";
  if (!show) return;
  cachetPages.forEach((url, i) => {
    const img = document.createElement("img");
    img.src = url;
    img.alt = "Page " + (i + 1);
    cameraStrip.appendChild(img);
  });
  cameraStrip.scrollLeft = cameraStrip.scrollWidth; // la dernière prise reste visible
}

// --- Ouvrir la caméra (Scanner, Cachet, "Reprendre" ou "Ajouter une page") ---
async function openCamera() {
  showScreen("screen-camera");
  cameraError.hidden = true;
  updateCameraDone();
  try {
    await startCamera(video);
  } catch (err) {
    cameraErrorText.textContent = describeCameraError(err);
    cameraError.hidden = false;
  }
}

// --- Fermer la caméra. En mode cachet : on confirme si des pages ont déjà
//     été prises (sinon elles seraient perdues), puis retour accueil. Sinon
//     → liste si pages, sinon accueil. ---
function closeCamera() {
  if (cameraMode === "cachet" && cachetPages.length > 0) {
    const n = cachetPages.length;
    if (!confirm(`Quitter sans traiter ${n} page${n > 1 ? "s" : ""} ? Elles seront perdues.`)) {
      return; // l'utilisateur annule → on reste sur la caméra
    }
  }
  stopCamera(video);
  if (cameraMode === "cachet") {
    cachetPages = [];
    cameraMode = "scan";
    showScreen("screen-home");
    return;
  }
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

// --- Écran résultat : applique rotation + filtre au rognage ---
function showResult() {
  setFilter(state.activeFilter || "auto");
  // Pour un fichier téléversé, "Reprendre" (la caméra) n'a pas de sens :
  // on propose plutôt d'ignorer la page.
  resultRetakeBtn.textContent = state.fromImport ? "Ignorer cette page" : "Reprendre";
  showScreen("screen-result");
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

// Accueil → bulle "Scanner" : caméra en mode scan (document → PDF).
document.getElementById("btn-scan").addEventListener("click", () => {
  cameraMode = "scan";
  openCamera();
});

// Accueil → bulle "Cachet" : caméra en mode cachet (contrat → découpage).
document.getElementById("btn-cachet-home").addEventListener("click", () => {
  cameraMode = "cachet";
  cachetPages = [];
  cachetReturnScreen = "screen-home";
  openCamera();
});

// --- Téléversement d'images existantes (une ou plusieurs) ---
let importQueue = [];

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

// Charge le fichier suivant de la file. Un fichier téléversé est DÉJÀ
// scanné → on saute le recadrage et on le prend tel quel (image entière),
// directement à l'écran résultat (filtre / rotation restent disponibles).
async function startNextImport() {
  if (!importQueue.length) return;
  const img = importQueue.shift();
  state.capturedImage = img;
  try {
    state.croppedCanvas = await imageToCanvas(img);
  } catch (e) {
    console.error(e);
    showToast("Un fichier n'a pas pu être ouvert.", 4000);
    if (importQueue.length) startNextImport();
    // fin du lot sur un échec : ne pas rester sur un écran résultat périmé
    else showScreen(pageCount() > 0 ? "screen-pages" : "screen-home");
    return;
  }
  state.rotation = 0;
  state.activeFilter = "original"; // déjà scanné → on n'altère rien par défaut
  state.fromImport = true;
  showResult();
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

// Accueil → "Scanner > Téléverser" : images/PDF → parcours scan (sans rognage).
document.getElementById("file-input").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = ""; // permet de re-sélectionner les mêmes fichiers
  if (!files.length) return;
  cameraMode = "scan"; // le "Reprendre" de l'écran résultat doit rester en mode scan
  try {
    const images = await filesToImages(files);
    hideBusy();
    if (!images.length) return;
    importQueue = images;
  } catch (err) {
    hideBusy();
    console.error(err);
    showToast("Impossible de lire ce fichier. " + (err.message || ""), 4500);
    return;
  }
  startNextImport();
});

// Accueil → "Cachet > Téléverser" : images/PDF → DIRECTEMENT le découpage
// (pas de rognage, pas d'écran filtre).
document.getElementById("cachet-file-input").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = "";
  if (!files.length) return;
  try {
    const images = await filesToImages(files);
    hideBusy();
    if (!images.length) return;
    cachetReturnScreen = "screen-home";
    await startCachetFlow(images);
  } catch (err) {
    hideBusy();
    console.error(err);
    showToast("Impossible de lire ce fichier. " + (err.message || ""), 4500);
  }
});

document.getElementById("btn-close-camera").addEventListener("click", closeCamera);
document.getElementById("btn-camera-back").addEventListener("click", closeCamera);
// Échec de chargement du moteur de détection → retour caméra (pas de cul-de-sac)
document.getElementById("btn-crop-loading-back").addEventListener("click", openCamera);

// Caméra → capturer.
//  - mode scan  : aperçu → recadrage → filtre → liste.
//  - mode cachet: on accumule la page (sans rognage) et on reste sur la
//    caméra pour la page suivante ; "Terminer" lance le découpage.
document.getElementById("btn-capture").addEventListener("click", () => {
  const img = capturePhoto(video);
  if (cameraMode === "cachet") {
    cachetPages.push(img);
    // petit éclair blanc : confirme visuellement la prise
    const flash = document.getElementById("camera-flash");
    flash.classList.remove("is-on");
    void flash.offsetWidth; // relance l'animation
    flash.classList.add("is-on");
    updateCameraDone();
    return;
  }
  state.capturedImage = img;
  state.activeFilter = "auto"; // photo → filtre "Auto" par défaut (≠ téléversement)
  state.fromImport = false;
  previewImage.src = img;
  stopCamera(video);
  showScreen("screen-preview");
});

// Caméra (mode cachet) → "Terminer" : lance le découpage des pages prises.
document.getElementById("btn-camera-done").addEventListener("click", async () => {
  if (cachetPages.length === 0) return;
  stopCamera(video);
  cachetReturnScreen = "screen-home";
  await startCachetFlow(cachetPages.slice());
});

// Aperçu → "Reprendre"
document.getElementById("btn-retake").addEventListener("click", openCamera);

// Aperçu → "Continuer" : recadrage
document.getElementById("btn-use").addEventListener("click", async () => {
  showScreen("screen-crop");
  await initCrop(state.capturedImage);
});

// Recadrage → "Reprendre"
document.getElementById("btn-crop-back").addEventListener("click", openCamera);

// Recadrage → "Valider"
document.getElementById("btn-crop-confirm").addEventListener("click", () => {
  try {
    state.croppedCanvas = cropToCanvas();
    state.rotation = 0;
    showResult();
  } catch (e) {
    console.error(e);
    showToast("Le redressement a échoué. Essaie de réajuster les coins.", 4500);
  }
});

// Filtres + rotation
filterButtons.forEach((b) =>
  b.addEventListener("click", () => setFilter(b.dataset.filter))
);
document.getElementById("btn-rotate-left").addEventListener("click", () => rotate(-90));
document.getElementById("btn-rotate-right").addEventListener("click", () => rotate(90));

// Résultat → "Reprendre" (photo) ou "Ignorer cette page" (téléversement)
resultRetakeBtn.addEventListener("click", () => {
  if (state.fromImport) {
    if (importQueue.length) {
      startNextImport(); // page suivante du lot téléversé
      return;
    }
    showScreen(pageCount() > 0 ? "screen-pages" : "screen-home");
    return;
  }
  openCamera();
});

// Le contenu de la liste a changé → l'éventuel PDF préparé n'est plus valable.
function invalidatePendingPdf() {
  pendingPdf = null;
  pdfGeneration++;
  exportBtn.textContent = EXPORT_LABEL;
  exportBtn.classList.remove("btn-primary--ready");
}
// Suppressions / réordonnancements faits dans pages.js
document.addEventListener("pages-changed", invalidatePendingPdf);

// Résultat → "Ajouter" : ajoute la page à la liste
document.getElementById("btn-add-to-list").addEventListener("click", () => {
  addPage(state.filteredImage);
  invalidatePendingPdf();
  if (importQueue.length) startNextImport(); // continuer le lot téléversé
  else showScreen("screen-pages");
});

// Liste → "+ Ajouter une page"
document.getElementById("btn-add-page").addEventListener("click", () => {
  cameraMode = "scan";
  openCamera();
});

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

// Après un export réussi : on vide la liste (le scan est terminé) et on
// revient à l'accueil.
function finishExport() {
  pendingPdf = null;
  exportBtn.textContent = EXPORT_LABEL;
  exportBtn.classList.remove("btn-primary--ready");
  clearPages();
  showScreen("screen-home");
}

// Liste → "Exporter en PDF"
exportBtn.addEventListener("click", async () => {
  // 2e temps : un PDF est prêt → on le partage (appui = geste utilisateur frais).
  if (pendingPdf) {
    const delivered = await sharePdf(pendingPdf);
    if (delivered) finishExport(); // partagé → fin du scan
    return; // annulé → on garde le PDF pour réessayer
  }

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

// --- Entrée / "Suivant" du clavier = passer au champ suivant ---
const fieldOrder = [F.studio, F.employe, F.projet, F.da, F.role, F.date, F.lignes, F.brut, F.net];
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
let splitFlags = [];       // splitFlags[i] = true → la page i démarre un contrat
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

// Devine où commence chaque contrat (la 1re page est toujours un début).
function computeSplitFlags() {
  splitFlags = cachetPages.map((_, i) => (i === 0 ? true : isContractStart(pageTexts[i] || "")));
}

// Regroupe les pages en contrats selon le découpage.
function buildContracts() {
  const pages = cachetPages;
  const out = [];
  pages.forEach((url, i) => {
    if (splitFlags[i] || out.length === 0) {
      out.push({ pages: [url], texts: [pageTexts[i] || ""] });
    } else {
      const c = out[out.length - 1];
      c.pages.push(url);
      c.texts.push(pageTexts[i] || "");
    }
  });
  return out.map((c) => ({ pages: c.pages, text: c.texts.join("\n") }));
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
    // Annulé : retour à la caméra cachet (les pages sont conservées) ou
    // à l'écran d'origine.
    if (cameraMode === "cachet") openCamera();
    else showScreen(cachetReturnScreen);
    return;
  }
  computeSplitFlags();
  if (cachetPages.length <= 1) {
    cachetContracts = buildContracts();
    startCachetContract(0);
  } else {
    renderSplit();
    setStep("decoupage");
    showScreen("screen-split");
  }
}

// Liste (parcours scan) → "Classer ces pages en cachet".
cachetBtn.addEventListener("click", async () => {
  if (pageCount() === 0) return;
  cachetReturnScreen = "screen-pages";
  await startCachetFlow(getPages());
});

// Dessine l'écran de découpage : une CARTE par contrat détecté, avec ses
// pages en vignettes. Boutons clairs pour fusionner / séparer.
function renderSplit() {
  const pages = cachetPages;
  splitListEl.innerHTML = "";
  // Après un premier envoi, on FIGE le découpage : re-couper/fusionner
  // mélangerait des contrats déjà rangés dans Drive avec d'autres.
  const locked = sentLog.length > 0;

  // Construire les groupes (contrats) à partir de splitFlags.
  const groups = [];
  pages.forEach((url, i) => {
    if (splitFlags[i] || groups.length === 0) groups.push([i]);
    else groups[groups.length - 1].push(i);
  });

  groups.forEach((idxs, gi) => {
    const card = document.createElement("div");
    card.className = "ct-card";
    const firstPage = pages[idxs[0]];
    const isSent = sentFirstPages.has(firstPage);
    const isSkipped = skippedFirstPages.has(firstPage);

    // En-tête : numéro + "Contrat N" + nb de pages (+ fusionner si pas le 1er)
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
        : "· " + idxs.length + (idxs.length > 1 ? " pages" : " page");
    head.append(badge, title, meta);
    if (gi > 0 && !locked) {
      const merge = document.createElement("button");
      merge.type = "button";
      merge.className = "ct-card__merge";
      merge.textContent = "↑ Fusionner";
      merge.addEventListener("click", () => {
        splitFlags[idxs[0]] = false;
        renderSplit();
      });
      head.appendChild(merge);
    }
    card.appendChild(head);

    // Vignettes des pages du contrat
    const pagesRow = document.createElement("div");
    pagesRow.className = "ct-card__pages";
    idxs.forEach((i) => {
      const cell = document.createElement("div");
      cell.className = "ct-thumb";
      const img = document.createElement("img");
      img.src = pages[i];
      img.alt = "Page " + (i + 1);
      const n = document.createElement("span");
      n.className = "ct-thumb__n";
      n.textContent = String(i + 1);
      cell.append(img, n);
      pagesRow.appendChild(cell);
    });
    card.appendChild(pagesRow);

    // Si le contrat a plusieurs pages : proposer de le couper (sauf figé).
    if (idxs.length > 1 && !locked) {
      const splits = document.createElement("div");
      splits.className = "ct-splits";
      idxs.slice(1).forEach((i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ct-split";
        b.textContent = "✂ Couper : nouveau contrat dès la page " + (i + 1);
        b.addEventListener("click", () => {
          splitFlags[i] = true;
          renderSplit();
        });
        splits.appendChild(b);
      });
      card.appendChild(splits);
    }

    splitListEl.appendChild(card);
  });

  const n = groups.length;
  splitCountEl.textContent = n + (n <= 1 ? " contrat" : " contrats");
}

// Quitte le parcours cachet (avec confirmation si des contrats non
// envoyés seraient perdus), puis nettoie l'état. Si des contrats ont déjà
// été envoyés, on passe par l'écran de confirmation (récapitulatif honnête).
function leaveCachetFlow() {
  const total = cachetContracts.length;
  const handled = sentFirstPages.size + skippedFirstPages.size;
  const unsentRemain = total === 0 || handled < total; // 0 = découpage pas encore validé
  if (cachetReturnScreen === "screen-home" && cachetPages.length > 0 && unsentRemain) {
    const msg = sentLog.length > 0
      ? "Abandonner les contrats restants (non envoyés) ?"
      : `Abandonner ces ${cachetPages.length} page${cachetPages.length > 1 ? "s" : ""} ?`;
    if (!confirm(msg)) return;
  }
  cachetPages = [];
  cachetContracts = [];
  splitFlags = [];
  cameraMode = "scan";
  if (sentLog.length > 0) {
    // Quelque chose a bien été envoyé → récapitulatif plutôt que silence.
    renderDone();
    setStep("envoi");
    showScreen("screen-done");
    return;
  }
  showScreen(cachetReturnScreen);
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
  // On ne vide la liste scan QUE si elle était la source ET qu'on a envoyé.
  if (sentSomething && cachetReturnScreen === "screen-pages") clearPages();
  cachetPages = [];
  cameraMode = "scan";
  pendingPdf = null;
  exportBtn.textContent = EXPORT_LABEL;
  exportBtn.classList.remove("btn-primary--ready");
  if (!sentSomething) {
    showScreen(cachetReturnScreen); // ex. tout a été "ignoré" → pages conservées
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
      date: f.date, projet: f.projet, studio: f.studio, employe: f.employe,
      da: f.da, role: f.role, lignes: f.lignes,
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
  else if (id === "screen-preview" || id === "screen-crop") openCamera();
  else if (id === "screen-result") resultRetakeBtn.click();
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
