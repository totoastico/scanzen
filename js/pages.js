// ===================================================================
// pages.js — la liste des pages scannées.
//
// Chaque page est un OBJET complet, pour pouvoir la retravailler dans
// l'éditeur (revenir aux coins, pivoter, changer d'effet…) :
//   {
//     original : la photo brute (data URL) — on ne la perd jamais
//     flat     : la page rognée/redressée, AVANT rotation et filtre
//                (c'est la base de travail de l'éditeur)
//     display  : l'image affichée/exportée (flat + rotation + filtre)
//     corners  : les 4 coins du rognage appliqué (ou null = pas de rognage)
//     rotation : rotation appliquée (0/90/180/270)
//     filter   : effet appliqué ("original" / "auto" / "bw")
//   }
// C'est `display` que l'export PDF et l'analyse cachet consomment.
// ===================================================================

const pages = [];

const listEl = document.getElementById("pages-list");
const countEl = document.getElementById("pages-count");
const exportBtn = document.getElementById("btn-export");
const cachetShortcut = document.getElementById("btn-cachet");

// --- Fonctions utilisées par app.js ---

// Ajoute une page. Accepte une simple data URL (téléversement) ou un
// objet déjà construit. Renvoie l'objet page (référence stable).
export function addPage(p) {
  const page =
    typeof p === "string"
      ? { original: p, flat: p, display: p, corners: null, rotation: 0, filter: "original" }
      : {
          original: p.original,
          flat: p.flat || p.display || p.original,
          display: p.display || p.original,
          corners: p.corners || null,
          rotation: p.rotation || 0,
          filter: p.filter || "original",
        };
  pages.push(page);
  render();
  return page;
}

// Renvoie les images affichables (pour le PDF, l'analyse cachet…).
export function getPages() {
  return pages.map((p) => p.display);
}

// Renvoie l'objet page complet (pour l'éditeur).
export function getPage(index) {
  return pages[index] || null;
}

// Position actuelle d'une page (référence) dans la liste, ou -1.
export function pageIndex(page) {
  return pages.indexOf(page);
}

// Met à jour une page (par référence — l'ordre peut avoir changé entre
// temps) et redessine la liste.
export function updatePage(page, patch) {
  const i = pages.indexOf(page);
  if (i === -1) return false;
  Object.assign(page, patch);
  render();
  document.dispatchEvent(new CustomEvent("pages-changed"));
  return true;
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
export function render() {
  const n = pages.length;
  countEl.textContent = n <= 1 ? n + " page" : n + " pages";
  exportBtn.disabled = n === 0; // pas de pages → pas d'export possible
  cachetShortcut.disabled = n === 0; // idem pour le bouton panda (cachet)

  listEl.innerHTML = "";

  if (n === 0) {
    const empty = document.createElement("p");
    empty.className = "pages__empty";
    empty.textContent = "Aucune page pour l'instant.";
    listEl.appendChild(empty);
    return;
  }

  pages.forEach((page, i) => {
    const card = document.createElement("div");
    card.className = "page-card";

    const num = document.createElement("span");
    num.className = "page-card__num";
    num.textContent = String(i + 1);

    const thumb = document.createElement("img");
    thumb.className = "page-card__thumb";
    thumb.src = page.display;
    thumb.alt = "Page " + (i + 1);
    // Taper la vignette ouvre l'éditeur de cette page.
    thumb.addEventListener("click", () => {
      document.dispatchEvent(new CustomEvent("page-open", { detail: { index: i } }));
    });

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
