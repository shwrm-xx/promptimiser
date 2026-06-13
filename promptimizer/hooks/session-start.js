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
const { MSG_ACTIF, MSG_NON_INIT } = require('../lib/messages');

function main() {
  const input = parseHookInput();
  const cwd = input.cwd || process.cwd();
  const root = gitRoot(cwd);
  if (!root) return passThrough();
  if (isInitialized(root)) return injectContext('SessionStart', MSG_ACTIF);
  // Non initialisé : on PROPOSE seulement (l'init réelle se fait après confirmation).
  return injectContext('SessionStart', MSG_NON_INIT);
}

main();
process.exit(0);
