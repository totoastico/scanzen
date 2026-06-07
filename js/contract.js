// ===================================================================
// contract.js — fiche "cachet voix off".
// Extraction (au mieux) des champs depuis le texte OCR + génération du
// nom de fichier et de la ligne pour la feuille Google.
// Heuristiques simples : l'utilisateur vérifie/corrige toujours.
// ===================================================================

function clean(s) {
  return (s || "").replace(/[ \t ]+/g, " ").trim();
}

// Slug propre pour un nom de fichier (sans accents ni caractères spéciaux).
function slug(s) {
  return (
    clean(s)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "NA"
  );
}

// Valeur après un libellé (ex. "Directeur artistique : Jean Dupont").
function afterLabel(text, labels) {
  for (const lab of labels) {
    const m = text.match(new RegExp(lab + "\\s*[:\\-–]?\\s*([^\\n]+)", "i"));
    if (m && clean(m[1])) return clean(m[1]).slice(0, 80);
  }
  return "";
}

function normNum(s) {
  return (s || "").replace(/[  ]/g, "").replace(",", ".").replace(/[^\d.]/g, "");
}

function findAmount(text, keyword) {
  const m = text.match(new RegExp(keyword + "[^\\d]{0,25}(\\d[\\d \\u00a0.,]*)", "i"));
  return m ? normNum(m[1]) : "";
}

function findDate(text) {
  const months = {
    janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
    juillet: 7, août: 8, aout: 8, septembre: 9, octobre: 10, novembre: 11,
    décembre: 12, decembre: 12,
  };
  let m = text.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? "20" + m[3] : m[3];
    return `${y}-${String(+m[2]).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
  }
  m = text.match(/(\d{1,2})\s+([A-Za-zàâéèêûô]+)\s+(\d{4})/);
  if (m && months[m[2].toLowerCase()]) {
    return `${m[3]}-${String(months[m[2].toLowerCase()]).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
  }
  return "";
}

// Devine les champs depuis le texte OCR. Tout est corrigeable ensuite.
export function extractFields(text) {
  text = text || "";
  const lig =
    text.match(/(\d+)\s*lignes?/i) || text.match(/lignes?\s*[:\-–]?\s*(\d+)/i);
  return {
    projet: afterLabel(text, ["projet", "œuvre", "oeuvre", "titre", "production"]),
    studio: afterLabel(text, ["studio", "société", "societe", "employeur"]),
    employe: afterLabel(text, ["comédien", "comedien", "interprète", "interprete", "artiste", "salarié", "salarie"]),
    da: afterLabel(text, ["directeur artistique", "directrice artistique", "\\bD\\.?A\\.?\\b"]),
    date: findDate(text),
    lignes: lig ? lig[1] : "",
    brut: findAmount(text, "brut"),
    net: findAmount(text, "net"),
    role: afterLabel(text, ["rôle", "role", "personnage"]) || "ND",
  };
}

// Nom de fichier : YY-MM_studio_DA (déduit de la date de réalisation).
export function buildFilename(f) {
  let ym = "AA-MM";
  if (f.date && /^\d{4}-\d{2}-\d{2}$/.test(f.date)) {
    ym = f.date.slice(2, 4) + "-" + f.date.slice(5, 7);
  }
  return `${ym}_${slug(f.studio)}_${slug(f.da)}`;
}

// Ligne pour la feuille (colonnes séparées par des tabulations).
// Ordre = Date ajout · Fichier · Lien PDF · Année · Date réalisation ·
//         Projet · Studio · Employé · DA · Rôle · Nb lignes · Brut · Net.
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
