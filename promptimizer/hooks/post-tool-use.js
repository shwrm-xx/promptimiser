#!/usr/bin/env node
'use strict';
// PostToolUse (Read|Edit|Write|TodoWrite) : INFORMATIF uniquement. Met à jour les
// ledgers projet, capture la todo-list (snapshot écrasé à chaque TodoWrite) et peut
// émettre un additionalContext advisory (lot B4 : relecture complète redondante) —
// jamais de permissionDecision, jamais de blocage : Read est déjà exécuté.
// Le ledger (.vibe-agent/) est auto-créé dès qu'un repo git existe (ensureLedger) —
// aucune confirmation requise, contrairement au socle visible (CLAUDE.md/AGENTS.md).
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
const { armFailOpen } = require('../lib/guard');
const { SETTINGS_TIMEOUT_S, watchdogMs } = require('../lib/timeouts');
armFailOpen(watchdogMs(SETTINGS_TIMEOUT_S.default));
const { disabled } = require('../lib/env');
if (disabled()) process.exit(0);

const fs = require('fs');
const path = require('path');
const { parseHookInput } = require('../lib/stdin');
const { passThrough, postToolContext, postToolUpdatedOutput } = require('../lib/output');
const { gitRoot, ensureLedger } = require('../lib/project');
const { recordRead, recordModify, getSummary } = require('../lib/ledger');
const { maybeAdvise } = require('../lib/advisory');
const { writeTodoSnapshot } = require('../lib/backlog');
const { reduceBashOutput } = require('../lib/output-fallback');

function relOf(root, fp) {
  try {
    let r = path.relative(root, fp);
    if (!r || r.startsWith('..')) {
      // Le cwd peut passer par un symlink (macOS : /var → /private/var) alors que git
      // résout le chemin réel : relativiser sur les chemins réels avant d'abandonner,
      // sinon les clés de ledger (dont summaries, lot #53) divergent des chemins relatifs
      // écrits dans le handoff.
      r = path.relative(fs.realpathSync(root), fs.realpathSync(fp));
    }
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
  // Bash : fallback natif de sortie volumineuse (lot #84). Réécrit updatedToolOutput SEULEMENT si
  // reduceBashOutput décide de réduire (RTK absent, sortie > seuil, gain réel) ; sinon passThrough
  // → sortie brute intacte. tool_response porte {stdout,stderr,interrupted,isImage,…} pour Bash.
  if (tool === 'Bash') {
    const root = gitRoot(input.cwd || process.cwd());
    const res = reduceBashOutput({
      toolResponse: input.tool_response,
      command: input.tool_input && input.tool_input.command,
      root,
      env: process.env,
    });
    if (res && res.updatedToolOutput) return postToolUpdatedOutput(res.updatedToolOutput);
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
    let stat = null;
    try {
      const st = fs.statSync(fp);
      stat = { bytes: st.size, mtimeMs: st.mtimeMs };
    } catch (_) { /* fichier disparu/inaccessible : coût inconnu, pas de gaspillage */ }
    const rr = recordRead(root, rel, sid, partial, stat);
    const redundant = !!(rr && rr.waste && !rr.modifiedSince);
    const advisory = maybeAdvise({
      sessionId: sid,
      relPath: rel,
      bytes: rr && rr.bytes,
      redundant,
      // Résumé connu (lot #53) : lu seulement si la relecture est redondante (zéro I/O sinon).
      summary: redundant ? getSummary(root, rel) : null,
    });
    if (advisory) return postToolContext(advisory);
  } else if (tool === 'Edit' || tool === 'Write') {
    recordModify(root, rel, sid);
  }
  return passThrough();
}

main();
process.exit(0);
