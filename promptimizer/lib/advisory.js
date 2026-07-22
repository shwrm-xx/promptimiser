'use strict';
// Advisory intra-tour (Lot B4) : signale, sans jamais bloquer, une relecture COMPLÈTE et
// redondante d'un fichier déjà lu et inchangé (mtime + hors files_modified — décidé par
// l'appelant via ledger.recordRead, cf. post-tool-use.js). PostToolUse est purement
// informatif : jamais de deny/ask sur Read ici.
// Plafonne via un état HORS-PROJET <sha1(session_id)>-advisory (même convention que
// occupancy.js/turnstats.js : clé par session, remis à zéro à chaque nouvelle session_id).
const { advisoryDisabled } = require('./env');
const { stateFileFor } = require('./occupancy');
const { readJson, writeAtomic } = require('./fsjson');

const MIN_BYTES = 16 * 1024;   // fichier < 16 Ko : coût de relecture négligeable, pas de bruit
const MAX_PER_SESSION = 3;     // plafond global, en plus du plafond 1×/fichier

function advisoryFile(sessionId) {
  return stateFileFor(sessionId, 'advisory');
}

function loadAdvisoryState(sessionId) {
  const st = readJson(advisoryFile(sessionId), null) || {};
  st.files = st.files && typeof st.files === 'object' ? st.files : {};
  st.count = typeof st.count === 'number' ? st.count : 0;
  return st;
}

// { sessionId, relPath, bytes, redundant, summary } -> texte advisory, ou null si rien à signaler
// (non redondant, trop petit, désactivé, déjà signalé pour ce fichier, ou plafond session atteint).
// summary (lot #53) : résumé connu du fichier (read-ledger.summaries) — servi dans l'advisory
// pour remplacer la relecture, pas seulement la signaler.
function maybeAdvise({ sessionId, relPath, bytes, redundant, summary }) {
  if (!redundant || !relPath || !bytes || bytes < MIN_BYTES) return null;
  if (advisoryDisabled()) return null;
  const st = loadAdvisoryState(sessionId);
  if (st.files[relPath]) return null; // plafond 1×/fichier (cette session)
  if (st.count >= MAX_PER_SESSION) return null; // plafond 3×/session
  st.files[relPath] = true;
  st.count += 1;
  writeAtomic(advisoryFile(sessionId), st);
  const kb = Math.round(bytes / 1024);
  const base = `Note : ${relPath} (${kb} Ko) a déjà été lu et semble inchangé — cette relecture complète est probablement redondante.`;
  return summary ? base + `\nRésumé connu (à utiliser à la place) : ${summary}` : base;
}

module.exports = { maybeAdvise, loadAdvisoryState, advisoryFile, MIN_BYTES, MAX_PER_SESSION };
