#!/usr/bin/env node
'use strict';
// UserPromptSubmit : détecte init/scaffold et demandes trop larges. Anti-spam 1×/session.
// Non bloquant : ne bloque jamais un prompt.
const { armFailOpen } = require('../lib/guard');
armFailOpen(4500);
const { disabled } = require('../lib/env');
if (disabled()) process.exit(0);

const { parseHookInput } = require('../lib/stdin');
const { injectContext, passThrough } = require('../lib/output');
const { gitRoot, isInitialized } = require('../lib/project');
const { loadSessionState, saveSessionState } = require('../lib/state');
const { MSG_LARGE, MSG_INIT_BEFORE_CODE } = require('../lib/messages');

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
  if (!root) return passThrough();

  const initialized = isInitialized(root);
  const sid = input.session_id || null;
  const st = loadSessionState(root, sid);

  let msg = null;
  let key = null;
  if (!initialized && INIT_RE.test(prompt)) { key = 'init_before_code'; msg = MSG_INIT_BEFORE_CODE; }
  else if (isBroad(prompt)) { key = 'broad'; msg = MSG_LARGE; }

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
