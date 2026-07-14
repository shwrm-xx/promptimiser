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
  prompt_reminders: {}, // anti-spam des rappels UserPromptSubmit (clé -> true)
  pending_title_rename: null, // titre suggéré calculé par session-start.js (lot #40),
  // reproposé au 1er UserPromptSubmit si non encore vu là — jamais recalculé (sinon
  // double incrément de touchLot/lot.js:suggestedTitle).
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
  if (!isInitialized(root)) return null;
  try {
    const st = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
    return (st && typeof st === 'object' && st.session_id) || null;
  } catch (_) {
    return null;
  }
}

module.exports = { loadSessionState, saveSessionState, previousSessionId, DEFAULT_STATE };
