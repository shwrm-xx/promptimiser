#!/usr/bin/env node
'use strict';
// UserPromptSubmit : détecte init/scaffold et demandes trop larges. Anti-spam 1×/session.
// Non bloquant : ne bloque jamais un prompt.
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
const { armFailOpen } = require('../lib/guard');
const { SETTINGS_TIMEOUT_S, watchdogMs } = require('../lib/timeouts');
armFailOpen(watchdogMs(SETTINGS_TIMEOUT_S.default));
const { disabled } = require('../lib/env');
if (disabled()) process.exit(0);

const { parseHookInput } = require('../lib/stdin');
const { injectContext, passThrough } = require('../lib/output');
const { gitRoot, isFullyInitialized } = require('../lib/project');
const { autoInitGitAndBootstrap } = require('../lib/bootstrap');
const { loadSessionState, saveSessionState } = require('../lib/state');
const { loadBacklog, currentLot, progress } = require('../lib/backlog');
const { MSG_LARGE, MSG_INIT_BEFORE_CODE, autoInitMessage, largeWithPlanMessage } = require('../lib/messages');

const INIT_RE = /(nouveau projet|initialise|initialiser|scaffold|setup|from scratch|cr[ée]er? un projet|bootstrap)/i;
const BROAD_RE = /(refactor (complet|global|tout)|partout|tout le (projet|code|repo)|et aussi|pendant que tu y es|tant qu'on y est|toutes les|tous les fichiers)/i;

function isBroad(prompt) {
  if (!prompt) return false;
  if (BROAD_RE.test(prompt)) return true;
  const bullets = (prompt.match(/(^|\n)\s*([-*]|\d+\.)/g) || []).length;
  return prompt.length > 1500 || bullets >= 6;
}

function main() {
  const input = parseHookInput();
  const cwd = input.cwd || process.cwd();
  const prompt = String(input.prompt || '');
  const root = gitRoot(cwd);
  if (!root) {
    // Aucun .git du tout : si le prompt ressemble à un vrai démarrage de projet,
    // on initialise nous-mêmes (git init + scaffold + commit) — rien à écraser
    // par construction (copyIfAbsent). Sinon comportement inchangé : on ne touche
    // à rien hors repo git.
    if (INIT_RE.test(prompt)) {
      try {
        const result = autoInitGitAndBootstrap(cwd);
        if (result.ok) {
          return injectContext('UserPromptSubmit', autoInitMessage({ gitInitDone: true, committed: result.committed }));
        }
      } catch (_) {
        /* fail-open : on retombe sur passThrough ci-dessous */
      }
    }
    return passThrough();
  }

  const initialized = isFullyInitialized(root);
  const sid = input.session_id || null;
  const st = loadSessionState(root, sid);

  let msg = null;
  let key = null;
  if (!initialized && INIT_RE.test(prompt)) { key = 'init_before_code'; msg = MSG_INIT_BEFORE_CODE; }
  else if (isBroad(prompt)) {
    key = 'broad';
    // Plan de lots déjà en place → rattacher plutôt que redécouper.
    try {
      const b = loadBacklog(root);
      msg = b.lots.length ? largeWithPlanMessage(progress(b), currentLot(b)) : MSG_LARGE;
    } catch (_) {
      msg = MSG_LARGE;
    }
  }

  if (msg && key) {
    st.prompt_reminders = st.prompt_reminders || {};
    if (st.prompt_reminders[key]) msg = null; // déjà rappelé cette session
    else st.prompt_reminders[key] = true;
  }

  saveSessionState(root, st);
  if (msg) return injectContext('UserPromptSubmit', msg);
  return passThrough();
}

main();
process.exit(0);
