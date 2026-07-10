#!/usr/bin/env node
'use strict';
// Stop : garde-fou de fin de tour UNIFIÉ et NON BLOQUANT (systemMessage).
// (a) alerte palier d'occupation contexte (méthode reprise de context-guard.py) ;
// (b) rappel de clôture si un lot est ouvert (anti-spam par lot) ;
// (c) handoff auto écrit dans .vibe-agent/handoff.md (écrasé à chaque tour).
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
const { armFailOpen } = require('../lib/guard');
const { SETTINGS_TIMEOUT_S, watchdogMs } = require('../lib/timeouts');
armFailOpen(watchdogMs(SETTINGS_TIMEOUT_S.default));
const { disabled } = require('../lib/env');
if (disabled()) process.exit(0);

const { parseHookInput } = require('../lib/stdin');
const { systemMessage, passThrough } = require('../lib/output');
const { gitRoot, ensureLedger, gitStatusMeaningful } = require('../lib/project');
const { writeAutoHandoff } = require('../lib/handoff');
const { loadSessionState, saveSessionState } = require('../lib/state');
const { loadContextLedger, recordOccupancy } = require('../lib/ledger');
const { incrementLot } = require('../lib/lot');
const { loadBacklog, doneLot, nextLot, progress } = require('../lib/backlog');
const occupancy = require('../lib/occupancy');
const turnstats = require('../lib/turnstats');
const {
  MSG_CLOTURE, MSG_LECTURE, occupancyMessage, lotClosedMessage,
  costlyTurnMessage, bustIntraMessage, pauseTtlMessage,
} = require('../lib/messages');

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

  // (a3) métrologie PAR TOUR — coût réel du dernier tour (scan du seul offset ajouté).
  // Fonctionne hors projet (ne dépend que du transcript). Le miroir ledger est fait
  // plus bas, quand root est connu.
  const turn = turnstats.computeTurn(input.transcript_path, sid);
  if (turn) {
    if (turn.alerts.costly) parts.push(costlyTurnMessage(turn));
    if (turn.alerts.intraBust) parts.push(bustIntraMessage(turn));
    if (turn.alerts.pause) parts.push(pauseTtlMessage(turn));
    // Redescente brutale (compaction) : le palier d'occupation persisté est périmé,
    // on le resynchronise pour réarmer les futures alertes de palier.
    if (turn.alerts.resync) occupancy.resyncBucket(sid, turn.occ);
  }

  // (b) clôture — dans tout repo git (ledger auto-créé, jamais de confirmation requise).
  const root = gitRoot(cwd);
  if (root) {
    ensureLedger(root);
    // Miroir compact de l'occupation dans le ledger projet (aperçu lisible).
    if (turn && turn.occ != null) recordOccupancy(root, { occ: turn.occ, delta: turn.delta, sessionId: sid });
    // gitStatusMeaningful : le churn .vibe-agent/ (ledgers, handoff réécrit à
    // chaque tour) ne doit pas compter comme lot ouvert ni bloquer sa clôture.
    const open = gitStatusMeaningful(root).length > 0;
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
      const closedNumber = incrementLot(root); // lot fermé -> le prochain sera proposé au SessionStart suivant
      // Auto-clôture du lot backlog — cas univoque seulement (exactement un in_progress) ;
      // sinon on ne touche à rien (réconciliation via backlog.js reconcile / close-batch).
      const b = loadBacklog(root);
      const inProg = b.lots.filter((l) => l.status === 'in_progress');
      if (inProg.length === 1) {
        const done = doneLot(root, inProg[0].id, null, closedNumber);
        if (done) {
          const after = loadBacklog(root);
          parts.push(lotClosedMessage(done, nextLot(after), progress(after)));
        }
      }
    }
    // (c) handoff auto : dernier état connu, ÉCRASÉ à chaque fin de tour (un seul
    // fichier, pas de bloat) ; session-start.js l'injectera au prochain démarrage.
    // Ne touche jamais un handoff manuel (/fresh-session) non encore consommé.
    writeAutoHandoff(root);
  }

  if (parts.length) return systemMessage(parts.join('\n\n'));
  return passThrough();
}

main();
process.exit(0);
