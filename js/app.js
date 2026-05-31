// ===================================================================
// app.js — le "chef d'orchestre" de Scanzen.
//
// Il coordonne les écrans et l'état de l'app, et délègue le travail
// spécialisé aux autres fichiers (camera, scanner, filters, pages, pdf).
// ===================================================================

import { startCamera, stopCamera, capturePhoto } from "./camera.js";
import { initCrop, dewarp } from "./scanner.js";
import { applyFilter } from "./filters.js";
import { addPage, pageCount, getPages } from "./pages.js";
import { exportPdf } from "./pdf.js";

// --- État partagé de l'app ---
const state = {
  capturedImage: null, // photo brute prise par la caméra
  dewarpedImage: null, // page redressée (avant filtre)
  filteredImage: null, // page redressée + filtre (ce qui sera ajouté)
  activeFilter: "auto", // mode de filtre courant
};

// --- Éléments de la page dont on a besoin ---
const video = document.getElementById("camera-video");
const cameraError = document.getElementById("camera-error");
const cameraErrorText = document.getElementById("camera-error-text");
const previewImage = document.getElementById("preview-image");
const resultImage = document.getElementById("result-image");
const filterButtons = document.querySelectorAll(".filter-btn");
const exportBtn = document.getElementById("btn-export");

// Image "source" (la page redressée) sur laquelle on applique les filtres.
const sourceImg = new Image();

// --- Navigation entre écrans : un seul visible à la fois ---
const screens = document.querySelectorAll(".screen");
function showScreen(id) {
  screens.forEach((screen) => screen.classList.remove("screen--active"));
  document.getElementById(id).classList.add("screen--active");
}

// Charge une data URL dans une <img> et attend qu'elle soit prête.
function loadInto(imgEl, dataUrl) {
  return new Promise((resolve, reject) => {
    imgEl.onload = () => resolve();
    imgEl.onerror = () => reject(new Error("Image illisible"));
    imgEl.src = dataUrl;
  });
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

// Transforme une erreur technique en message clair pour l'utilisateur.
function describeCameraError(err) {
  if (err && err.name === "NotAllowedError") {
    return "Accès à la caméra refusé. Autorisez-la dans les réglages du navigateur, puis réessayez.";
  }
  if (err && err.name === "NotFoundError") {
    return "Aucune caméra détectée sur cet appareil.";
  }
  return "Impossible d'accéder à la caméra. Vérifiez que la page est ouverte en HTTPS ou sur localhost.";
}

// --- Écran résultat : affiche la page redressée + applique un filtre ---
async function showResult(dewarpedDataUrl) {
  await loadInto(sourceImg, dewarpedDataUrl);
  setFilter(state.activeFilter || "auto");
  showScreen("screen-result");
}

// Applique un mode (original/auto/bw), met à jour l'image et surligne
// le bouton actif.
function setFilter(mode) {
  state.activeFilter = mode;
  state.filteredImage = applyFilter(sourceImg, mode);
  resultImage.src = state.filteredImage;
  filterButtons.forEach((b) =>
    b.classList.toggle("filter-btn--active", b.dataset.filter === mode)
  );
}

// ===================================================================
// Branchement des boutons
// ===================================================================

// Accueil → ouvrir la caméra
document.getElementById("btn-scan").addEventListener("click", openCamera);

// Caméra → fermer
document.getElementById("btn-close-camera").addEventListener("click", closeCamera);
document.getElementById("btn-camera-back").addEventListener("click", closeCamera);

// Caméra → capturer : on fige la photo et on passe à l'aperçu
document.getElementById("btn-capture").addEventListener("click", () => {
  state.capturedImage = capturePhoto(video);
  previewImage.src = state.capturedImage;
  stopCamera(video);
  showScreen("screen-preview");
});

// Aperçu → "Reprendre" : on relance la caméra
document.getElementById("btn-retake").addEventListener("click", openCamera);

// Aperçu → "Continuer" : on passe au recadrage (détection des coins)
document.getElementById("btn-use").addEventListener("click", async () => {
  showScreen("screen-crop");
  await initCrop(state.capturedImage);
});

// Recadrage → "Reprendre" : revenir à la caméra
document.getElementById("btn-crop-back").addEventListener("click", openCamera);

// Recadrage → "Redresser" : on corrige la perspective puis on affiche
// le résultat (avec le filtre par défaut).
document.getElementById("btn-crop-confirm").addEventListener("click", async () => {
  try {
    state.dewarpedImage = dewarp();
    await showResult(state.dewarpedImage);
  } catch (e) {
    console.error(e);
    alert("Le redressement a échoué. Essaie de réajuster les coins.");
  }
});

// Boutons de filtre (Original / Auto / N&B)
filterButtons.forEach((b) =>
  b.addEventListener("click", () => setFilter(b.dataset.filter))
);

// Résultat → "Reprendre" : on jette cette page et on relance la caméra
document.getElementById("btn-result-retake").addEventListener("click", openCamera);

// Résultat → "Ajouter" : on ajoute la page à la liste et on l'affiche
document.getElementById("btn-add-to-list").addEventListener("click", () => {
  addPage(state.filteredImage);
  showScreen("screen-pages");
});

// Liste → "+ Ajouter une page" : on relance la caméra
document.getElementById("btn-add-page").addEventListener("click", openCamera);

// Liste → "Exporter en PDF" : on assemble toutes les pages en un PDF.
exportBtn.addEventListener("click", async () => {
  const pages = getPages();
  if (pages.length === 0) return;

  const label = exportBtn.textContent;
  exportBtn.disabled = true;
  exportBtn.textContent = "Création du PDF…";
  try {
    await exportPdf(pages);
  } catch (e) {
    console.error(e);
    alert("La création du PDF a échoué. Réessaie.");
  } finally {
    exportBtn.textContent = label;
    exportBtn.disabled = false;
  }
});
