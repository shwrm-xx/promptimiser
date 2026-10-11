'use strict';
// Version du package Promptimizer lui-même (pas du projet cible où PMZ est installé).
// Stockée dans promptimizer/VERSION, copiée telle quelle à l'install. Semver (x.y.z, lot D3)
// aligné sur .claude-plugin/plugin.json : les deux canaux (manuel/plugin) partagent le même
// numéro, plus besoin de conversion entier → semver dans build-plugin.js. Fail-open : jamais
// de throw.
const fs = require('fs');
const path = require('path');

const VERSION_FILE = path.join(__dirname, '..', 'VERSION');
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function readVersion() {
  try {
    const raw = fs.readFileSync(VERSION_FILE, 'utf8').trim();
    return raw || null;
  } catch (_) {
    return null;
  }
}

function parseSemver(v) {
  const m = SEMVER_RE.exec(String(v || '').trim());
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

// Compare deux versions semver "x.y.z" -> -1/0/1, ou null si l'une des deux n'est pas un
// semver valide (l'appelant traite null comme « non comparable », jamais comme un crash).
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// Réservé au dépôt source (mainteneur) : incrémente et persiste. Jamais appelé par les
// hooks installés dans un projet cible. level : 'patch' (défaut) | 'minor' | 'major'.
function bumpVersion(level) {
  const [major0, minor0, patch0] = parseSemver(readVersion()) || [0, 0, 0];
  let major = major0, minor = minor0, patch = patch0;
  if (level === 'major') { major += 1; minor = 0; patch = 0; }
  else if (level === 'minor') { minor += 1; patch = 0; }
  else { patch += 1; }
  const next = `${major}.${minor}.${patch}`;
  fs.writeFileSync(VERSION_FILE, next + '\n');
  return next;
}

module.exports = { readVersion, bumpVersion, compareSemver, parseSemver, VERSION_FILE };
