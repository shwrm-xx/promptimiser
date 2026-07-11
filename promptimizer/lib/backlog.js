'use strict';
// Plan de lots persistant du projet : .vibe-agent/backlog.json.
// Un lot = une unité de livraison (1 commit), trans-session — à ne pas confondre avec
// les todos de Claude Code (étapes d'exécution volatiles, capturées à part).
// Le fichier doit rester lisible d'un coup d'œil : caps stricts, pas de champs Jira.
// Fail-silent partout (même philosophie que lot.js) : au pire, backlog vide valide.
const path = require('path');
const { vibeDir, ensureLedger, git } = require('./project');
const { writeAtomic, readJson } = require('./fsjson');
const { getLotCounter } = require('./lot');

const MAX_LOTS_OPEN = 20; // lots todo+in_progress ; au-delà c'est un Jira, refus doux
const MAX_TITLE = 80;
const MAX_SCOPE = 400;
const MAX_MODEL_HINT = 40; // préconisation de modèle par lot (ex. « sonnet », « opus »)
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
      closed_commit: l.closed_commit || null,
      closed_at: l.closed_at || null,
      closed_session_id: l.closed_session_id || null,
      started_at: l.started_at || null,
      lot_number: Number.isFinite(l.lot_number) ? l.lot_number : null,
      note: l.note ? trunc(l.note, MAX_NOTE) : null,
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
function addLot(root, title, scope, modelHint) {
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
    closed_commit: null,
    closed_at: null,
    closed_session_id: null,
    started_at: null,
    lot_number: null,
    note: null,
  };
  b.lots.push(lot);
  b.next_id += 1;
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
  return saveBacklog(root, b) ? lot : null;
}

// Idempotent : un lot déjà done est rendu tel quel, sans réécriture.
// lot_number par défaut = compteur+1 (le numéro du lot en cours de clôture, convention
// du titre de session « Lot N+1 ») ; stop.js passe la valeur fraîchement incrémentée.
// sessionId (optionnel) : id de la session qui clôt le lot — permet à suggestedTitle de
// vérifier que le lot décrit bien LA session précédente et pas une clôture plus ancienne
// (cf. lib/state.js: previousSessionId). Absent pour une clôture manuelle via le CLI.
function doneLot(root, id, commitSha, lotNumber, sessionId) {
  const b = loadBacklog(root);
  const lot = findLot(b, id);
  if (!lot) return null;
  if (lot.status === 'done') return lot;
  lot.status = 'done';
  lot.closed_commit = commitSha || git(['log', '-1', '--format=%h'], root) || null;
  lot.closed_at = now();
  lot.closed_session_id = sessionId || null;
  lot.lot_number = Number.isFinite(lotNumber) ? lotNumber : getLotCounter(root) + 1;
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

// Dernier lot clos (plus grand lot_number, sinon closed_at le plus récent) — décrit ce
// qui vient d'être FAIT, utile pour nommer une session qui vient de clore un lot sans
// qu'aucun autre ne soit encore in_progress/todo (sinon suggestedTitle retombe sur un
// titre nu, non descriptif).
function lastDoneLot(b) {
  const done = b.lots.filter((l) => l.status === 'done');
  if (!done.length) return null;
  done.sort((a, c) => (c.lot_number || 0) - (a.lot_number || 0)
    || String(c.closed_at || '').localeCompare(String(a.closed_at || '')));
  return done[0];
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
  backlogFile, loadBacklog, saveBacklog, addLot, startLot, doneLot, dropLot, noteLot,
  currentLot, nextLot, lastDoneLot, progress, summaryLines, reconcile,
  todoSnapshotFile, writeTodoSnapshot, readTodoSnapshot,
  MAX_LOTS_OPEN, MAX_TITLE, MAX_SCOPE, MAX_MODEL_HINT, MAX_NOTE, MAX_TODOS,
};
