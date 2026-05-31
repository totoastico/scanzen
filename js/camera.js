// ===================================================================
// camera.js — tout ce qui touche à la caméra :
//   - démarrer le flux vidéo
//   - l'arrêter (libérer la caméra, éteindre le voyant)
//   - capturer l'image courante en photo
//
// On "exporte" ces fonctions pour que app.js puisse les utiliser.
// ===================================================================

// Le flux vidéo en cours. On le garde de côté pour pouvoir l'arrêter.
let stream = null;

// Démarre la caméra et branche le flux sur l'élément <video> fourni.
// Si ça échoue (refus, pas de caméra, pas de HTTPS), l'erreur remonte
// à app.js qui affichera un message.
export async function startCamera(videoEl) {
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "environment" }, // caméra arrière si disponible
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false, // on n'a pas besoin du micro
  });
  videoEl.srcObject = stream;
  await videoEl.play();
}

// Arrête la caméra et libère le matériel.
export function stopCamera(videoEl) {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  if (videoEl) {
    videoEl.srcObject = null;
  }
}

// Capture l'image affichée à l'instant et la renvoie en "data URL" JPEG
// (une longue chaîne de texte qui représente l'image, utilisable comme
// source d'une balise <img>).
export function capturePhoto(videoEl) {
  // On dessine l'image sur un canvas invisible, à la vraie résolution
  // de la caméra (et non à la taille affichée à l'écran).
  const canvas = document.createElement("canvas");
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;

  const ctx = canvas.getContext("2d");
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

  // 0.92 = qualité JPEG (bon compromis netteté / poids).
  return canvas.toDataURL("image/jpeg", 0.92);
}
