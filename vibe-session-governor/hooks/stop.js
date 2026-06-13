#!/usr/bin/env node
'use strict';
// Stop : garde-fou de fin de tour UNIFIÉ et NON BLOQUANT (systemMessage).
// (a) alerte palier d'occupation contexte (méthode reprise de context-guard.py) ;
// (b) rappel de clôture si un lot est ouvert (anti-spam par lot).
const { armFailOpen } = require('../lib/guard');
armFailOpen(4500);
const { disabled } = require('../lib/env');
if (disabled()) process.exit(0);

const { parseHookInput } = require('../lib/stdin');
const { systemMessage, passThrough } = require('../lib/output');
const { gitRoot, isInitialized, gitStatusPorcelain } = require('../lib/project');
const { loadSessionState, saveSessionState } = require('../lib/state');
const occupancy = require('../lib/occupancy');
const { MSG_CLOTURE, occupancyMessage } = require('../lib/messages');

function main() {
  const input = parseHookInput();
  if (input.stop_hook_active === true) return passThrough(); // anti-boucle
  const sid = input.session_id || null;
  const cwd = input.cwd || process.cwd();
  const parts = [];

  // (a) occupation contexte — fonctionne même hors projet (ne dépend que du transcript).
  const occ = occupancy.evaluate(input.transcript_path, sid);
  if (occ && occ.crossedNew && occ.bucket > 0) {
    parts.push(occupancyMessage(occ.occupancy, occ.bucket));
  }

  // (b) clôture — seulement dans un projet git initialisé.
  const root = gitRoot(cwd);
  if (root && isInitialized(root)) {
    const open = gitStatusPorcelain(root).length > 0;
    const st = loadSessionState(root, sid);
    if (open && !st.closure_reminded_for_batch) {
      parts.push(MSG_CLOTURE);
      st.closure_reminded_for_batch = true;
      saveSessionState(root, st);
    } else if (!open && st.closure_reminded_for_batch) {
      st.closure_reminded_for_batch = false; // working tree propre -> nouveau lot
      saveSessionState(root, st);
    }
  }

  if (parts.length) return systemMessage(parts.join('\n\n'));
  return passThrough();
}

main();
process.exit(0);
