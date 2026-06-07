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
import { ocrPage } from "./ocr.js";
import { extractFields, buildFilename, buildRow } from "./contract.js";

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

// --- Ouvrir la caméra (accueil, "Reprendre" ou "Ajouter une page") ---
async function openCamera() {
  showScreen("screen-camera");
  cameraError.hidden = true;
  try {
    await startCamera(video);
  } catch (err) {
    cameraErrorText.textContent = describeCameraError(err);
    cameraError.hidden = false;
  }
}

// --- Fermer la caméra : retour à la liste s'il y a déjà des pages,
//     sinon à l'accueil. ---
function closeCamera() {
  stopCamera(video);
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

document.getElementById("btn-scan").addEventListener("click", openCamera);

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

// Charge l'image suivante de la file dans le recadrage.
function startNextImport() {
  if (!importQueue.length) return;
  state.capturedImage = importQueue.shift();
  showScreen("screen-crop");
  initCrop(state.capturedImage);
}

// Accueil → "Téléverser" : importe UNE OU PLUSIEURS images (même parcours).
document.getElementById("file-input").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = ""; // permet de re-sélectionner les mêmes fichiers
  if (!files.length) return;
  try {
    importQueue = await Promise.all(files.map(readFileAsDataURL));
  } catch (err) {
    console.error(err);
    alert("Impossible de lire une des images.");
    return;
  }
  startNextImport();
});

document.getElementById("btn-close-camera").addEventListener("click", closeCamera);
document.getElementById("btn-camera-back").addEventListener("click", closeCamera);

// Caméra → capturer (l'image affichée) puis aperçu
document.getElementById("btn-capture").addEventListener("click", () => {
  state.capturedImage = capturePhoto(video);
  previewImage.src = state.capturedImage;
  stopCamera(video);
  showScreen("screen-preview");
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
document.getElementById("btn-add-page").addEventListener("click", openCamera);

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

function fillForm(f) {
  F.projet.value = f.projet || "";
  F.studio.value = f.studio || "";
  F.employe.value = f.employe || "";
  F.da.value = f.da || "";
  F.date.value = f.date || "";
  F.lignes.value = f.lignes || "";
  F.brut.value = f.brut || "";
  F.net.value = f.net || "";
  F.role.value = f.role || "ND";
  refreshFilename();
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Liste → "Fiche cachet" : ouvre le formulaire (à vérifier).
cachetBtn.addEventListener("click", () => {
  if (pageCount() === 0) return;
  refreshFilename();
  showScreen("screen-contract");
});

// Formulaire → "Pré-remplir (OCR)" : devine les champs depuis le texte.
document.getElementById("btn-prefill").addEventListener("click", async () => {
  const pages = getPages();
  if (!pages.length) return;
  const btn = document.getElementById("btn-prefill");
  const label = btn.textContent;
  btn.disabled = true;
  try {
    let text = "";
    for (let i = 0; i < pages.length; i++) {
      btn.textContent = `Analyse ${i + 1}/${pages.length}…`;
      const lines = await ocrPage(pages[i]);
      text += lines.map((l) => l.text).join("\n") + "\n";
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

document.getElementById("btn-cachet-back").addEventListener("click", () => showScreen("screen-pages"));

// Formulaire → "Enregistrer" (provisoire avant Google) : copie la ligne
// pour la feuille + télécharge le PDF nommé.
document.getElementById("btn-cachet-save").addEventListener("click", async () => {
  const f = currentFields();
  const filename = buildFilename(f) + ".pdf";
  try {
    await navigator.clipboard.writeText(buildRow(f, filename));
  } catch (e) {
    /* clipboard indisponible : on continue */
  }
  try {
    const blob = await buildPdf(getPages(), { ocr: false });
    downloadBlob(blob, filename);
  } catch (e) {
    console.error(e);
  }
  alert(
    'Fiche copiée (colle-la dans ta feuille) et PDF "' + filename + '" téléchargé.\n\n' +
      "Le rangement automatique dans Drive + la feuille Google arrivent à l'étape suivante."
  );
});

// --- PWA : enregistre le service worker (installation + hors-ligne) ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("service-worker.js", { updateViaCache: "none" })
      .catch((err) => console.warn("Service worker non enregistré :", err));
  });
}
