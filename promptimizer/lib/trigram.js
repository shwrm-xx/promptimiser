'use strict';
// Trigramme de projet : identifiant court (3 lettres) utilisé pour préfixer les titres de
// session (ex. [PMZ]), à la place du nom complet du projet. Stocké dans .vibe-agent/trigram
// (créé par ensureLedger côté appelant). Fail-silent partout : au pire on dérive du nom de
// dossier, jamais de crash.
const fs = require('fs');
const path = require('path');
const { vibeDir } = require('./project');

function trigramFile(root) {
  return path.join(vibeDir(root), 'trigram');
}

// Normalise en 3 lettres A-Z majuscules : garde les caractères alpha, tronque/complète.
function normalize(raw) {
  const alpha = String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z]/g, '');
  if (!alpha) return null;
  return (alpha + 'XXX').slice(0, 3);
}

// Dérivation par défaut : 3 premières lettres alpha du nom de dossier du projet.
function deriveTrigram(root) {
  return normalize(path.basename(root)) || 'PMZ';
}

function readTrigram(root) {
  try {
    const raw = fs.readFileSync(trigramFile(root), 'utf8');
    const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l);
    const n = line ? normalize(line) : null;
    if (n) return n;
  } catch (_) {
    /* fichier absent ou illisible -> dérivé */
  }
  return deriveTrigram(root);
}

// Écrit le trigramme choisi par l'utilisateur (à la création d'un projet, ou à la main via
// `backlog.js trigram --set`). Retourne le trigramme normalisé effectivement écrit, ou null.
function writeTrigram(root, code) {
  const n = normalize(code);
  if (!n) return null;
  try {
    fs.mkdirSync(vibeDir(root), { recursive: true });
    const file = trigramFile(root);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, n + '\n');
    fs.renameSync(tmp, file);
    return n;
  } catch (_) {
    return null;
  }
}

// 3 propositions distinctes pour /init sur un NOUVEAU projet : la dérivation par défaut,
// puis deux variantes (squelette consonantique, lettres réparties) — dernier recours pour
// éviter les doublons si le nom du projet est court/répétitif.
function suggestTrigrams(root) {
  const name = path.basename(root);
  const alpha = name.toUpperCase().replace(/[^A-Z]/g, '');
  const out = [];
  const add = (c) => { const n = normalize(c); if (n && !out.includes(n)) out.push(n); };

  add(alpha); // défaut : 3 premières lettres
  const consonants = alpha.replace(/[AEIOUY]/g, '');
  add(consonants); // squelette consonantique
  if (alpha.length >= 3) {
    add(alpha[0] + alpha[Math.floor(alpha.length / 2)] + alpha[alpha.length - 1]); // réparti
  }
  add(alpha.slice(1)); // décalé d'une lettre
  add(alpha.slice(2)); // décalé de deux lettres

  return out.slice(0, 3);
}

module.exports = { trigramFile, readTrigram, writeTrigram, deriveTrigram, suggestTrigrams };
