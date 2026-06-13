#!/usr/bin/env node
'use strict';
// PostToolUse (Read|Edit|Write) : INFORMATIF uniquement. Met à jour les ledgers projet.
// Court-circuit immédiat si projet non initialisé. Ne bloque jamais, aucune décision.
const { armFailOpen } = require('../lib/guard');
armFailOpen(4500);
const { disabled } = require('../lib/env');
if (disabled()) process.exit(0);

const path = require('path');
const { parseHookInput } = require('../lib/stdin');
const { passThrough } = require('../lib/output');
const { gitRoot, isInitialized } = require('../lib/project');
const { recordRead, recordModify } = require('../lib/ledger');

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
  const fp = input.tool_input && input.tool_input.file_path;
  if (!fp) return passThrough();
  const cwd = input.cwd || process.cwd();
  const root = gitRoot(cwd);
  if (!root || !isInitialized(root)) return passThrough(); // n'écrit QUE si initialisé
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
