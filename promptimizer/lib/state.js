'use strict';
// État de session keyé par session_id, dans .vibe-agent/session-state.json.
// Écriture atomique, fail-silent. No-op si le projet n'est pas initialisé.
const fs = require('fs');
const path = require('path');
const { vibeDir, isInitialized } = require('./project');
const { writeAtomic } = require('./fsjson');

const DEFAULT_STATE = {
  session_id: null,
  session_start_reminded: false, // anti-spam du rappel SessionStart (1×/session)
  closure_reminded_for_batch: false,
  cost_reminded_for_batch: false, // anti-spam de l'alerte coût par lot (lot #43) : 1× par
  // lot·session, réarmé quand le working tree redevient propre (nouveau lot, cf. stop.js)
  cost_watermark: null, // OpenCode (lot #54) : id du dernier message assistant déjà compté
  // en coût — un même message final vu par plusieurs session.idle n'est agrégé qu'une fois.
  // Inutilisé côté Claude Code (turnstats scanne l'offset transcript, pas de double-comptage).
  prompt_reminders: {}, // anti-spam des rappels UserPromptSubmit (clé -> true)
  pending_title_rename: null, // titre suggéré calculé par session-start.js (lot #40),
  // reproposé au 1er UserPromptSubmit si non encore vu là — jamais recalculé (sinon
  // double incrément de touchLot/lot.js:suggestedTitle).
  plan_session: false, // lot #130 : cette session a fait de la CONCEPTION (mode plan de
  // Claude Code, ou /pmz:scope qui pose un epic / ajoute des lots). Lu à la session
  // SUIVANTE (previousSessionMeta) pour la titrer « [XXX · Plan] <epic> ».
};

function stateFile(root) {
  return path.join(vibeDir(root), 'session-state.json');
}

function loadSessionState(root, sessionId) {
  if (!isInitialized(root)) {
    return Object.assign({}, DEFAULT_STATE, { session_id: sessionId || null });
  }
  let st;
  try {
    st = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
  } catch (_) {
    st = null;
  }
  if (!st || typeof st !== 'object') st = {};
  // Nouvelle session => flags remis à zéro.
  if (sessionId && st.session_id && st.session_id !== sessionId) {
    return Object.assign({}, DEFAULT_STATE, { session_id: sessionId });
  }
  const merged = Object.assign({}, DEFAULT_STATE, st);
  if (sessionId) merged.session_id = sessionId;
  return merged;
}

function saveSessionState(root, state) {
  if (!isInitialized(root)) return false;
  return writeAtomic(stateFile(root), state);
}

// Lit le session_id BRUT persisté, SANS reset ni écriture (contrairement à
// loadSessionState, qui remet les flags à zéro dès qu'un session_id différent lui est
// passé). Sert à retrouver l'id de la session précédente avant que session-start.js
// n'écrase le fichier avec celui de la session courante — cf. lib/lot.js:suggestedTitle,
// qui doit savoir quelle session a clos le dernier lot.
function previousSessionId(root) {
  return previousSessionMeta(root).id;
}

// Ce que la session PRÉCÉDENTE a laissé dans son état, lu BRUT (même contrat que
// previousSessionId : aucun reset, aucune écriture) — le fichier d'état contient encore
// celui de la session précédente jusqu'à ce que session-start.js l'écrase. Sert à
// suggestedTitle (lib/lot.js) : `id` pour l'attribution du lot clos, `plan` pour titrer
// une session de conception « [XXX · Plan] <epic> » (lot #130).
function previousSessionMeta(root) {
  if (!isInitialized(root)) return { id: null, plan: false };
  try {
    const st = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
    if (!st || typeof st !== 'object') return { id: null, plan: false };
    return { id: st.session_id || null, plan: st.plan_session === true };
  } catch (_) {
    return { id: null, plan: false };
  }
}

// Marque la session COURANTE comme session de conception (lot #130). Écriture BRUTE et
// idempotente : on ne passe pas par loadSessionState (qui remettrait les flags à zéro si on
// lui donnait un autre session_id) — le reste de l'état, y compris session_id, est préservé
// tel quel. Appelable depuis un hook comme depuis la CLI (qui ne connaît pas le session_id).
// Fail-silent : renvoie false sans rien casser si le projet n'est pas initialisé.
function markPlanSession(root) {
  if (!isInitialized(root)) return false;
  let st;
  try {
    st = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
  } catch (_) {
    st = null;
  }
  if (!st || typeof st !== 'object') st = {};
  if (st.plan_session === true) return true; // déjà marquée : aucune réécriture
  st.plan_session = true;
  return writeAtomic(stateFile(root), st);
}

module.exports = {
  loadSessionState, saveSessionState, previousSessionId, previousSessionMeta,
  markPlanSession, DEFAULT_STATE,
};
