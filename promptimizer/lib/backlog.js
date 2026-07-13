'use strict';
// Plan de lots persistant du projet : .vibe-agent/backlog.json.
// Un lot = une unité de livraison (1 commit), trans-session — à ne pas confondre avec
// les todos de Claude Code (étapes d'exécution volatiles, capturées à part).
// Le fichier doit rester lisible d'un coup d'œil : caps stricts, pas de champs Jira.
// Fail-silent partout (même philosophie que lot.js) : au pire, backlog vide valide.
const path = require('path');
const { vibeDir, ensureLedger, git } = require('./project');
const { writeAtomic, readJson } = require('./fsjson');
const { getLotCounter, incrementLot } = require('./lot');

const MAX_LOTS_OPEN = 20; // lots todo+in_progress ; au-delà c'est un Jira, refus doux
const MAX_TITLE = 80;
const MAX_SCOPE = 400;
const MAX_MODEL_HINT = 40; // préconisation de modèle par lot (ex. « sonnet », « opus »)
const MAX_EPIC = 60; // label d'epic optionnel du lot, cf. .vibe-agent/epic (lib/lot.js)
const MAX_VERIFY = 150; // commande shell de preuve de clôture, exécutée par /close-batch avant done
const MAX_NOTE = 200;
const MAX_TODOS = 30;
const MAX_TODO_CHARS = 120;
const STATUSES = ['todo', 'in_progress', 'done', 'dropped'];

function backlogFile(root) {
  return path.join(vibeDir(root), 'backlog.json');
}

function todoSnapshotFile(root) {
  return path.join(vibeDir(root), 'todo-snapshot.json');
}

function trunc(s, n) {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function now() {
  return new Date().toISOString();
}

// Normalisation défensive : fichier absent/corrompu/champ invalide → backlog vide valide.
function loadBacklog(root) {
  const empty = { version: 1, next_id: 1, created_at: null, updated_at: null, lots: [] };
  if (!root) return empty;
  const raw = readJson(backlogFile(root), null);
  if (!raw) return empty;
  const lots = (Array.isArray(raw.lots) ? raw.lots : [])
    .filter((l) => l && typeof l === 'object' && Number.isFinite(l.id) && l.title)
    .map((l) => ({
      id: l.id,
      title: trunc(l.title, MAX_TITLE),
      scope: l.scope ? trunc(l.scope, MAX_SCOPE) : null,
      status: STATUSES.includes(l.status) ? l.status : 'todo',
      model_hint: l.model_hint ? trunc(l.model_hint, MAX_MODEL_HINT) : null,
      epic: l.epic ? trunc(l.epic, MAX_EPIC) : null,
      verify: l.verify ? trunc(l.verify, MAX_VERIFY) : null,
      closed_commit: l.closed_commit || null,
      closed_at: l.closed_at || null,
      closed_session_id: l.closed_session_id || null,
      closed_occupancy: Number.isFinite(l.closed_occupancy) ? l.closed_occupancy : null,
      started_at: l.started_at || null,
      lot_number: Number.isFinite(l.lot_number) ? l.lot_number : null,
      note: l.note ? trunc(l.note, MAX_NOTE) : null,
      // Nombre de sessions distinctes ayant travaillé ce lot pendant qu'il restait en cours
      // (incrémenté par touchLot, cf. lib/lot.js:suggestedTitle) — alimente le suffixe
      // « (partie N) » du titre de session quand un lot dépasse une session.
      session_touches: Number.isFinite(l.session_touches) ? l.session_touches : 0,
    }));
  const maxId = lots.reduce((m, l) => Math.max(m, l.id), 0);
  return {
    version: 1,
    next_id: Math.max(Number.isFinite(raw.next_id) ? raw.next_id : 1, maxId + 1),
    created_at: raw.created_at || null,
    updated_at: raw.updated_at || null,
    lots,
  };
}

// Sécurise le plan de lots : le stage (best-effort) dès qu'il change. Un fichier
// STAGÉ survit à un `git clean -fd` et part avec le prochain commit, ce qui ferme la
// fenêtre où un backlog fraîchement créé, encore non suivi, pouvait disparaître entre
// deux sessions. Le .vibe-agent/.gitignore (bootstrap) le whiteliste ; dans un projet
// sans ce .gitignore, `git add` marche aussi (fichier non ignoré). git() = fail-open.
function stageBacklog(root) {
  try { git(['add', '--', path.relative(root, backlogFile(root))], root); } catch (_) { /* fail-open */ }
}

function saveBacklog(root, b) {
  if (!root) return false;
  ensureLedger(root); // plomberie interne, comme les ledgers
  b.updated_at = now();
  if (!b.created_at) b.created_at = b.updated_at;
  const okw = writeAtomic(backlogFile(root), b);
  if (okw) stageBacklog(root);
  return okw;
}

function findLot(b, id) {
  return b.lots.find((l) => l.id === Number(id)) || null;
}

function openCount(b) {
  return b.lots.filter((l) => l.status === 'todo' || l.status === 'in_progress').length;
}

// null si titre vide ou plan déjà au cap (refus doux, c'est au CLI de l'expliquer).
function addLot(root, title, scope, modelHint, epic, verify) {
  const t = trunc(title, MAX_TITLE);
  if (!t) return null;
  const b = loadBacklog(root);
  if (openCount(b) >= MAX_LOTS_OPEN) return null;
  const lot = {
    id: b.next_id,
    title: t,
    scope: scope ? trunc(scope, MAX_SCOPE) : null,
    status: 'todo',
    model_hint: modelHint ? trunc(modelHint, MAX_MODEL_HINT) : null,
    epic: epic ? trunc(epic, MAX_EPIC) : null,
    verify: verify ? trunc(verify, MAX_VERIFY) : null,
    closed_commit: null,
    closed_at: null,
    closed_session_id: null,
    closed_occupancy: null,
    started_at: null,
    lot_number: null,
    note: null,
    session_touches: 0,
  };
  b.lots.push(lot);
  b.next_id += 1;
  return saveBacklog(root, b) ? lot : null;
}

// Édite la commande de preuve de clôture d'un lot existant (ex. posée après coup, une
// fois le lot déjà créé sans --verify). null si lot introuvable/clos ou commande vide.
function setVerify(root, id, verify) {
  const v = trunc(verify, MAX_VERIFY);
  if (!v) return null;
  const b = loadBacklog(root);
  const lot = findLot(b, id);
  if (!lot) return null;
  lot.verify = v;
  return saveBacklog(root, b) ? lot : null;
}

// Invariant souple : au plus un in_progress — start rétrograde les autres en todo.
function startLot(root, id) {
  const b = loadBacklog(root);
  const lot = findLot(b, id);
  if (!lot || lot.status === 'done' || lot.status === 'dropped') return null;
  for (const l of b.lots) {
    if (l.status === 'in_progress' && l.id !== lot.id) { l.status = 'todo'; l.started_at = null; }
  }
  lot.status = 'in_progress';
  lot.started_at = now();
  lot.session_touches = 0; // (re)départ = repart de « partie 1 » (pas de suffixe)
  return saveBacklog(root, b) ? lot : null;
}

// Incrémente le compteur de sessions ayant travaillé ce lot pendant qu'il restait en cours
// (appelé une fois par démarrage réel de session, cf. lib/lot.js:suggestedTitle). Approximatif
// par construction (avance même si la session n'a en fait pas touché ce lot) — même logique
// assumée que lot-counter.json (cf. commentaire de doneLot). Retourne le compteur à jour, ou
// null si le lot est introuvable/pas en cours.
function touchLot(root, id) {
  const b = loadBacklog(root);
  const lot = findLot(b, id);
  if (!lot || lot.status !== 'in_progress') return null;
  lot.session_touches = (lot.session_touches || 0) + 1;
  return saveBacklog(root, b) ? lot.session_touches : null;
}

// Idempotent : un lot déjà done est rendu tel quel, sans réécriture.
// lot_number par défaut = incrementLot(root) (avance ET persiste le compteur global) ;
// stop.js passe la valeur qu'il a déjà fait avancer lui-même pour éviter un double
// increment. Sans ce fallback qui persiste, une clôture manuelle (CLI `done`, cf.
// /close-batch) lisait juste compteur+1 SANS l'écrire : la session suivante relisait le
// même compteur figé et réattribuait le même numéro à un autre lot — d'où un « Lot N »
// qui se répète session après session au lieu d'avancer.
// sessionId (optionnel) : id de la session qui clôt le lot — permet à suggestedTitle de
// vérifier que le lot décrit bien LA session précédente et pas une clôture plus ancienne
// (cf. lib/state.js: previousSessionId). Absent pour une clôture manuelle via le CLI.
// occupancy (optionnel) : occupation contexte du tour de clôture (turnstats.computeTurn().occ),
// figée dans closed_occupancy — métrologie de coût par lot. Posée par stop.js à l'auto-clôture ;
// absente sur une clôture manuelle via le CLI (pas de transcript à ce niveau).
function doneLot(root, id, commitSha, lotNumber, sessionId, occupancy) {
  const b = loadBacklog(root);
  const lot = findLot(b, id);
  if (!lot) return null;
  if (lot.status === 'done') return lot;
  lot.status = 'done';
  lot.closed_commit = commitSha || git(['log', '-1', '--format=%h'], root) || null;
  lot.closed_at = now();
  lot.closed_session_id = sessionId || null;
  lot.closed_occupancy = Number.isFinite(occupancy) ? occupancy : null;
  lot.lot_number = Number.isFinite(lotNumber) ? lotNumber : incrementLot(root);
  return saveBacklog(root, b) ? lot : null;
}

function dropLot(root, id, note) {
  const b = loadBacklog(root);
  const lot = findLot(b, id);
  if (!lot || lot.status === 'done') return null;
  lot.status = 'dropped';
  if (note) lot.note = trunc(note, MAX_NOTE);
  return saveBacklog(root, b) ? lot : null;
}

function noteLot(root, id, note) {
  const b = loadBacklog(root);
  const lot = findLot(b, id);
  if (!lot || !note) return null;
  lot.note = trunc(note, MAX_NOTE);
  return saveBacklog(root, b) ? lot : null;
}

function currentLot(b) {
  return b.lots.find((l) => l.status === 'in_progress') || null;
}

// Premier « à faire » dans l'ordre du tableau (l'ordre est indicatif, pas contractuel).
function nextLot(b) {
  return b.lots.find((l) => l.status === 'todo') || null;
}

// Dernier lot clos = plus grand **id** (repli quand aucune attribution par session n'est
// possible, cf. lotClosedBySession + lib/lot.js). Décrit ce qui vient d'être FAIT, utile pour
// nommer une session qui a clos un lot sans qu'aucun autre ne soit in_progress/todo.
// Historique des tris essayés, tous abandonnés sur données réelles (japlan-app) :
//   - lot_number : compteur global recyclé/null sur clôtures legacy → figeait un vieux lot.
//   - closed_at  : horodatage NON fiable — mix de dates à la journée (« 2026-07-11 »), de
//     valeurs à la seconde ronde saisies à la main, et de clôtures dans le désordre ; un lot
//     ancien (#34, closed_at 23:06 édité) « battait » le vrai dernier (#40, 23:03) → même
//     titre figé session après session.
// L'id backlog est monotone, jamais recyclé, jamais null (cf. addLot) et c'est le référentiel
// affiché (#N) : le trier rend le nommage stable et immunisé aux horodatages sales. Compromis
// assumé : une clôture RÉTROACTIVE d'un vieux lot ne sera pas « le dernier » — mais ce cas est
// couvert par l'attribution par session (le chemin primaire), le repli restant un pis-aller.
function lastDoneLot(b) {
  const done = b.lots.filter((l) => l.status === 'done');
  if (!done.length) return null;
  done.sort((a, c) => (c.id || 0) - (a.id || 0));
  return done[0];
}

// Rang (1-based) d'un lot DANS SON PLAN (epic) : position par id croissant parmi les lots du
// même epic, tous statuts confondus (stable, indépendant des drops/ordre de clôture). C'est le
// « Lot #X » du titre de session — l'utilisateur pense « lot 1..5 de CE plan », pas en id global
// (#34, #40) qui ne remet jamais à zéro entre plans (retour utilisateur 2026-07-13). null si le
// lot n'a pas d'epic (pas de plan où le ranger → « Session Libre » sans « Lot #X »).
function lotRankInEpic(b, l) {
  if (!l || !l.epic) return null;
  const peers = b.lots.filter((x) => x.epic === l.epic).sort((a, c) => (a.id || 0) - (c.id || 0));
  const idx = peers.findIndex((x) => x.id === l.id);
  return idx >= 0 ? idx + 1 : null;
}

// Lot clos par UNE session donnée (closed_session_id === sid) — signal d'attribution fiable
// posé par stop.js à l'auto-clôture. Renvoie le plus grand id parmi les correspondances (la
// dernière chose que cette session a faite si elle en a clos plusieurs), ou null. C'est le
// chemin PRIMAIRE de suggestedTitle : il décrit exactement ce que la session précédente a
// clos, indépendamment des horodatages sales et sans jamais figer le même lot d'une session
// à l'autre (chaque session clôt son propre lot → titre distinct).
function lotClosedBySession(b, sid) {
  if (!sid) return null;
  const mine = b.lots.filter((l) => l.status === 'done' && l.closed_session_id === sid);
  if (!mine.length) return null;
  mine.sort((a, c) => (c.id || 0) - (a.id || 0));
  return mine[0];
}

function progress(b) {
  const active = b.lots.filter((l) => l.status !== 'dropped');
  return { done: active.filter((l) => l.status === 'done').length, total: active.length };
}

// Bloc texte compact réutilisé par le handoff auto et les messages SessionStart.
// [] si backlog absent/vide. Jamais plus de quelques lignes (anti-bloat : injecté).
function summaryLines(root) {
  try {
    const b = loadBacklog(root);
    if (!b.lots.length) return [];
    const p = progress(b);
    const cur = currentLot(b);
    const lines = [];
    let head = `Plan de lots : ${p.done}/${p.total} faits.`;
    if (cur) {
      head += ` Lot en cours : #${cur.id} « ${trunc(cur.title, 60)} »`;
      if (cur.model_hint) head += ` [modèle : ${cur.model_hint}]`;
      if (cur.scope) head += ` — ${trunc(cur.scope, 120)}`;
    }
    lines.push(head);
    const upcoming = b.lots.filter((l) => l.status === 'todo').slice(0, 3)
      .map((l) => `#${l.id} « ${trunc(l.title, 60)} »${l.model_hint ? ` [modèle : ${l.model_hint}]` : ''}`);
    if (upcoming.length) lines.push(`Suivants : ${upcoming.join(', ')}.`);
    return lines;
  } catch (_) {
    return [];
  }
}

// Capture passive de la todo-list Claude Code : TodoWrite transmet la liste COMPLÈTE à
// chaque appel → un seul fichier écrasé intégralement (dernier état connu). Jamais
// effacé en début de session (précieux après un crash) : remplacé au premier TodoWrite
// de la session suivante. `activeForm` est jeté (redondant avec content).
function writeTodoSnapshot(root, todos, sessionId) {
  try {
    if (!root || !Array.isArray(todos)) return false;
    const clean = todos
      .filter((t) => t && typeof t === 'object' && t.content)
      .slice(0, MAX_TODOS)
      .map((t) => ({ content: trunc(t.content, MAX_TODO_CHARS), status: String(t.status || 'pending') }));
    ensureLedger(root);
    return writeAtomic(todoSnapshotFile(root), {
      session_id: sessionId || null,
      updated_at: now(),
      todos: clean,
    });
  } catch (_) {
    return false;
  }
}

function readTodoSnapshot(root) {
  const raw = readJson(todoSnapshotFile(root), null);
  if (!raw || !Array.isArray(raw.todos)) return null;
  return raw;
}

// Réparation volontairement bête — jamais bloquante, jamais de matching sémantique.
function reconcile(root) {
  const fixed = [];
  const warnings = [];
  const b = loadBacklog(root);
  // 1. Plusieurs in_progress → garde le plus récemment démarré (fallback : id le plus haut).
  const inProg = b.lots.filter((l) => l.status === 'in_progress');
  if (inProg.length > 1) {
    inProg.sort((a, c) => String(c.started_at || '').localeCompare(String(a.started_at || '')) || c.id - a.id);
    for (const l of inProg.slice(1)) {
      l.status = 'todo';
      l.started_at = null;
      fixed.push(`#${l.id} rétrogradé en « à faire » (un seul lot en cours à la fois)`);
    }
  }
  // 2. done sans commit → attache le dernier commit connu.
  for (const l of b.lots) {
    if (l.status === 'done' && !l.closed_commit) {
      l.closed_commit = git(['log', '-1', '--format=%h'], root) || null;
      if (l.closed_commit) fixed.push(`#${l.id} : commit de clôture attaché (${l.closed_commit})`);
    }
  }
  // 3. Lots faits en désordre → informatif seulement, l'ordre du tableau est indicatif.
  const doneAfterTodo = b.lots.some((l, i) => l.status === 'done' &&
    b.lots.slice(0, i).some((m) => m.status === 'todo'));
  if (doneAfterTodo) warnings.push('Des lots ont été faits dans le désordre — rien à réparer, ordre indicatif.');
  if (fixed.length) saveBacklog(root, b);
  return { fixed, warnings };
}

module.exports = {
  backlogFile, loadBacklog, saveBacklog, addLot, setVerify, startLot, doneLot, dropLot, noteLot,
  touchLot, currentLot, nextLot, lastDoneLot, lotClosedBySession, lotRankInEpic, progress, summaryLines, reconcile,
  todoSnapshotFile, writeTodoSnapshot, readTodoSnapshot,
  MAX_LOTS_OPEN, MAX_TITLE, MAX_SCOPE, MAX_MODEL_HINT, MAX_EPIC, MAX_VERIFY, MAX_NOTE, MAX_TODOS,
};
