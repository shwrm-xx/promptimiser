'use strict';
// Numérotation de lot par projet, pour le nommage de session « [XXX] Lot N » (trigramme,
// lot #35). Stocké dans .vibe-agent/lot-counter.json (créé par ensureLedger côté appelant).
// Fail-silent partout : au pire on retombe sur lot 1 / trigramme dérivé du nom de dossier.
const fs = require('fs');
const path = require('path');
const { vibeDir, git } = require('./project');
const { writeAtomic, readJson } = require('./fsjson');
const trigramLib = require('./trigram');

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

// Écrit le label d'epic global (.vibe-agent/epic), utilisé par /scope au découpage
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

// Repli quand aucun plan (epic) ne nomme le lot travaillé — cf. nomenclature validée
// utilisateur : « [XXX] Session Libre · résumé » (pas de #lot, il n'y a pas de plan nommé).
const SESSION_LIBRE = 'Session Libre';

function truncateTitle(title) {
  const t = String(title == null ? '' : title);
  return t.length > 50 ? t.slice(0, 49) + '…' : t;
}

// Retire un préfixe de numérotation métier redondant (« Lot E1 — », « Lot A0 : ») du focus :
// la numérotation canonique du titre de session est désormais « #<id backlog> », ce label
// ferait doublon (ex. « Diffusion pmz #34 · Lot E1 — Namespace »).
function stripLotPrefix(title) {
  return String(title == null ? '' : title).replace(/^lots?\s+[^\s—–:-]+\s*[—–:-]\s*/i, '');
}

// Nom de plan (≤ 3 mots) = l'epic du lot, le « voyageur » qui reste juste selon le lot
// réellement travaillé (décision utilisateur). Coupe au 1er séparateur — / – / : d'un libellé
// long, puis borne à 3 mots. Epic absent/vide -> null (le titre bascule en « Session Libre »).
function planName(l) {
  const raw = l && l.epic ? String(l.epic).trim() : '';
  if (!raw) return null;
  const head = raw.split(/\s+[—–:]\s+/)[0].trim() || raw;
  const words = head.split(/\s+/).slice(0, 3).join(' ').replace(/[\s—–:·-]+$/, '');
  return words || null;
}

// Titre de session pour un lot backlog donné — nomenclature « [XXX · #Y] PlanTitle · Lot #X · résumé »
// (validée utilisateur 2026-07-13) : deux numéros distincts, chacun accolé à ce qu'il qualifie.
//   - Y = ID backlog GLOBAL (le « #N » de `backlog.js show`), accolé au trigramme.
//   - X = rang du lot DANS SON PLAN (epic), remis à zéro à chaque plan (cf. lotRankInEpic),
//         accolé au nom de plan — colle au modèle mental « lot 1..5 de ce plan ».
// Sans epic : « [XXX · #Y] Session Libre · résumé » (pas de plan → pas de « Lot #X »). Sans lot
// du tout (id null, cas déduit) : « [XXX] Session Libre · résumé » (pas d'id à afficher).
// Suffixe « (partie N) » quand N>1 sessions ont travaillé ce lot sans le clore (touches ≤1 : rien).
function titleForLot(trigram, l, touches, rank) {
  const resume = truncateTitle(stripLotPrefix(l.title));
  const plan = planName(l);
  const tag = l.id != null ? `${trigram} · #${l.id}` : trigram;
  const base = plan
    ? `[${tag}] ${plan} · ${rank ? `Lot #${rank} · ` : ''}${resume}`
    : `[${tag}] ${SESSION_LIBRE} · ${resume}`;
  return touches > 1 ? `${base} (partie ${touches})` : base;
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
  const trigram = trigramLib.readTrigram(root);
  const libre = `[${trigram}] ${SESSION_LIBRE}`;
  try {
    // require paresseux : backlog.js require lot.js en tête, un require en tête ici
    // créerait un cycle de modules.
    const backlog = require('./backlog');
    const { previousSessionId } = require('./state');
    const b = backlog.loadBacklog(root);
    if (b.lots.length) {
      // Lot en cours (travail qui continue) : le focus du lot backlog prime, jamais de
      // numéro d'ID concurrent. touchLot compte les sessions successives qui laissent ce
      // lot ouvert (« (partie N) » si >1, cf. titleForLot) — incrémenté ICI (une fois par
      // vrai démarrage de session, cf. hooks/session-start.js) car c'est le seul point de
      // passage qui décrit la session précédente à la session suivante.
      // Rang dans le plan calculé au point d'appel (backlog `b` sous la main).
      const T = (l, touches) => titleForLot(trigram, l, touches, backlog.lotRankInEpic(b, l));
      const cur = backlog.currentLot(b);
      if (cur) {
        const touches = backlog.touchLot(root, cur.id) || 1;
        return T(cur, touches);
      }
      const prevSid = previousSessionId(root);
      // Chemin PRIMAIRE : le lot que la session PRÉCÉDENTE a réellement clos (attribution
      // par closed_session_id, posé par stop.js). Fiable, indépendant des horodatages sales,
      // et distinct d'une session à l'autre — chaque session clôt son propre lot, donc plus
      // de titre figé identique sur plusieurs sessions (bug japlan : 3 sessions → même #34).
      const mine = backlog.lotClosedBySession(b, prevSid);
      if (mine) return T(mine, 0);
      // Repli SANS attribution possible (clôture manuelle/legacy, closed_session_id absent) :
      // dernier lot clos par id. Mais un lot clos par une session ANTÉRIEURE à la précédente
      // ne décrit pas cette session-là (ex. « état des lieux » qui n'a rien clos) : on ne
      // l'affiche que si aucune preuve du contraire n'existe — closed_session_id absent =>
      // affiché (mieux qu'un titre nu) ; présent mais ≠ session précédente => tu.
      const last = backlog.lastDoneLot(b);
      if (last) {
        const knownStale = last.closed_session_id && prevSid && last.closed_session_id !== prevSid;
        // Pas de « (partie N) » sur un lot déjà clos : le travail est fini, peu importe
        // combien de sessions ça a pris pour y arriver.
        if (!knownStale) return T(last, 0);
      }
      // Prochain lot à faire : dernier recours, encore à venir.
      const next = backlog.nextLot(b);
      if (next) return T(next, 0);
      // Plan non vide mais rien d'exploitable pour CETTE session (lot clos périmé, rien
      // à faire ensuite) : un titre EXISTE dans le plan mais ne décrit pas la session
      // précédente — le taire plutôt que le remplacer par une autre supposition (même
      // logique que le fix « ne jamais mentir sur ce qui a été fait »).
      return libre;
    }
  } catch (_) {
    /* fail-open : on tente quand même la déduction ci-dessous */
  }
  // Aucun titre dans le plan (backlog absent ou vide) : session sans plan nommé -> « Session
  // Libre », suffixée d'un résumé déduit des infos disponibles (dernier titre CHANGELOG, sinon
  // dernier commit) plutôt qu'un titre nu, non descriptif.
  const deduced = deduceTitle(root);
  return deduced ? `${libre} · ${truncateTitle(stripLotPrefix(deduced))}` : libre;
}

module.exports = { readEpic, writeEpic, getLotCounter, incrementLot, suggestedTitle, MAX_EPIC };
