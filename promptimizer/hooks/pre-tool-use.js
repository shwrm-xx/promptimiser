#!/usr/bin/env node
'use strict';
// PreToolUse (matcher Bash) : deny catastrophique, ask destructif, sinon allow.
// N'agit QUE sur Bash : aucune friction sur Read/Edit/Write (respect du mode acceptEdits).
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
const { armFailOpen } = require('../lib/guard');
const { SETTINGS_TIMEOUT_S, watchdogMs } = require('../lib/timeouts');
armFailOpen(watchdogMs(SETTINGS_TIMEOUT_S.default));
const { disabled } = require('../lib/env');
if (disabled()) process.exit(0);

const { parseHookInput } = require('../lib/stdin');
const { preToolDecision, passThrough } = require('../lib/output');
const { classify } = require('../lib/bash-guard');

function main() {
  const input = parseHookInput();
  if (input.tool_name !== 'Bash') return passThrough();
  const cmd = String((input.tool_input && input.tool_input.command) || '');
  const verdict = classify(cmd);
  const short = cmd.length > 200 ? cmd.slice(0, 200) + '…' : cmd;
  if (verdict === 'deny') {
    return preToolDecision('deny', 'Commande catastrophique bloquée par Promptimizer : ' + short);
  }
  if (verdict === 'ask') {
    return preToolDecision('ask', 'Commande destructive — confirmer avant exécution (Promptimizer) : ' + short);
  }
  return passThrough();
}

main();
process.exit(0);
