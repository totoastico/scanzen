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
// Année sur 2 chiffres : > 50 = 19xx (ex. 92 → 1992), sinon 20xx.
function toIso(raw) {
  if (!raw) return "";
  const p = raw.split(/[-\/.]/);
  if (p.length !== 3) return "";
  let [d, mo, y] = p;
  if (y.length === 2) y = (+y > 50 ? "19" : "20") + y;
  return `${y}-${String(+mo).padStart(2, "0")}-${String(+d).padStart(2, "0")}`;
}

// Date de NAISSANCE de l'utilisateur : ne doit JAMAIS être prise pour une
// date de prestation.
const BIRTHDATE_ISO = "1992-05-23";

// Trouve la date de RÉALISATION (prestation). On collecte toutes les dates,
// on écarte celles qui ne peuvent pas être une prestation (date de
// naissance exacte, contexte « né(e) le / naissance », année < 2015 — une
// prestation est forcément récente), puis on PRÉFÈRE une date placée juste
// après un mot-clé de prestation ; à défaut, la 1re date plausible.
function findRealizationDate(T) {
  const DATE = /\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4}/g;
  const cands = [];
  let m;
  while ((m = DATE.exec(T)) !== null) {
    const iso = toIso(m[0]);
    if (!iso) continue;
    const year = +iso.slice(0, 4);
    const before = T.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    const isBirth =
      iso === BIRTHDATE_ISO ||
      year < 2015 ||
      /naiss|n[ée]e?\s+le\b/.test(before);
    cands.push({ iso, index: m.index, ok: !isBirth });
  }
  const pool = cands.filter((c) => c.ok);
  if (!pool.length) return "";

  const KW = /(r[ée]alis|prestation|enregistr|s[ée]ance|tournage|dates?\s+suivantes?|effectu|p[ée]riode)/gi;
  const kw = [];
  let k;
  while ((k = KW.exec(T)) !== null) kw.push(k.index);

  let best = null;
  let bestDist = Infinity;
  for (const c of pool) {
    for (const kp of kw) {
      const dist = c.index - kp; // mot-clé AVANT la date, à portée
      if (dist >= 0 && dist < 60 && dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }
  }
  return (best || pool[0]).iso;
}

// Enlève les MAJUSCULES inutiles : un mot écrit TOUT EN CAPITALES devient
// "Capitalisé" (1re lettre majuscule, reste minuscule). Les mots déjà en
// casse normale ne changent pas. Ex. "VINCENT VIOLETTE" → "Vincent Violette".
function softTitle(s) {
  return clean(s).replace(/\S+/g, (w) => {
    if (w.length >= 2 && w === w.toUpperCase() && w.toLowerCase() !== w.toUpperCase()) {
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }
    return w;
  });
}

export function extractFields(text) {
  const T = (text || "").replace(/ /g, " ").replace(/\s+/g, " ");

  // Studio (employeur) : "la société X" jusqu'à SAS/SARL/(Siret/au capital/dont
  let studio =
    (T.match(/soci[ée]t[ée]\s+([A-Z0-9ÉÈÀ][A-Za-z0-9ÉÈÀ-ÿ&'.\- ]{1,40}?)\s*(?:SAS|SARL|\bSA\b|\(|,|au capital|dont)/i) || [])[1] || "";
  // Faux positif : une formule juridique ("signataire mandatée à cet effet"…)
  // n'est pas un nom de studio.
  if (/signataire|mandat/i.test(studio)) studio = "";

  // Titre original / projet (s'arrête avant "et pour titre", "(", ou un n° d'épisode)
  let projet = (T.match(/titre original\s*:?\s*(.+?)(?:\s+et pour titre|\s*\(|\s+\d{2,}|$)/i) || [])[1] || "";

  // Directeur artistique : "direction artistique de X" / "directeur artistique : X"
  const da =
    (T.match(/direction artistique de\s+([A-ZÉÀ][\wÀ-ÿ'\-]+(?:\s+[A-ZÉÀ][\wÀ-ÿ'\-]+)?)/i) || [])[1] ||
    (T.match(/directeu?r?ic?e?\s+artistique\s*:?\s*([A-ZÉÀ][\wÀ-ÿ'\-]+(?:\s+[A-ZÉÀ][\wÀ-ÿ'\-]+)?)/i) || [])[1] ||
    "";

  // Rôle : "rôle(s) de (ou créer la voix) de X dans l'œuvre…" (Deluxe,
  // Titra, Transperfect) ou "rôle(s) de X pour…" (Video Adapt).
  // On saute le "(ou créer la voix) de" et on s'arrête au PREMIER
  // "dans"/"pour" pour ne pas avaler les cases à cocher qui suivent.
  // Le "(ou créer la voix) de" est tolérant aux fautes d'OCR : "la voix"
  // devient souvent "ln voix"/"1a voix"… → on accepte n'importe quel petit
  // mot entre "créer" et "voix".
  let role =
    (T.match(
      /r[ôo]le\(?s?\)?\s*(?:de|:)\s*(?:\(?\s*ou\s+cr[ée]+r\s+\S+\s+voix\s*\)?\s*(?:de)?\s*:?\s*)?(.+?)\s+(?:dans|pour)\b/i
    ) || [])[1] || "";
  // Trop long = du bruit d'OCR (formulaire, cases à cocher…), pas un rôle.
  if (role.length > 60) role = "";
  // Rogne le bruit d'OCR en fin de capture : chiffres et ponctuation isolés
  // (ex. "Jacek 5" → "Jacek"). On ne touche pas aux lettres.
  role = role.replace(/[\s\d.,;:?!]+$/, "").trim();
  // Convention perso : "AMB" / "amb." / "ambiance(s)" → "Ambiances".
  role = role.replace(/\bamb\w*\.?/gi, "Ambiances");

  // Date de réalisation (prestation) — jamais la date de naissance.
  const dateIso = findRealizationDate(T);

  // Nombre de lignes : "Lignage X" / "X lignes" / "lignes : X"
  const lignes =
    (T.match(/lignage\s*:?\s*(\d+)/i) || [])[1] ||
    (T.match(/(\d+)\s*lignes?/i) || [])[1] ||
    (T.match(/lignes?\s*:?\s*(\d+)/i) || [])[1] ||
    "";

  const studioName = softTitle(studio);
  const roleName = softTitle(role);
  return {
    projet: softTitle(projet),
    studio: studioName,
    // Par défaut l'employeur = le studio (recopié à l'identique). À corriger
    // dans le formulaire si l'employeur diffère du studio d'enregistrement.
    employe: studioName,
    da: softTitle(da),
    date: dateIso,
    lignes: lignes || "",
    brut: findAmount(T, "brut"),
    net: findAmount(T, "\\bnet\\b"),
    role: roleName || "ND",
  };
}

// Vrai si le texte d'une page ressemble au DÉBUT d'un contrat
// (en-tête type contrat de doublage / artiste-interprète). Sert à
// découper automatiquement un lot de pages en plusieurs contrats.
export function isContractStart(text) {
  const t = (text || "").toLowerCase().replace(/\s+/g, " ");
  if (!t) return false;
  const head = t.slice(0, 700); // l'en-tête est toujours en haut de page
  const hasContrat = /contrat|engag[ée]/.test(head);
  const startSig =
    /(entre les soussign|engag[ée]\(?e?\)?\s+pour|n[°ºo]\s*d[' ]?objet|artiste[-\s]?interpr|contrat d[' ]?artiste|contrat de travail|contrat d[' ]?engagement|dur[ée]e d[ée]termin[ée]e d[' ]?usage)/.test(
      head
    );
  return hasContrat && startSig;
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

