#!/usr/bin/env node
'use strict';
// PreCompact (manual|auto) : sauve l'état AVANT que le transcript soit compacté — le
// handoff auto (qui porte désormais plan de lots + todos) est réécrit une dernière fois.
// Aucune sortie (passThrough) : la réinjection minimale se fait au SessionStart(compact).
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
const { armFailOpen } = require('../lib/guard');
const { SETTINGS_TIMEOUT_S, watchdogMs } = require('../lib/timeouts');
armFailOpen(watchdogMs(SETTINGS_TIMEOUT_S.default));
const { disabled } = require('../lib/env');
if (disabled()) process.exit(0);

const { parseHookInput } = require('../lib/stdin');
const { passThrough } = require('../lib/output');
const { gitRoot, ensureLedger } = require('../lib/project');
const { writeAutoHandoff } = require('../lib/handoff');

function main() {
  const input = parseHookInput();
  const root = gitRoot(input.cwd || process.cwd());
  if (!root) return passThrough();
  ensureLedger(root);
  writeAutoHandoff(root); // refuse d'écraser un handoff manuel non consommé, comme au Stop
  return passThrough();
}

main();
process.exit(0);
