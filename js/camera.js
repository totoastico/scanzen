// ===================================================================
// camera.js — caméra : démarrer le flux, l'arrêter, capturer une photo.
//
// Capture en HAUTE RÉSOLUTION quand c'est possible : on utilise
// l'API ImageCapture (photo pleine définition de l'appareil, ex.
// 12 Mpx) au lieu de la simple image vidéo (~2 Mpx). Repli sur la
// trame vidéo si l'API n'existe pas (iOS) ou échoue.
// ===================================================================

let stream = null;

// Taille max de la photo (on borne pour rester fluide et économe en mémoire).
const MAX_DIM = 2400;

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

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Lecture de la photo impossible"));
    reader.readAsDataURL(blob);
  });
}

// Réduit l'image si elle dépasse MAX_DIM (sur son plus grand côté).
function capToMaxDim(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const longest = Math.max(img.naturalWidth, img.naturalHeight);
      if (longest <= MAX_DIM) {
        resolve(dataUrl);
        return;
      }
      const k = MAX_DIM / longest;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * k);
      canvas.height = Math.round(img.naturalHeight * k);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.95));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// Capture une photo et renvoie une data URL JPEG (haute résolution si possible).
export async function capturePhoto(videoEl) {
  // 1) Tentative haute résolution via ImageCapture (Android/Chrome surtout).
  if (stream && typeof window.ImageCapture === "function") {
    try {
      const track = stream.getVideoTracks()[0];
      const capture = new ImageCapture(track);
      const blob = await capture.takePhoto();
      const url = await blobToDataURL(blob);
      return await capToMaxDim(url);
    } catch (e) {
      // on bascule sur le repli ci-dessous
    }
  }

  // 2) Repli : la trame vidéo (iOS, ou si takePhoto échoue).
  const canvas = document.createElement("canvas");
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  canvas.getContext("2d").drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.95);
}
