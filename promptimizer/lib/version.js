'use strict';
// Version du package Promptimizer lui-même (pas du projet cible où PMZ est installé).
// Stockée dans promptimizer/VERSION, copiée telle quelle à l'install. Entier simple
// incrémenté à chaque évolution notable de PMZ (pas de semver : un seul mainteneur,
// pas de distinction major/minor/patch utile ici). Fail-open : jamais de throw.
const fs = require('fs');
const path = require('path');

const VERSION_FILE = path.join(__dirname, '..', 'VERSION');

function readVersion() {
  try {
    const raw = fs.readFileSync(VERSION_FILE, 'utf8').trim();
    return raw || null;
  } catch (_) {
    return null;
  }
}

// Réservé au dépôt source (mainteneur) : incrémente et persiste. Jamais appelé par les
// hooks installés dans un projet cible.
function bumpVersion() {
  const current = parseInt(readVersion(), 10);
  const next = (Number.isFinite(current) ? current : 0) + 1;
  fs.writeFileSync(VERSION_FILE, String(next) + '\n');
  return next;
}

module.exports = { readVersion, bumpVersion, VERSION_FILE };
