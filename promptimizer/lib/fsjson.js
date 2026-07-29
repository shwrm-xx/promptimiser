'use strict';
// Primitives JSON sur fichier, fail-silent. Mutualisées par ledger.js et state.js.
const fs = require('fs');

// Écriture atomique : tmp UNIQUE (pid + horodatage) puis rename. Le nom unique évite
// qu'un PostToolUse concurrent écrase le .tmp d'un autre avant son rename.
function writeAtomic(file, obj) {
  return writeAtomicText(file, JSON.stringify(obj, null, 2));
}

// Variante texte brut (mêmes garanties) — pour les artefacts non-JSON (handoff.md).
function writeAtomicText(file, text) {
  try {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    return true;
  } catch (_) {
    return false;
  }
}

// Lecture défensive : renvoie fallback sur fichier absent/illisible/JSON invalide/non-objet.
// Sur JSON.parse en échec (fichier existant non vide = corruption, pas simple absence),
// quarantaine best-effort en <file>.corrupt AVANT de renvoyer le fallback : sans quoi le
// prochain writeAtomic écraserait l'accumulé trans-session sans laisser de trace récupérable.
// Un seul exemplaire conservé (existsSync avant rename) : comportement identique sur POSIX et
// Windows (rename vers une destination existante échoue sous Windows, ce qui préserverait sinon
// arbitrairement le fichier selon la plateforme). Le cas « JSON valide mais non-objet » (ex. un
// nombre ou null) n'est volontairement PAS quarantiné : ce n'est pas une corruption.
function readJson(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return fallback;
  }
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : fallback;
  } catch (_) {
    if (raw && raw.trim()) {
      try {
        const corrupt = `${file}.corrupt`;
        if (!fs.existsSync(corrupt)) fs.renameSync(file, corrupt);
      } catch (_) {
        /* fail-open */
      }
    }
    return fallback;
  }
}

module.exports = { writeAtomic, writeAtomicText, readJson };
