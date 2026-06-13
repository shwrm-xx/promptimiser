#!/usr/bin/env node
'use strict';
// PreToolUse (matcher Bash) : deny catastrophique, ask destructif, sinon allow.
// N'agit QUE sur Bash : aucune friction sur Read/Edit/Write (respect du mode acceptEdits).
const { armFailOpen } = require('../lib/guard');
armFailOpen(4500);
const { disabled } = require('../lib/env');
if (disabled()) process.exit(0);

const { parseHookInput } = require('../lib/stdin');
const { preToolDecision, passThrough } = require('../lib/output');

// Catastrophique -> deny (regex ancrées, conservatrices).
const CATASTROPHIC = [
  /\brm\s+-rf?\s+\/(?:\s|$)/,
  /\brm\s+-rf?\s+\/\*/,
  /\brm\s+-rf?\s+~(?:\/)?(?:\s|$)/,
  /\brm\s+-rf?\s+"?\$HOME/,
  /\bmkfs\b/,
  /\bdd\b[^\n]*\bof=\/dev\//,
  /:\s*\(\s*\)\s*\{[^}]*\|[^}]*&[^}]*\}\s*;\s*:/, // fork bomb
  />\s*\/dev\/sd[a-z]/,
  /\bchmod\s+-R\s+0?777\s+\//,
];

// Destructif -> ask (confirmation utilisateur).
const DESTRUCTIVE = [
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*[df][a-z]*\b/,
  /\bgit\s+push\b[^\n]*(--force\b|\s-f(\s|$))/,
  /\bgit\s+checkout\s+(--\s+)?\.(?:\s|$)/,
  /\bgit\s+branch\s+-D\b/,
  /\brm\s+-rf?\b/,
  /\bchmod\s+-R\b/,
  /\btruncate\b/,
];

function classify(cmd) {
  if (!cmd) return null;
  for (const re of CATASTROPHIC) if (re.test(cmd)) return 'deny';
  for (const re of DESTRUCTIVE) if (re.test(cmd)) return 'ask';
  return null;
}

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
    return preToolDecision('ask', 'Commande destructive — confirmer avant exécution (PMZ) : ' + short);
  }
  return passThrough();
}

main();
process.exit(0);
