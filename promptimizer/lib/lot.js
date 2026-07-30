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

// Label d'epic RÉELLEMENT posé (.vibe-agent/epic, 1re ligne non vide), ou null. Distinct de
// readEpic, qui replie sur le nom du dossier : un titre de session ne doit jamais présenter
// « promptimiser » comme un nom de plan (cf. planSessionEpic).
function readEpicRaw(root) {
  try {
    const raw = fs.readFileSync(epicFile(root), 'utf8');
    const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l);
    if (line) return line;
  } catch (_) {
    /* fichier absent ou illisible -> null */
  }
  return null;
}

// Nom de l'epic : fichier .vibe-agent/epic (1re ligne non vide) si présent,
// sinon le nom du dossier du repo.
function readEpic(root) {
  return readEpicRaw(root) || path.basename(root);
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

// Titre d'une session de CONCEPTION — « [XXX · Plan] Thème du plan » (nomenclature validée
// utilisateur 2026-07-30, lot #130). Le thème est le nom de l'epic, jamais un lot : une session
// de plan ne livre pas de lot, elle en découpe (la titrer par le lot #1 qu'elle vient de démarrer
// décrirait un travail qui n'a pas encore commencé).
const PLAN_TAG = 'Plan';

function titleForPlanSession(trigram, epic) {
  return `[${trigram} · ${PLAN_TAG}] ${truncateTitle(epic)}`;
}

// Thème à afficher pour une session de plan : l'epic du DERNIER lot créé (plus grand id) — ce
// que le découpage vient de nommer — sinon le label global .vibe-agent/epic (posé par
// `/pmz:scope` étape 3). null si aucun epic nulle part : rien à annoncer, on retombe alors sur
// la logique normale plutôt que d'inventer un nom de plan.
function planSessionEpic(root, b) {
  const lots = (b && Array.isArray(b.lots)) ? b.lots.slice() : [];
  lots.sort((a, c) => (c.id || 0) - (a.id || 0));
  const fromLot = (lots.length && lots[0].epic) ? String(lots[0].epic).trim() : '';
  return fromLot || readEpicRaw(root);
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
    const { previousSessionMeta } = require('./state');
    const b = backlog.loadBacklog(root);
    if (b.lots.length) {
      // Lot en cours (travail qui continue) : le focus du lot backlog prime, jamais de
      // numéro d'ID concurrent. touchLot compte les sessions successives qui laissent ce
      // lot ouvert (« (partie N) » si >1, cf. titleForLot) — incrémenté ICI (une fois par
      // vrai démarrage de session, cf. hooks/session-start.js) car c'est le seul point de
      // passage qui décrit la session précédente à la session suivante.
      // Rang dans le plan calculé au point d'appel (backlog `b` sous la main).
      const T = (l, touches) => titleForLot(trigram, l, touches, backlog.lotRankInEpic(b, l));
      const prev = previousSessionMeta(root);
      const prevSid = prev.id;
      // Chemin PRIMAIRE : le lot que la session PRÉCÉDENTE a réellement clos (attribution
      // par closed_session_id, posé par stop.js). Fiable, indépendant des horodatages sales,
      // et distinct d'une session à l'autre — chaque session clôt son propre lot, donc plus
      // de titre figé identique sur plusieurs sessions (bug japlan : 3 sessions → même #34).
      // Vérifié AVANT le lot en cours : si la session précédente a clos un lot puis enchaîné
      // sur le suivant (cur = nouveau lot in_progress, jamais encore touché), c'est la
      // clôture qui décrit cette session-là, pas le lot fraîchement démarré (bug : titre
      // affichait le lot courant au lieu du lot clos).
      const mine = backlog.lotClosedBySession(b, prevSid);
      if (mine) return T(mine, 0);
      // Session de CONCEPTION (lot #130) : mode plan de Claude Code, ou /pmz:scope (epic posé /
      // lots ajoutés). Vérifiée APRÈS la clôture attribuée (une session qui a livré un lot est
      // décrite par ce lot, même si elle a aussi planifié la suite) mais AVANT le lot en cours :
      // une session de scope démarre le lot #1 en dernière étape, la titrer par ce lot
      // annoncerait un travail pas encore commencé.
      if (prev.plan) {
        const planEpic = planSessionEpic(root, b);
        if (planEpic) return titleForPlanSession(trigram, planEpic);
      }
      // Lot en cours (travail qui continue, rien clos par la session précédente) : le focus
      // du lot backlog prime, jamais de numéro d'ID concurrent. touchLot compte les sessions
      // successives qui laissent ce lot ouvert (« (partie N) » si >1, cf. titleForLot) —
      // incrémenté ICI (une fois par vrai démarrage de session, cf. hooks/session-start.js)
      // car c'est le seul point de passage qui décrit la session précédente à la suivante.
      const cur = backlog.currentLot(b);
      if (cur) {
        const touches = backlog.touchLot(root, cur.id) || 1;
        return T(cur, touches);
      }
      // Repli SANS attribution possible (clôture manuelle/legacy, closed_session_id absent) :
      // dernier lot clos par id. Un lot clos par une session ANTÉRIEURE à la précédente ne
      // décrit pas le TRAVAIL de cette session-là (ex. release, merge de vague, état des lieux
      // qui n'a rien clos) : dans ce cas on garde de lui ce qui reste VRAI — la position dans le
      // plan (« [XXX · #Y] Plan · Lot #X », le projet en est bien là) — et on remplace son
      // résumé par ce que la session précédente a laissé dans le dépôt (dernière entrée
      // CHANGELOG, sinon dernier commit).
      // Lot #130 : cette branche rendait « Session Libre » NUE, par prudence d'attribution.
      // Sur données réelles (9 des 12 dernières sessions de ce dépôt), c'était le cas NOMINAL —
      // vagues parallèles, réintégrations, releases et sessions courtes ne closent rien dans le
      // backlog principal — et le titre n'aidait plus personne. Un titre positionnel + le
      // dernier travail enregistré vaut mieux qu'un titre nu, systématiquement faux d'utilité.
      const last = backlog.lastDoneLot(b);
      if (last) {
        const knownStale = last.closed_session_id && prevSid && last.closed_session_id !== prevSid;
        // Pas de « (partie N) » sur un lot déjà clos : le travail est fini, peu importe
        // combien de sessions ça a pris pour y arriver.
        if (!knownStale) return T(last, 0);
        const deducedStale = deduceTitle(root);
        return T(deducedStale ? Object.assign({}, last, { title: deducedStale }) : last, 0);
      }
      // PAS de repli sur le prochain lot à faire : `nextLot` est todo, jamais touché — le
      // rendre avec `titleForLot` (même format qu'un lot clos, cf. ci-dessus) affirmerait que
      // la session précédente a fait un travail qui n'a même pas commencé (bug 2026-07-29 :
      // titre affichait le prochain lot todo comme s'il était clos). Plan sans AUCUN lot clos :
      // même traitement que sans plan — « Session Libre » + résumé déduit (jamais nue quand une
      // information existe).
      const deducedNoDone = deduceTitle(root);
      return deducedNoDone ? `${libre} · ${truncateTitle(stripLotPrefix(deducedNoDone))}` : libre;
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
