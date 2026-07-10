#!/usr/bin/env node
'use strict';
// SessionStart (startup|resume) : détecte le projet, propose l'init, rappel court.
// Ne crée RIEN automatiquement, ne scanne jamais le repo.
// Préambule fail-open AVANT tout require : si un require échoue (module corrompu/absent),
// l'exception est captée et on sort en exit 0 (jamais exit non-0 qui bruiterait la session).
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
const { armFailOpen } = require('../lib/guard');
const { SETTINGS_TIMEOUT_S, watchdogMs } = require('../lib/timeouts');
armFailOpen(watchdogMs(SETTINGS_TIMEOUT_S.sessionStart));
const { disabled } = require('../lib/env');
if (disabled()) process.exit(0);

const { parseHookInput } = require('../lib/stdin');
const { injectContext, passThrough } = require('../lib/output');
const { gitRoot, isFullyInitialized, hasAnyCommit } = require('../lib/project');
const { runBootstrap, commitScaffold } = require('../lib/bootstrap');
const { loadSessionState, saveSessionState } = require('../lib/state');
const { suggestedTitle } = require('../lib/lot');
const { readHandoff, markConsumed } = require('../lib/handoff');
const { MSG_ACTIF, MSG_NON_INIT, MSG_HANDOFF, sessionTitleMessage, autoInitMessage } = require('../lib/messages');

// Ajoute le handoff de la session précédente (écrit par stop.js ou /fresh-session)
// au message injecté, puis le marque consommé (un handoff manuel redevient
// écrasable par le handoff auto). Fail-open : renvoie msg inchangé au moindre doute.
function withHandoff(root, msg) {
  try {
    const h = readHandoff(root);
    if (!h || !h.text) return msg;
    markConsumed(root);
    return msg + '\n\n' + MSG_HANDOFF + '\n\n' + h.text;
  } catch (_) {
    return msg;
  }
}

function main() {
  const input = parseHookInput();
  const cwd = input.cwd || process.cwd();
  const src = input.source || 'startup';
  const root = gitRoot(cwd);
  if (!root) return passThrough();

  if (isFullyInitialized(root)) {
    // Anti-spam : un seul rappel par session, et jamais de réinjection au resume/compact
    // (sinon MSG_ACTIF regonfle le contexte à chaque reprise).
    if (src !== 'startup' && src !== 'clear') return passThrough();
    const st = loadSessionState(root, input.session_id || null);
    if (st.session_start_reminded) return passThrough();
    st.session_start_reminded = true;
    saveSessionState(root, st);
    let msg = MSG_ACTIF;
    try {
      msg = msg + '\n\n' + sessionTitleMessage(suggestedTitle(root));
    } catch (_) {
      /* fail-open : le rappel de base part quand même */
    }
    return injectContext('SessionStart', withHandoff(root, msg));
  }
  // Non initialisé, et uniquement au vrai démarrage (l'état n'est pas persistable
  // hors projet initialisé).
  if (src !== 'startup' && src !== 'clear') return passThrough();

  // Projet NEUF (repo git existant mais 0 commit) : scaffold posé automatiquement,
  // sans confirmation — rien à écraser par construction (copyIfAbsent). Un projet
  // mature (des commits déjà) continue de nécessiter /pmz-init explicite.
  if (!hasAnyCommit(root)) {
    try {
      const result = runBootstrap(root);
      if (result.ok) {
        const committed = commitScaffold(root, result.created);
        return injectContext('SessionStart', autoInitMessage({ gitInitDone: false, committed }));
      }
    } catch (_) {
      /* fail-open : on retombe sur la proposition normale ci-dessous */
    }
  }
  // Sinon : on PROPOSE seulement (l'init réelle se fait après confirmation).
  // Le handoff éventuel (ledger auto-créé sans socle visible) est injecté aussi.
  return injectContext('SessionStart', withHandoff(root, MSG_NON_INIT));
}

main();
process.exit(0);
