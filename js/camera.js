// ===================================================================
// camera.js — caméra : démarrer le flux, l'arrêter, capturer une photo.
//
// La capture prend EXACTEMENT l'image affichée à l'écran (la trame
// vidéo). On demande une résolution élevée au flux (jusqu'à 1440p) pour
// la netteté, mais on ne change pas le cadrage → "ce que tu vois est ce
// que tu obtiens" (pas de zoom arrière surprise).
// ===================================================================

let stream = null;

export async function startCamera(videoEl) {
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "environment" }, // caméra arrière si dispo
      width: { ideal: 2560 },
      height: { ideal: 1440 },
    },
    audio: false,
  });
  videoEl.srcObject = stream;
  await videoEl.play();
}

export function stopCamera(videoEl) {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  if (videoEl) {
    videoEl.srcObject = null;
  }
}

// Capture la trame affichée (même cadrage que l'aperçu) → data URL JPEG.
export function capturePhoto(videoEl) {
  const canvas = document.createElement("canvas");
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  canvas.getContext("2d").drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.95);
}
