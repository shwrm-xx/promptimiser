'use strict';
// Numérotation de lot par projet, pour le nommage de session « Epic — Lot N ».
// Stocké dans .vibe-agent/lot-counter.json (créé par ensureLedger côté appelant).
// Fail-silent partout : au pire on retombe sur lot 1 / nom de dossier.
const fs = require('fs');
const path = require('path');
const { vibeDir } = require('./project');
const { writeAtomic, readJson } = require('./fsjson');

function counterFile(root) {
  return path.join(vibeDir(root), 'lot-counter.json');
}

function epicFile(root) {
  return path.join(vibeDir(root), 'epic');
}

// Nom de l'epic : fichier .vibe-agent/epic (1re ligne non vide) si présent,
// sinon le nom du dossier du repo.
function readEpic(root) {
  try {
    const raw = fs.readFileSync(epicFile(root), 'utf8');
    const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l);
    if (line) return line;
  } catch (_) {
    /* fichier absent ou illisible -> fallback */
  }
  return path.basename(root);
}

// Cherche le plus grand "(lot N)" dans CHANGELOG.md pour amorcer le compteur sans
// repartir de zéro sur un projet qui numérotait déjà ses lots à la main.
function seedFromChangelog(root) {
  try {
    const content = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const re = /\(lot\s+(\d+)\)/gi;
    let max = 0;
    let m;
    while ((m = re.exec(content))) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max;
  } catch (_) {
    return 0;
  }
}

function getLotCounter(root) {
  const existing = readJson(counterFile(root), null);
  if (existing && typeof existing.last_lot === 'number') return existing.last_lot;
  return seedFromChangelog(root);
}

function incrementLot(root) {
  const next = getLotCounter(root) + 1;
  writeAtomic(counterFile(root), { last_lot: next });
  return next;
}

function suggestedTitle(root) {
  const base = `${readEpic(root)} — Lot ${getLotCounter(root) + 1}`;
  try {
    // require paresseux : backlog.js require lot.js en tête, un require en tête ici
    // créerait un cycle de modules.
    const backlog = require('./backlog');
    const b = backlog.loadBacklog(root);
    // Ordre : lot en cours (travail qui continue) > dernier lot clos (ce qui vient
    // d'être fait — le cas le plus fréquent juste après une clôture, sinon le titre
    // retombe nu) > prochain lot à faire (dernier recours, encore à venir).
    const cur = backlog.currentLot(b) || backlog.lastDoneLot(b) || backlog.nextLot(b);
    if (cur) return `${base} : ${cur.title.length > 40 ? cur.title.slice(0, 39) + '…' : cur.title}`;
  } catch (_) {
    /* fail-open : titre de base */
  }
  return base;
}

module.exports = { readEpic, getLotCounter, incrementLot, suggestedTitle };
