// ===================================================================
// pages.js — la liste des pages scannées.
//   - ajouter une page (à la fin)
//   - supprimer une page
//   - réordonner (monter / descendre)
//
// Chaque page est une image au format data URL (déjà redressée +
// filtrée). C'est cette liste que l'export PDF (étape 6) utilisera.
// ===================================================================

const pages = [];

const listEl = document.getElementById("pages-list");
const countEl = document.getElementById("pages-count");
const exportBtn = document.getElementById("btn-export");
const cachetShortcut = document.getElementById("btn-cachet");

// --- Fonctions utilisées par app.js ---

// Ajoute une page à la fin de la liste.
export function addPage(dataUrl) {
  pages.push(dataUrl);
  render();
}

// Renvoie une copie du tableau des pages (pour l'export PDF).
export function getPages() {
  return pages.slice();
}

// Nombre de pages actuelles.
export function pageCount() {
  return pages.length;
}

// Vide toute la liste (après un export réussi : le scan est terminé).
export function clearPages() {
  pages.length = 0;
  render();
}

// --- Interne ---

function removePage(index) {
  pages.splice(index, 1);
  render();
  // Prévient app.js : un PDF déjà préparé ne correspond plus à la liste.
  document.dispatchEvent(new CustomEvent("pages-changed"));
}

// Déplace une page d'un cran (direction = -1 pour monter, +1 pour descendre).
function movePage(index, direction) {
  const target = index + direction;
  if (target < 0 || target >= pages.length) return;
  [pages[index], pages[target]] = [pages[target], pages[index]];
  render();
  document.dispatchEvent(new CustomEvent("pages-changed"));
}

function makeButton(label, className, onClick, disabled) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = label;
  if (disabled) b.disabled = true;
  b.addEventListener("click", onClick);
  return b;
}

// Redessine toute la liste à partir du tableau `pages`.
function render() {
  const n = pages.length;
  countEl.textContent = n <= 1 ? n + " page" : n + " pages";
  exportBtn.disabled = n === 0; // pas de pages → pas d'export possible
  cachetShortcut.disabled = n === 0; // idem pour le raccourci cachet

  listEl.innerHTML = "";

  if (n === 0) {
    const empty = document.createElement("p");
    empty.className = "pages__empty";
    empty.textContent = "Aucune page pour l'instant.";
    listEl.appendChild(empty);
    return;
  }

  pages.forEach((url, i) => {
    const card = document.createElement("div");
    card.className = "page-card";

    const num = document.createElement("span");
    num.className = "page-card__num";
    num.textContent = String(i + 1);

    const thumb = document.createElement("img");
    thumb.className = "page-card__thumb";
    thumb.src = url;
    thumb.alt = "Page " + (i + 1);

    const controls = document.createElement("div");
    controls.className = "page-card__controls";
    controls.append(
      makeButton("↑", "page-ctrl", () => movePage(i, -1), i === 0),
      makeButton("↓", "page-ctrl", () => movePage(i, +1), i === n - 1),
      makeButton("✕", "page-ctrl page-card__del", () => removePage(i), false)
    );

    card.append(num, thumb, controls);
    listEl.appendChild(card);
  });
}

// Affichage initial (compteur à 0, bouton "Exporter" désactivé).
render();
