// ===================================================================
// contract.js — fiche "cachet voix off".
// Extraction (au mieux) des champs depuis le texte OCR + génération du
// nom de fichier et de la ligne pour la feuille Google.
//
// Heuristiques calées sur les contrats Video Adapt et Titra (doublage).
// L'utilisateur vérifie/corrige toujours dans le formulaire.
// ===================================================================

function clean(s) {
  return (s || "").replace(/[ \t ]+/g, " ").trim();
}

function slug(s) {
  return (
    clean(s)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "NA"
  );
}

function normNum(s) {
  return (s || "").replace(/[  ]/g, "").replace(",", ".").replace(/[^\d.]/g, "");
}

// Montant après un mot-clé (ex. "Brut de 290,07"). Mot-clé borné pour
// éviter les faux positifs (ex. "Netflix" pour "net").
function findAmount(text, keyword) {
  const m = text.match(new RegExp(keyword + "[^\\d]{0,20}(\\d[\\d  .,]*)", "i"));
  return m ? normNum(m[1]) : "";
}

// "25-11-25" / "24/04/2026" → "YYYY-MM-DD" (format jour-mois-année).
function toIso(raw) {
  if (!raw) return "";
  const p = raw.split(/[-\/.]/);
  if (p.length !== 3) return "";
  let [d, mo, y] = p;
  if (y.length === 2) y = "20" + y;
  return `${y}-${String(+mo).padStart(2, "0")}-${String(+d).padStart(2, "0")}`;
}

export function extractFields(text) {
  const T = (text || "").replace(/ /g, " ").replace(/\s+/g, " ");

  // Studio (employeur) : "la société X" jusqu'à SAS/SARL/(Siret/au capital/dont
  const studio =
    (T.match(/soci[ée]t[ée]\s+([A-Z0-9ÉÈÀ][A-Za-z0-9ÉÈÀ-ÿ&'.\- ]{1,40}?)\s*(?:SAS|SARL|\bSA\b|\(|,|au capital|dont)/i) || [])[1] || "";

  // Titre original / projet (s'arrête avant "et pour titre", "(", ou un n° d'épisode)
  let projet = (T.match(/titre original\s*:?\s*(.+?)(?:\s+et pour titre|\s*\(|\s+\d{2,}|$)/i) || [])[1] || "";

  // Directeur artistique : "direction artistique de X" / "directeur artistique : X"
  const da =
    (T.match(/direction artistique de\s+([A-ZÉÀ][\wÀ-ÿ'\-]+(?:\s+[A-ZÉÀ][\wÀ-ÿ'\-]+)?)/i) || [])[1] ||
    (T.match(/directeu?r?ic?e?\s+artistique\s*:?\s*([A-ZÉÀ][\wÀ-ÿ'\-]+(?:\s+[A-ZÉÀ][\wÀ-ÿ'\-]+)?)/i) || [])[1] ||
    "";

  // Rôle : "rôle(s) de X pour"
  let role = (T.match(/r[ôo]le\(?s?\)?\s*(?:de|:)\s*(.+?)\s+pour\b/i) || [])[1] || "";

  // Date de réalisation : "dates suivantes : X", sinon "Date X", sinon 1re date
  const dateRaw =
    (T.match(/dates?\s*(?:suivantes?)?\s*:?\s*(\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4})/i) || [])[1] ||
    (T.match(/\bdate\s+(\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4})/i) || [])[1] ||
    (T.match(/(\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4})/) || [])[1] ||
    "";

  // Nombre de lignes : "Lignage X" / "X lignes" / "lignes : X"
  const lignes =
    (T.match(/lignage\s*:?\s*(\d+)/i) || [])[1] ||
    (T.match(/(\d+)\s*lignes?/i) || [])[1] ||
    (T.match(/lignes?\s*:?\s*(\d+)/i) || [])[1] ||
    "";

  return {
    projet: clean(projet),
    studio: clean(studio),
    employe: "", // l'artiste, c'est toi : à remplir à la main si besoin
    da: clean(da),
    date: toIso(dateRaw),
    lignes: lignes || "",
    brut: findAmount(T, "brut"),
    net: findAmount(T, "\\bnet\\b"),
    role: clean(role) || "ND",
  };
}

// Nom de fichier : YY-MM_studio_(DA si présent, sinon projet).
export function buildFilename(f) {
  let ym = "AA-MM";
  if (f.date && /^\d{4}-\d{2}-\d{2}$/.test(f.date)) {
    ym = f.date.slice(2, 4) + "-" + f.date.slice(5, 7);
  }
  const daSlug = slug(f.da);
  const third = daSlug !== "NA" ? daSlug : slug(f.projet);
  return `${ym}_${slug(f.studio)}_${third}`;
}

// Ligne pour la feuille (colonnes séparées par des tabulations).
// Date ajout · Fichier · Lien PDF · Année · Date réalisation · Projet ·
// Studio · Employé · DA · Rôle · Nb lignes · Brut · Net.
export function buildRow(f, filename) {
  const today = new Date().toISOString().slice(0, 10);
  return [
    today,
    filename,
    "",
    f.date ? f.date.slice(0, 4) : "",
    f.date || "",
    f.projet || "",
    f.studio || "",
    f.employe || "",
    f.da || "",
    f.role || "ND",
    f.lignes || "",
    f.brut || "",
    f.net || "",
  ].join("\t");
}
