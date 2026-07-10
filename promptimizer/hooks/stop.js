#!/usr/bin/env node
'use strict';
// Stop : garde-fou de fin de tour UNIFIÉ et NON BLOQUANT (systemMessage).
// (a) alerte palier d'occupation contexte (méthode reprise de context-guard.py) ;
// (b) rappel de clôture si un lot est ouvert (anti-spam par lot).
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
const { armFailOpen } = require('../lib/guard');
const { SETTINGS_TIMEOUT_S, watchdogMs } = require('../lib/timeouts');
armFailOpen(watchdogMs(SETTINGS_TIMEOUT_S.default));
const { disabled } = require('../lib/env');
if (disabled()) process.exit(0);

const { parseHookInput } = require('../lib/stdin');
const { systemMessage, passThrough } = require('../lib/output');
const { gitRoot, ensureLedger, gitStatusPorcelain } = require('../lib/project');
const { loadSessionState, saveSessionState } = require('../lib/state');
const { loadContextLedger } = require('../lib/ledger');
const { incrementLot } = require('../lib/lot');
const occupancy = require('../lib/occupancy');
const { MSG_CLOTURE, MSG_LECTURE, occupancyMessage } = require('../lib/messages');

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

  // (a2) hygiène de lecture — indépendante du ledger, une fois par session, marche
  // même sur un projet jamais initialisé (lit le transcript brut comme (a)).
  const mix = occupancy.evaluateReadMix(input.transcript_path, sid);
  if (mix) {
    parts.push([
      `Cette session : ${mix.fullReads}/${mix.reads} lectures étaient des Read complets (sans offset/limit).`,
      'Grep/git diff en amont sur les gros fichiers réduirait le coût des prochaines relectures.',
    ].join('\n'));
  }

  // (b) clôture — dans tout repo git (ledger auto-créé, jamais de confirmation requise).
  const root = gitRoot(cwd);
  if (root) {
    ensureLedger(root);
    const open = gitStatusPorcelain(root).length > 0;
    const st = loadSessionState(root, sid);
    if (open && !st.closure_reminded_for_batch) {
      parts.push(MSG_CLOTURE);
      // Relectures évitables du lot (ledger context) -> note concrète (spirit de MSG_LECTURE).
      const cl = loadContextLedger(root);
      const rereads = Array.from(new Set((cl.repeated_reads || []).map((r) => r && r.path).filter(Boolean))).slice(0, 5);
      if (rereads.length) {
        parts.push(MSG_LECTURE + '\nRelectures évitables ce lot : ' + rereads.join(', ') + '.');
      }
      st.closure_reminded_for_batch = true;
      saveSessionState(root, st);
    } else if (!open && st.closure_reminded_for_batch) {
      st.closure_reminded_for_batch = false; // working tree propre -> nouveau lot
      saveSessionState(root, st);
      incrementLot(root); // lot fermé -> le prochain sera proposé au SessionStart suivant
    }
  }

  if (parts.length) return systemMessage(parts.join('\n\n'));
  return passThrough();
}

main();
process.exit(0);
