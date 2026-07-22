'use strict';
// Primitives JSON sur fichier, fail-silent. Mutualisées par ledger.js et state.js.
const fs = require('fs');

// Écriture atomique : tmp UNIQUE (pid + horodatage) puis rename. Le nom unique évite
// qu'un PostToolUse concurrent écrase le .tmp d'un autre avant son rename.
function writeAtomic(file, obj) {
  try {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (_) {
    return false;
  }
}

// Lecture défensive : renvoie fallback sur fichier absent/illisible/JSON invalide/non-objet.
function readJson(file, fallback) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : fallback;
  } catch (_) {
    return fallback;
  }
}

module.exports = { writeAtomic, readJson };
