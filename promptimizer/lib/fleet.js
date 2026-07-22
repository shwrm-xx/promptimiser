'use strict';
// Registre de vague (« fleet ») : .vibe-agent/fleet.json — état PARTAGÉ des lots en vol
// d'une vague parallèle (décision D3, palier 2). C'est le handoff commun de la vague : les
// sessions filles s'y inscrivent (lot, périmètre, branche, état), et y lisent la tête de la
// branche d'intégration (déclencheur de rebase).
//
// Inerte par défaut : sans fichier fleet.json, `loadFleet().active === false` et les sessions
// restent autonomes (comportement mono-session strictement inchangé).
//
// Fail-open ABSOLU (contrat hooks) : fichier absent / JSON corrompu / champ invalide → fleet
// désactivé (active:false), jamais d'exception propagée. Un fleet corrompu ne doit JAMAIS
// gêner une session ; il se contente de la rendre autonome.
//
// Concurrence : N sessions écrivent le même fichier. Écritures atomiques (temp unique +
// rename, cf. lib/fsjson) et mutations PAR LOT (upsert/patch de la seule entrée concernée,
// via lecture-modification-écriture) pour réduire les fenêtres de course. La perte-de-mise-à-
// jour résiduelle (deux read concurrents, deux write) est assumée au palier 2 (lancement
// manuel, faible fréquence) — cf. D3 « Concurrence d'écriture ».
const fs = require('fs');
const path = require('path');
const { vibeDir, ensureLedger } = require('./project');
const { writeAtomic, readJson } = require('./fsjson');
const perimeterLib = require('./perimeter');

// État d'un lot dans la vague : en vol → prêt à merger → réintégré (cf. D3 §Registre de vague).
const STATES = ['in_flight', 'ready', 'reintegrated'];
const DEFAULT_STATE = 'in_flight';
const MAX_LOTS = 20; // aligné sur MAX_LOTS_OPEN du backlog ; au-delà ce n'est plus une vague
const MAX_STR = 200;
const MAX_HEAD = 64; // sha git (court ou long)
const MAX_EXT = 10; // demandes d'extension tracées par lot ; au-delà, l'orchestrateur doit déjà avoir tranché

function fleetFile(root) {
  return path.join(vibeDir(root), 'fleet.json');
}

// Remonte depuis `cwd` le premier dossier contenant .vibe-agent/fleet.json, ou null. Purement
// fs (aucun subprocess git) : court-circuit du hook PreToolUse pour NE PAS forker `git` à chaque
// écriture quand aucune vague n'existe (cas ultra-majoritaire). Le fichier vit à la racine du
// dépôt (là où ensureLedger crée .vibe-agent) : remonter le trouve depuis n'importe quel sous-
// dossier, sans dépendre de git. Fail-open : toute erreur → null (→ session autonome).
function findFleetRoot(cwd) {
  try {
    let dir = path.resolve(cwd || '.');
    for (let i = 0; i < 64; i++) {
      if (fs.existsSync(path.join(dir, '.vibe-agent', 'fleet.json'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch (_) {
    return null;
  }
}

function trunc(s, n) {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function now() {
  return new Date().toISOString();
}

// Squelette d'une vague inerte (aucun lot en vol). `active` est DÉRIVÉ (jamais persisté) :
// une vague est active dès qu'elle porte au moins un lot.
function inactiveFleet() {
  return {
    active: false,
    version: 1,
    wave_id: null,
    integration_branch: null,
    integration_head: null,
    created_at: null,
    updated_at: null,
    lots: [],
  };
}

// Liste dédupliquée + capée de chemins (POSIX relatifs) qu'un lot a tenté d'écrire HORS de son
// périmètre — trace passive pour l'orchestrateur, jamais un droit d'écriture. Entrée non-array
// ou éléments vides → écartés.
function normalizeExtRequests(v) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const out = [];
  for (const p of v) {
    const s = trunc(p, MAX_STR);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_EXT) break;
  }
  return out;
}

// Normalise une entrée de lot en vol. Rejette (→ null) tout ce qui n'a pas d'id fini ni de
// session propriétaire : sans propriétaire, on ne saurait pas à quelle session l'attribuer.
function normalizeLot(l) {
  if (!l || typeof l !== 'object' || !Number.isFinite(l.id) || !l.session_owner) return null;
  return {
    id: l.id,
    session_owner: trunc(l.session_owner, MAX_STR),
    branch: l.branch ? trunc(l.branch, MAX_STR) : null,
    worktree: l.worktree ? trunc(l.worktree, MAX_STR) : null,
    perimeter: perimeterLib.normalize(l.perimeter),
    state: STATES.includes(l.state) ? l.state : DEFAULT_STATE,
    title: l.title ? trunc(l.title, MAX_STR) : null,
    ext_requests: normalizeExtRequests(l.ext_requests),
  };
}

// Charge fleet.json normalisé. Fichier absent/corrompu/vide → vague inerte (active:false).
// L'objet renvoyé porte `active` (dérivé) en plus des champs persistés ; ne pas le
// re-sérialiser tel quel — passer par saveFleet, qui l'écarte.
function loadFleet(root) {
  if (!root) return inactiveFleet();
  const raw = readJson(fleetFile(root), null);
  if (!raw) return inactiveFleet();
  const lots = (Array.isArray(raw.lots) ? raw.lots : [])
    .map(normalizeLot)
    .filter(Boolean)
    .slice(0, MAX_LOTS);
  return {
    active: lots.length > 0,
    version: 1,
    wave_id: raw.wave_id ? trunc(raw.wave_id, MAX_STR) : null,
    integration_branch: raw.integration_branch ? trunc(raw.integration_branch, MAX_STR) : null,
    integration_head: raw.integration_head ? trunc(raw.integration_head, MAX_HEAD) : null,
    created_at: raw.created_at || null,
    updated_at: raw.updated_at || null,
    lots,
  };
}

// Persiste la vague. Écarte le champ dérivé `active`, horodate, crée .vibe-agent si besoin.
// Renvoie false au moindre doute (root absent, écriture impossible) — jamais d'exception.
function saveFleet(root, f) {
  if (!root || !f) return false;
  try {
    ensureLedger(root);
    const out = {
      version: 1,
      wave_id: f.wave_id || null,
      integration_branch: f.integration_branch || null,
      integration_head: f.integration_head || null,
      created_at: f.created_at || now(),
      updated_at: now(),
      lots: (Array.isArray(f.lots) ? f.lots : []).map(normalizeLot).filter(Boolean).slice(0, MAX_LOTS),
    };
    return writeAtomic(fleetFile(root), out);
  } catch (_) {
    return false;
  }
}

// Inscrit / met à jour le lot d'une session (upsert par id) : lecture-modification-écriture
// atomique ne touchant QUE l'entrée passée. Crée fleet.json si absent → active la vague.
// `entry` doit porter au moins { id, session_owner }. Renvoie false au moindre doute.
function upsertLot(root, entry) {
  const norm = normalizeLot(entry);
  if (!root || !norm) return false;
  try {
    const f = loadFleet(root);
    const i = f.lots.findIndex((l) => l.id === norm.id);
    if (i >= 0) f.lots[i] = norm; else f.lots.push(norm);
    return saveFleet(root, f);
  } catch (_) {
    return false;
  }
}

// Fait passer le lot `id` à l'état `state` (in_flight|ready|reintegrated). No-op silencieux
// si la vague est absente, le lot introuvable, ou l'état inconnu.
function setLotState(root, id, state) {
  if (!root || !Number.isFinite(Number(id)) || !STATES.includes(state)) return false;
  try {
    const f = loadFleet(root);
    const lot = f.lots.find((l) => l.id === Number(id));
    if (!lot) return false;
    lot.state = state;
    return saveFleet(root, f);
  } catch (_) {
    return false;
  }
}

// Met à jour la tête de la branche d'intégration (avance = signal de rebase pour les lots en
// vol, cf. D3). `branch` optionnel : ne l'écrase que s'il est fourni. No-op sans fleet actif.
function setIntegrationHead(root, head, branch) {
  if (!root) return false;
  try {
    const f = loadFleet(root);
    if (!f.active) return false;
    f.integration_head = head ? trunc(head, MAX_HEAD) : null;
    if (branch) f.integration_branch = trunc(branch, MAX_STR);
    return saveFleet(root, f);
  } catch (_) {
    return false;
  }
}

// Retire le lot `id` de la vague (réintégré + nettoyé). La vague vidée redevient inerte au
// prochain loadFleet (lots:[]). Renvoie false si rien retiré.
function removeLot(root, id) {
  if (!root || !Number.isFinite(Number(id))) return false;
  try {
    const f = loadFleet(root);
    const before = f.lots.length;
    f.lots = f.lots.filter((l) => l.id !== Number(id));
    if (f.lots.length === before) return false;
    return saveFleet(root, f);
  } catch (_) {
    return false;
  }
}

// Trace une DEMANDE D'EXTENSION de périmètre : le lot `id` a tenté d'écrire `relPath`, hors de
// son périmètre exclusif (verdict `outside` du hook PreToolUse). Enregistrée — dédupliquée,
// capée — sur l'entrée du lot pour que l'orchestrateur arbitre un éventuel élargissement. Ce
// n'est JAMAIS un droit d'écriture : l'écriture reste refusée ; on ne fait que rendre la friction
// visible dans le registre partagé. Lecture-modification-écriture atomique. No-op silencieux sans
// fleet actif / lot introuvable / chemin vide ; idempotent (même chemin déjà tracé → pas de
// réécriture). Renvoie false au moindre doute — jamais d'exception (contrat fail-open du hook).
function requestExtension(root, id, relPath) {
  if (!root || !Number.isFinite(Number(id))) return false;
  const p = trunc(relPath, MAX_STR);
  if (!p) return false;
  try {
    const f = loadFleet(root);
    if (!f.active) return false;
    const lot = f.lots.find((l) => l.id === Number(id));
    if (!lot) return false;
    if (lot.ext_requests.includes(p)) return true; // déjà tracé : idempotent, pas d'écriture inutile
    lot.ext_requests.push(p);
    return saveFleet(root, f);
  } catch (_) {
    return false;
  }
}

// Le lot en vol appartenant à la session `sessionId`, ou null. Une session ne « tient »
// qu'un lot à la fois dans une vague (premier match).
function lotForSession(fleetOrRoot, sessionId) {
  try {
    if (!sessionId) return null;
    const f = fleetOrRoot && Array.isArray(fleetOrRoot.lots) ? fleetOrRoot : loadFleet(fleetOrRoot);
    if (!f.active) return null;
    return f.lots.find((l) => l.session_owner === sessionId) || null;
  } catch (_) {
    return null;
  }
}

// Lignes d'injection COURTES pour une session fille au SessionStart (cf. D3 §Coût de
// contexte : périmètre + contrat + tête d'intégration, jamais le plan complet de la vague).
// Renvoie [] si pas de fleet actif OU si `sessionId` ne tient aucun lot en vol — donc
// silencieux pour une session hors vague, ou pas encore inscrite (fail-safe).
function fleetLines(root, sessionId) {
  try {
    if (!root || !sessionId) return [];
    const f = loadFleet(root);
    if (!f.active) return [];
    const mine = lotForSession(f, sessionId);
    if (!mine) return [];
    const lines = [];
    lines.push(`Vague parallèle active : ${f.lots.length} lot(s) en vol${f.wave_id ? ` (${f.wave_id})` : ''}. Tu tiens le lot #${mine.id}${mine.title ? ` « ${mine.title} »` : ''} (état : ${mine.state}).`);
    if (mine.perimeter.length) {
      lines.push(`Périmètre EXCLUSIF — ne modifie QUE : ${mine.perimeter.join(', ')}.`);
      // Le garde-fou d'écriture (hook PreToolUse) n'attribue le périmètre qu'à TA session :
      // un sous-agent (Task/Agent) écrit avec un autre session_id et échappe donc au refus.
      // Consigne comportementale explicite → transmets-lui le périmètre, il n'est pas protégé.
      lines.push('Sous-agents (Task/Agent) : transmets-leur ce périmètre — le garde-fou d\'écriture ne couvre QUE ta session, pas eux.');
    }
    if (mine.branch) lines.push(`Branche : ${mine.branch}${mine.worktree ? ` (worktree ${mine.worktree})` : ''}.`);
    if (f.integration_branch || f.integration_head) {
      lines.push(`Tête d'intégration : ${f.integration_branch || '?'}${f.integration_head ? `@${f.integration_head}` : ''} — rebase dessus si elle avance.`);
    }
    const peers = f.lots.length - 1;
    if (peers > 0) lines.push(`${peers} lot(s) sœur(s) en parallèle : reste dans ton périmètre, ne clôture pas la vague seul.`);
    return lines;
  } catch (_) {
    return [];
  }
}

// Demandes d'élargissement de périmètre EN ATTENTE, agrégées POUR L'ORCHESTRATEUR : pour chaque
// lot en vol ayant tenté d'écrire hors de sa zone (verdict `outside` tracé par requestExtension),
// { id, title, paths[] }. Rend la friction arbitrable en un coup d'œil (cf. /reintegrate). []
// si aucune demande ou hors vague. Purement dérivé (lecture seule) — fail-open au moindre doute.
function pendingExtensions(fleetOrRoot) {
  try {
    const f = fleetOrRoot && Array.isArray(fleetOrRoot.lots) ? fleetOrRoot : loadFleet(fleetOrRoot);
    if (!f.active) return [];
    return f.lots
      .filter((l) => l.ext_requests && l.ext_requests.length)
      .map((l) => ({ id: l.id, title: l.title, paths: l.ext_requests.slice() }));
  } catch (_) {
    return [];
  }
}

module.exports = {
  fleetFile,
  findFleetRoot,
  loadFleet,
  saveFleet,
  upsertLot,
  setLotState,
  setIntegrationHead,
  removeLot,
  requestExtension,
  pendingExtensions,
  lotForSession,
  fleetLines,
  STATES,
};
