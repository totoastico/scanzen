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
};

let pendingPdf = null; // PDF préparé, en attente d'un appui pour le partager
const EXPORT_LABEL = "Exporter en PDF";

// --- Mode de la caméra / parcours ---
let cameraMode = "scan";                  // "scan" (Scanner) ou "cachet" (Contrat)
let cachetPages = [];                     // images du lot cachet en cours (≠ pages scan)
let cachetReturnScreen = "screen-home";   // où revenir depuis le découpage
let sentFirstPages = new Set();           // contrats déjà envoyés (clé = 1re page) → anti-doublon

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

// --- Navigation entre écrans : un seul visible à la fois ---
const screens = document.querySelectorAll(".screen");
function showScreen(id) {
  screens.forEach((screen) => screen.classList.remove("screen--active"));
  document.getElementById(id).classList.add("screen--active");
}

// --- Petit voile "occupé" (lecture d'un PDF, etc.) ---
const busy = document.getElementById("busy");
const busyText = document.getElementById("busy-text");
function showBusy(msg) {
  busyText.textContent = msg;
  busy.hidden = false;
}
function hideBusy() {
  busy.hidden = true;
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

// En mode cachet, affiche le bouton "Terminer (N)" sur la caméra.
function updateCameraDone() {
  const done = document.getElementById("btn-camera-done");
  if (cameraMode === "cachet") {
    done.hidden = false;
    done.textContent = `Terminer (${cachetPages.length})`;
  } else {
    done.hidden = true;
  }
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
    alert("Ce fichier n'a pas pu être ouvert.");
    if (importQueue.length) startNextImport();
    return;
  }
  state.rotation = 0;
  state.activeFilter = "original"; // déjà scanné → on n'altère rien par défaut
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
      alert(`« ${file.name} » n'est ni une image ni un PDF.\nPour un fichier Word, enregistre-le d'abord en PDF.`);
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
    alert("Impossible de lire ce fichier. " + (err.message || ""));
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
    alert("Impossible de lire ce fichier. " + (err.message || ""));
  }
});

document.getElementById("btn-close-camera").addEventListener("click", closeCamera);
document.getElementById("btn-camera-back").addEventListener("click", closeCamera);

// Caméra → capturer.
//  - mode scan  : aperçu → recadrage → filtre → liste.
//  - mode cachet: on accumule la page (sans rognage) et on reste sur la
//    caméra pour la page suivante ; "Terminer" lance le découpage.
document.getElementById("btn-capture").addEventListener("click", () => {
  const img = capturePhoto(video);
  if (cameraMode === "cachet") {
    cachetPages.push(img);
    updateCameraDone();
    return;
  }
  state.capturedImage = img;
  state.activeFilter = "auto"; // photo → filtre "Auto" par défaut (≠ téléversement)
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

// Recadrage → "Redresser"
document.getElementById("btn-crop-confirm").addEventListener("click", () => {
  try {
    state.croppedCanvas = cropToCanvas();
    state.rotation = 0;
    showResult();
  } catch (e) {
    console.error(e);
    alert("Le redressement a échoué. Essaie de réajuster les coins.");
  }
});

// Filtres + rotation
filterButtons.forEach((b) =>
  b.addEventListener("click", () => setFilter(b.dataset.filter))
);
document.getElementById("btn-rotate-left").addEventListener("click", () => rotate(-90));
document.getElementById("btn-rotate-right").addEventListener("click", () => rotate(90));

// Résultat → "Reprendre"
document.getElementById("btn-result-retake").addEventListener("click", openCamera);

// Résultat → "Ajouter" : ajoute la page à la liste
document.getElementById("btn-add-to-list").addEventListener("click", () => {
  addPage(state.filteredImage);
  pendingPdf = null; // le contenu a changé → l'éventuel PDF préparé n'est plus valable
  exportBtn.textContent = EXPORT_LABEL;
  if (importQueue.length) startNextImport(); // continuer le lot téléversé
  else showScreen("screen-pages");
});

// Liste → "+ Ajouter une page"
document.getElementById("btn-add-page").addEventListener("click", () => {
  cameraMode = "scan";
  openCamera();
});

// Après un export réussi : on vide la liste (le scan est terminé) et on
// revient à l'accueil.
function finishExport() {
  pendingPdf = null;
  exportBtn.textContent = EXPORT_LABEL;
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
  const ocr = document.getElementById("ocr-toggle").checked;

  exportBtn.disabled = true;
  exportBtn.textContent = ocr ? "OCR en cours…" : "Création du PDF…";
  try {
    const blob = await buildPdf(pages, {
      ocr,
      onProgress: (i, total, p) => {
        exportBtn.textContent = `OCR ${i + 1}/${total} — ${Math.round((p || 0) * 100)}%`;
      },
    });
    if (ocr) {
      // L'OCR peut durer longtemps → l'autorisation de partage a expiré.
      // On garde le PDF et on attend un nouvel appui pour le partager.
      pendingPdf = blob;
      exportBtn.textContent = "📄 Partager le PDF";
    } else {
      exportBtn.textContent = EXPORT_LABEL;
      const delivered = await sharePdf(blob);
      if (delivered) finishExport();
    }
  } catch (e) {
    console.error(e);
    alert("La création du PDF a échoué. Réessaie.");
    exportBtn.textContent = EXPORT_LABEL;
  } finally {
    exportBtn.disabled = false;
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
[F.date, F.studio, F.da].forEach((el) => el.addEventListener("input", refreshFilename));

// Montant net = estimation depuis le brut (≈ 78 %), sauf si saisi à la main.
const NET_PCT = 0.78; // à ajuster selon tes bulletins de paie (net ÷ brut)
let netManual = false;
function computeNet() {
  if (netManual) return;
  const brut = parseFloat((F.brut.value || "").replace(",", "."));
  F.net.value = isFinite(brut) ? Math.round(brut * NET_PCT * 100) / 100 : "";
}
F.brut.addEventListener("input", computeNet);
F.net.addEventListener("input", () => { netManual = true; });

function fillForm(f) {
  netManual = false;
  F.projet.value = f.projet || "";
  F.studio.value = f.studio || "";
  F.employe.value = f.employe || "";
  F.da.value = f.da || "";
  F.date.value = f.date || "";
  F.lignes.value = f.lignes || "";
  F.brut.value = f.brut || "";
  F.net.value = f.net || "";
  if (!F.net.value) computeNet(); // estime le net si absent
  F.role.value = f.role || "ND";
  refreshFilename();
}

// ===================================================================
// Découpage intelligent : 1 lot de pages → 1 ou plusieurs contrats
// ===================================================================
// Après "Fiche cachet" : on OCRise chaque page, on PROPOSE un découpage
// (1 contrat = 1 ou plusieurs pages), tu ajustes, puis on traite chaque
// contrat l'un après l'autre (1 PDF + 1 ligne chacun).

let pageTexts = [];        // texte OCR de chaque page (même ordre que getPages)
let splitFlags = [];       // splitFlags[i] = true → la page i démarre un contrat
let cachetContracts = [];  // [{ pages:[dataURL], text }]
let cachetIndex = 0;       // contrat en cours de saisie

const splitListEl = document.getElementById("split-list");
const splitCountEl = document.getElementById("split-count");

// OCR de toutes les pages, avec voile de progression.
async function ocrAllPages() {
  const pages = cachetPages;
  pageTexts = [];
  for (let i = 0; i < pages.length; i++) {
    showBusy(`Analyse du texte… page ${i + 1}/${pages.length}`);
    try {
      const lines = await ocrPage(pages[i], (p) =>
        showBusy(`Analyse du texte… page ${i + 1}/${pages.length} — ${Math.round((p || 0) * 100)}%`)
      );
      pageTexts.push(lines.map((l) => l.text).join("\n"));
    } catch (e) {
      console.error(e);
      pageTexts.push("");
    }
  }
  try { await terminateOcr(); } catch (e) { /* libère la mémoire OCR */ }
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
  sentFirstPages = new Set(); // nouveau lot → on repart de zéro pour l'anti-doublon
  try {
    await ocrAllPages();
  } finally {
    hideBusy();
  }
  computeSplitFlags();
  if (cachetPages.length <= 1) {
    cachetContracts = buildContracts();
    startCachetContract(0);
  } else {
    renderSplit();
    showScreen("screen-split");
  }
}

// Liste (parcours scan) → "Fiche cachet" : traite les pages scannées comme
// un (ou plusieurs) contrat(s).
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

  // Construire les groupes (contrats) à partir de splitFlags.
  const groups = [];
  pages.forEach((url, i) => {
    if (splitFlags[i] || groups.length === 0) groups.push([i]);
    else groups[groups.length - 1].push(i);
  });

  groups.forEach((idxs, gi) => {
    const card = document.createElement("div");
    card.className = "ct-card";

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
    meta.textContent = "· " + idxs.length + (idxs.length > 1 ? " pages" : " page");
    head.append(badge, title, meta);
    if (gi > 0) {
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

    // Si le contrat a plusieurs pages : proposer de le couper.
    if (idxs.length > 1) {
      const splits = document.createElement("div");
      splits.className = "ct-splits";
      idxs.slice(1).forEach((i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ct-split";
        b.textContent = "Couper : nouveau contrat dès la page " + (i + 1);
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

document.getElementById("btn-split-back").addEventListener("click", () => showScreen(cachetReturnScreen));
document.getElementById("btn-split-confirm").addEventListener("click", () => {
  cachetContracts = buildContracts();
  startCachetContract(0);
});

// Fin du lot cachet : message récap, nettoyage et retour à l'accueil.
function finishCachet() {
  const sent = sentFirstPages.size;
  if (sent > 0) {
    alert(`Envoyé ✅ ${sent > 1 ? sent + " cachets rangés" : "Cachet rangé"} dans Drive + feuille.\n(Si rien n'apparaît, re-règle l'URL via ⚙️ Connecteur Google.)`);
  }
  if (cachetReturnScreen === "screen-pages") clearPages(); // ne vide la liste scan QUE si elle en était la source
  cachetPages = [];
  cameraMode = "scan";
  pendingPdf = null;
  exportBtn.textContent = EXPORT_LABEL;
  showScreen("screen-home");
}

// Affiche le formulaire pré-rempli pour le contrat n° i du lot. Saute les
// contrats déjà envoyés (anti-doublon si on revient en arrière) et termine
// le lot s'il n'en reste plus.
function startCachetContract(i) {
  while (cachetContracts[i] && sentFirstPages.has(cachetContracts[i].pages[0])) i++;
  if (i >= cachetContracts.length) {
    finishCachet();
    return;
  }
  cachetIndex = i;
  const total = cachetContracts.length;
  const c = cachetContracts[i];
  fillForm(extractFields(c.text || ""));
  document.querySelector("#screen-contract .wordmark").textContent =
    total > 1 ? `Fiche cachet ${i + 1}/${total}` : "Fiche cachet";
  document.getElementById("btn-cachet-save").textContent =
    total > 1 ? `Enregistrer (${i + 1}/${total})` : "Enregistrer";
  showScreen("screen-contract");
}

// Formulaire → "Pré-remplir (OCR)" : ré-applique l'extraction au contrat courant.
document.getElementById("btn-prefill").addEventListener("click", async () => {
  const c = cachetContracts[cachetIndex];
  if (!c) return;
  const btn = document.getElementById("btn-prefill");
  const label = btn.textContent;
  btn.disabled = true;
  try {
    let text = c.text;
    if (!text) {
      let acc = "";
      for (let i = 0; i < c.pages.length; i++) {
        btn.textContent = `Analyse ${i + 1}/${c.pages.length}…`;
        const lines = await ocrPage(c.pages[i]);
        acc += lines.map((l) => l.text).join("\n") + "\n";
      }
      c.text = text = acc;
    }
    fillForm(extractFields(text));
  } catch (e) {
    console.error(e);
    alert("L'analyse OCR a échoué. Tu peux remplir la fiche à la main.");
  } finally {
    btn.textContent = label;
    btn.disabled = false;
  }
});

// Retour depuis le formulaire : vers le découpage (si lot) ou l'écran d'origine.
document.getElementById("btn-cachet-back").addEventListener("click", () => {
  showScreen(cachetContracts.length > 1 ? "screen-split" : cachetReturnScreen);
});

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Lecture du PDF impossible"));
    r.readAsDataURL(blob);
  });
}

// URL du connecteur Apps Script (stockée sur l'appareil, pas dans le code public).
function getConnectorUrl(forcePrompt) {
  let url = localStorage.getItem("scanzen_gas_url") || "";
  if (forcePrompt || !url) {
    const v = prompt("Colle l'URL du connecteur Google (elle finit par /exec) :", url);
    if (v && v.trim()) {
      url = v.trim();
      localStorage.setItem("scanzen_gas_url", url);
    }
  }
  return url;
}

// ⚙️ Régler / changer le connecteur
document.getElementById("btn-config-gas").addEventListener("click", () => {
  if (getConnectorUrl(true)) alert("Connecteur enregistré ✅");
});

// Fiche → "Enregistrer" : envoie le contrat COURANT au connecteur Google,
// puis passe au contrat suivant du lot (ou termine).
document.getElementById("btn-cachet-save").addEventListener("click", async () => {
  let url = getConnectorUrl(false);
  if (!url) url = getConnectorUrl(true); // pas encore réglé → on demande
  if (!url) return; // annulé

  const f = currentFields();
  const filename = buildFilename(f) + ".pdf";
  const total = cachetContracts.length || 1;
  const c = cachetContracts[cachetIndex] || { pages: cachetPages };
  const btn = document.getElementById("btn-cachet-save");
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
      brut: toComma(f.brut), net: toComma(f.net), // virgule décimale → € dans la feuille
      pdfBase64,
    };
    await fetch(url, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
    if (c.pages && c.pages[0]) sentFirstPages.add(c.pages[0]); // marque ce contrat comme envoyé
    startCachetContract(cachetIndex + 1); // contrat suivant (ou fin du lot)
  } catch (e) {
    console.error(e);
    alert("Échec de l'envoi. Vérifie l'URL du connecteur (⚙️ Connecteur Google).");
    btn.textContent = total > 1 ? `Enregistrer (${cachetIndex + 1}/${total})` : "Enregistrer";
  } finally {
    btn.disabled = false;
  }
});

// --- PWA : enregistre le service worker (installation + hors-ligne) ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("service-worker.js", { updateViaCache: "none" })
      .catch((err) => console.warn("Service worker non enregistré :", err));
  });
}
