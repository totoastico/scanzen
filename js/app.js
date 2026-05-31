// ===================================================================
// app.js — le "chef d'orchestre" de Scanzen.
//
// Il coordonne les écrans et l'état de l'app, et délègue le travail
// spécialisé aux autres fichiers (ici : camera.js).
// ===================================================================

import { startCamera, stopCamera, capturePhoto } from "./camera.js";

// --- État partagé de l'app (il grandira au fil des étapes) ---
const state = {
  capturedImage: null, // dernière photo prise (data URL)
};

// --- Éléments de la page dont on a besoin ---
const video = document.getElementById("camera-video");
const cameraError = document.getElementById("camera-error");
const cameraErrorText = document.getElementById("camera-error-text");
const previewImage = document.getElementById("preview-image");

// --- Navigation entre écrans : un seul visible à la fois ---
const screens = document.querySelectorAll(".screen");
function showScreen(id) {
  screens.forEach((screen) => screen.classList.remove("screen--active"));
  document.getElementById(id).classList.add("screen--active");
}

// --- Ouvrir la caméra (depuis l'accueil ou "Reprendre") ---
async function openCamera() {
  showScreen("screen-camera");
  cameraError.hidden = true;
  try {
    await startCamera(video);
  } catch (err) {
    // Permission refusée, pas de caméra, ou page pas en HTTPS/localhost.
    cameraErrorText.textContent = describeCameraError(err);
    cameraError.hidden = false;
  }
}

// --- Fermer la caméra et revenir à l'accueil ---
function closeCamera() {
  stopCamera(video);
  showScreen("screen-home");
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

// ===================================================================
// Branchement des boutons
// ===================================================================

// Accueil → ouvrir la caméra
document.getElementById("btn-scan").addEventListener("click", openCamera);

// Caméra → fermer (croix en haut, ou bouton retour de l'erreur)
document.getElementById("btn-close-camera").addEventListener("click", closeCamera);
document.getElementById("btn-camera-back").addEventListener("click", closeCamera);

// Caméra → capturer : on fige la photo et on passe à l'aperçu
document.getElementById("btn-capture").addEventListener("click", () => {
  state.capturedImage = capturePhoto(video);
  previewImage.src = state.capturedImage;
  stopCamera(video); // on coupe la caméra pendant qu'on regarde la photo
  showScreen("screen-preview");
});

// Aperçu → "Reprendre" : on relance la caméra
document.getElementById("btn-retake").addEventListener("click", openCamera);

// Aperçu → "Continuer" : mènera au recadrage (étape 3). Provisoire :
document.getElementById("btn-use").addEventListener("click", () => {
  alert("Photo prête ! Le recadrage à 4 coins arrive à l'étape 3.");
});
