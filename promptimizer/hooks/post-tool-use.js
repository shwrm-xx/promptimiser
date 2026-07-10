#!/usr/bin/env node
'use strict';
// PostToolUse (Read|Edit|Write|TodoWrite) : INFORMATIF uniquement. Met à jour les
// ledgers projet et capture la todo-list (snapshot écrasé à chaque TodoWrite).
// Le ledger (.vibe-agent/) est auto-créé dès qu'un repo git existe (ensureLedger) —
// aucune confirmation requise, contrairement au socle visible (CLAUDE.md/AGENTS.md).
// Ne bloque jamais, aucune décision.
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
const { armFailOpen } = require('../lib/guard');
const { SETTINGS_TIMEOUT_S, watchdogMs } = require('../lib/timeouts');
armFailOpen(watchdogMs(SETTINGS_TIMEOUT_S.default));
const { disabled } = require('../lib/env');
if (disabled()) process.exit(0);

const path = require('path');
const { parseHookInput } = require('../lib/stdin');
const { passThrough } = require('../lib/output');
const { gitRoot, ensureLedger } = require('../lib/project');
const { recordRead, recordModify } = require('../lib/ledger');
const { writeTodoSnapshot } = require('../lib/backlog');

function relOf(root, fp) {
  try {
    const r = path.relative(root, fp);
    return r && !r.startsWith('..') ? r : fp;
  } catch (_) {
    return fp;
  }
}

function main() {
  const input = parseHookInput();
  const tool = input.tool_name;
  // TodoWrite n'a pas de file_path : branché avant le guard fp.
  if (tool === 'TodoWrite') {
    const root = gitRoot(input.cwd || process.cwd());
    if (root) writeTodoSnapshot(root, input.tool_input && input.tool_input.todos, input.session_id || null);
    return passThrough();
  }
  const fp = input.tool_input && input.tool_input.file_path;
  if (!fp) return passThrough();
  const cwd = input.cwd || process.cwd();
  const root = gitRoot(cwd);
  if (!root) return passThrough(); // n'écrit QUE dans un repo git
  ensureLedger(root); // plomberie interne silencieuse, jamais de contenu visible
  const rel = relOf(root, fp);
  const sid = input.session_id || null;
  if (tool === 'Read') {
    const ti = input.tool_input || {};
    const partial = ti.offset != null || ti.limit != null;
    recordRead(root, rel, sid, partial);
  } else if (tool === 'Edit' || tool === 'Write') {
    recordModify(root, rel, sid);
  }
  return passThrough();
}

main();
process.exit(0);
