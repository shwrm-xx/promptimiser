#!/usr/bin/env node
'use strict';
// SessionStart (startup|resume) : détecte le projet, propose l'init, rappel court.
// Ne crée RIEN automatiquement, ne scanne jamais le repo.
const { armFailOpen } = require('../lib/guard');
armFailOpen(9500);
const { disabled } = require('../lib/env');
if (disabled()) process.exit(0);

const { parseHookInput } = require('../lib/stdin');
const { injectContext, passThrough } = require('../lib/output');
const { gitRoot, isInitialized } = require('../lib/project');
const { loadSessionState, saveSessionState } = require('../lib/state');
const { MSG_ACTIF, MSG_NON_INIT } = require('../lib/messages');

function main() {
  const input = parseHookInput();
  const cwd = input.cwd || process.cwd();
  const src = input.source || 'startup';
  const root = gitRoot(cwd);
  if (!root) return passThrough();

  if (isInitialized(root)) {
    // Anti-spam : un seul rappel par session, et jamais de réinjection au resume/compact
    // (sinon MSG_ACTIF regonfle le contexte à chaque reprise).
    if (src !== 'startup' && src !== 'clear') return passThrough();
    const st = loadSessionState(root, input.session_id || null);
    if (st.session_start_reminded) return passThrough();
    st.session_start_reminded = true;
    saveSessionState(root, st);
    return injectContext('SessionStart', MSG_ACTIF);
  }
  // Non initialisé : on PROPOSE seulement (l'init réelle se fait après confirmation),
  // et uniquement au vrai démarrage (l'état n'est pas persistable hors projet initialisé).
  if (src !== 'startup' && src !== 'clear') return passThrough();
  return injectContext('SessionStart', MSG_NON_INIT);
}

main();
process.exit(0);
