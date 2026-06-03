// ===================================================================
// app.js — le "chef d'orchestre" de Scanzen.
//
// Il coordonne les écrans et l'état de l'app, et délègue le travail
// spécialisé aux autres fichiers (camera, scanner, filters, pages, pdf).
// ===================================================================

import { startCamera, stopCamera, capturePhoto } from "./camera.js";
import { initCrop, cropToCanvas } from "./scanner.js";
import { applyFilter } from "./filters.js";
import { addPage, pageCount, getPages } from "./pages.js";
import { exportPdf } from "./pdf.js";

// --- État partagé de l'app ---
const state = {
  capturedImage: null, // photo brute prise par la caméra
  croppedCanvas: null, // le rognage (canvas plein résolution, avant filtre)
  filteredImage: null, // rognage + rotation + filtre (ce qui sera ajouté)
  activeFilter: "auto", // mode de filtre courant
  rotation: 0, // rotation appliquée au résultat (0, 90, 180, 270)
};

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

// Applique la rotation courante puis le mode (original/auto/bw), met à
// jour l'image affichée et surligne le bouton de filtre actif.
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

// Tourne le résultat de ±90° et rafraîchit l'affichage.
function rotate(delta) {
  state.rotation = (state.rotation + delta + 360) % 360;
  setFilter(state.activeFilter);
}

// ===================================================================
// Branchement des boutons
// ===================================================================

document.getElementById("btn-scan").addEventListener("click", openCamera);

document.getElementById("btn-close-camera").addEventListener("click", closeCamera);
document.getElementById("btn-camera-back").addEventListener("click", closeCamera);

// Caméra → capturer : on fige la photo et on passe à l'aperçu
document.getElementById("btn-capture").addEventListener("click", () => {
  state.capturedImage = capturePhoto(video);
  previewImage.src = state.capturedImage;
  stopCamera(video);
  showScreen("screen-preview");
});

// Aperçu → "Reprendre"
document.getElementById("btn-retake").addEventListener("click", openCamera);

// Aperçu → "Continuer" : on passe au recadrage
document.getElementById("btn-use").addEventListener("click", async () => {
  showScreen("screen-crop");
  await initCrop(state.capturedImage);
});

// Recadrage → "Reprendre"
document.getElementById("btn-crop-back").addEventListener("click", openCamera);

// Recadrage → "Rogner" : on découpe le rectangle puis on affiche le résultat
document.getElementById("btn-crop-confirm").addEventListener("click", () => {
  try {
    state.croppedCanvas = cropToCanvas();
    state.rotation = 0; // nouveau scan = pas de rotation au départ
    showResult();
  } catch (e) {
    console.error(e);
    alert("Le redressement a échoué. Essaie de réajuster les coins.");
  }
});

// Boutons de filtre (Original / Auto / Noir & blanc)
filterButtons.forEach((b) =>
  b.addEventListener("click", () => setFilter(b.dataset.filter))
);

// Boutons de rotation (gauche / droite)
document.getElementById("btn-rotate-left").addEventListener("click", () => rotate(-90));
document.getElementById("btn-rotate-right").addEventListener("click", () => rotate(90));

// Résultat → "Reprendre" : on jette cette page et on relance la caméra
document.getElementById("btn-result-retake").addEventListener("click", openCamera);

// Résultat → "Ajouter" : on ajoute la page à la liste
document.getElementById("btn-add-to-list").addEventListener("click", () => {
  addPage(state.filteredImage);
  showScreen("screen-pages");
});

// Liste → "+ Ajouter une page"
document.getElementById("btn-add-page").addEventListener("click", openCamera);

// Liste → "Exporter en PDF"
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

// --- PWA : enregistre le service worker (installation + hors-ligne) ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("service-worker.js", { updateViaCache: "none" })
      .catch((err) => console.warn("Service worker non enregistré :", err));
  });
}
