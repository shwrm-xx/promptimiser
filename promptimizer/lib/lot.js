'use strict';
// Numérotation de lot par projet, pour le nommage de session « Epic — Lot N ».
// Stocké dans .vibe-agent/lot-counter.json (créé par ensureLedger côté appelant).
// Fail-silent partout : au pire on retombe sur lot 1 / nom de dossier.
const fs = require('fs');
const path = require('path');
const { vibeDir, git } = require('./project');
const { writeAtomic, readJson } = require('./fsjson');

function counterFile(root) {
  return path.join(vibeDir(root), 'lot-counter.json');
}

const MAX_EPIC = 60;

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

// Écrit le label d'epic global (.vibe-agent/epic), utilisé par /pmz-scope au découpage
// d'une demande. Label = simple chaîne (cf. ARCHITECTURE.md « Epic = label, pas conteneur »).
function writeEpic(root, name) {
  const trimmed = String(name == null ? '' : name).trim().slice(0, MAX_EPIC);
  if (!trimmed) return false;
  try {
    fs.mkdirSync(vibeDir(root), { recursive: true });
    const file = epicFile(root);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, trimmed + '\n');
    fs.renameSync(tmp, file);
    return true;
  } catch (_) {
    return false;
  }
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

function truncateTitle(title) {
  return title.length > 40 ? title.slice(0, 39) + '…' : title;
}

function withSuffix(base, l) {
  return `${base} : ${truncateTitle(l.title)}`;
}

// Numéro affiché dans le titre pour un lot backlog donné : l'ID du backlog (le
// référentiel que l'utilisateur voit dans `backlog.js show`), jamais le compteur
// lot-counter.json qui avance indépendamment (y compris sur des commits de
// bookkeeping de clôture) et dérive donc du numéro backlog au fil du projet.
// Le label epic du lot (champ optionnel `epic` du backlog) prime sur l'epic global du
// projet quand présent — permet à un backlog multi-epics de nommer chaque lot correctement.
function titleForBacklogLot(epic, l) {
  return `${l.epic || epic} — Lot ${l.id} : ${truncateTitle(l.title)}`;
}

// Intitulé déduit du dernier titre `## ...` de CHANGELOG.md (parenthèse finale de la
// ligne, convention de ce dépôt : « ## [x.y.z] — date (résumé) » ou « ## date (résumé) »).
// Ignore une parenthèse qui n'est qu'un marqueur « (lot N) » : déjà repris par le
// numéro de la base, pas descriptif en soi.
function deduceFromChangelog(root) {
  try {
    const content = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const heading = content.split(/\r?\n/).find((l) => /^##\s+/.test(l));
    if (!heading) return null;
    const m = heading.match(/\(([^)]+)\)\s*$/);
    if (!m) return null;
    const text = m[1].trim();
    if (!text || /^lot\s+\d+$/i.test(text)) return null;
    return text;
  } catch (_) {
    return null;
  }
}

// Dernier recours : sujet du dernier commit (quasi toujours présent — un lot, c'est
// un commit, cf. discipline de dépôt).
function deduceFromGit(root) {
  return git(['log', '-1', '--format=%s'], root) || null;
}

function deduceTitle(root) {
  return deduceFromChangelog(root) || deduceFromGit(root);
}

function suggestedTitle(root) {
  const epic = readEpic(root);
  const base = `${epic} — Lot ${getLotCounter(root) + 1}`;
  try {
    // require paresseux : backlog.js require lot.js en tête, un require en tête ici
    // créerait un cycle de modules.
    const backlog = require('./backlog');
    const { previousSessionId } = require('./state');
    const b = backlog.loadBacklog(root);
    if (b.lots.length) {
      // Lot en cours (travail qui continue) : toujours le suffixe le plus sûr. Le numéro
      // affiché est l'ID backlog du lot (référentiel vu par l'utilisateur dans
      // `backlog.js show`), pas le compteur lot-counter.json — ce dernier avance
      // indépendamment (y compris sur des commits de bookkeeping de clôture) et dérive
      // donc du numéro backlog au fil du projet.
      const cur = backlog.currentLot(b);
      if (cur) return titleForBacklogLot(epic, cur);
      // Dernier lot clos = ce qui vient d'être fait, cas le plus fréquent juste après une
      // clôture (sinon le titre retombe nu). Mais un lot clos par une session ANTÉRIEURE à
      // la précédente ne décrit pas cette session-là (ex. une session « état des lieux »
      // qui n'a rien clos) : on ne l'affiche que si aucune preuve du contraire n'existe —
      // closed_session_id absent (clôture manuelle/ancienne, pas de trace) => on l'affiche
      // quand même (mieux qu'un titre nu) ; closed_session_id présent mais différent de la
      // session précédente réelle => clôture avérée plus ancienne, on le tait.
      const last = backlog.lastDoneLot(b);
      if (last) {
        const prevSid = previousSessionId(root);
        const knownStale = last.closed_session_id && prevSid && last.closed_session_id !== prevSid;
        if (!knownStale) return titleForBacklogLot(epic, last);
      }
      // Prochain lot à faire : dernier recours, encore à venir.
      const next = backlog.nextLot(b);
      if (next) return titleForBacklogLot(epic, next);
      // Plan non vide mais rien d'exploitable pour CETTE session (lot clos périmé, rien
      // à faire ensuite) : un titre EXISTE dans le plan mais ne décrit pas la session
      // précédente — le taire plutôt que le remplacer par une autre supposition (même
      // logique que le fix « ne jamais mentir sur ce qui a été fait »).
      return base;
    }
  } catch (_) {
    /* fail-open : on tente quand même la déduction ci-dessous */
  }
  // Aucun titre dans le plan (backlog absent ou vide) : on en déduit un des infos
  // disponibles (dernier titre CHANGELOG, sinon dernier commit) plutôt que de retomber
  // sur un titre nu, non descriptif.
  const deduced = deduceTitle(root);
  return deduced ? withSuffix(base, { title: deduced }) : base;
}

module.exports = { readEpic, writeEpic, getLotCounter, incrementLot, suggestedTitle, MAX_EPIC };
