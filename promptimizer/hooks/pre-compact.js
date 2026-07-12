#!/usr/bin/env node
'use strict';
// PreCompact (manual|auto) : sauve l'état AVANT que le transcript soit compacté — le
// handoff auto (qui porte désormais plan de lots + todos) est réécrit une dernière fois.
// Sur compaction MANUELLE (/compact), émet en plus un rappel chiffré VISIBLE : compacter
// coûte plus qu'une clôture + session fraîche (la réinjection minimale se fait au
// SessionStart(compact)). Compaction AUTO : rien à dire (elle est subie, pas choisie).
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
const { armFailOpen } = require('../lib/guard');
const { SETTINGS_TIMEOUT_S, watchdogMs } = require('../lib/timeouts');
armFailOpen(watchdogMs(SETTINGS_TIMEOUT_S.default));
const { disabled } = require('../lib/env');
if (disabled()) process.exit(0);

const { parseHookInput } = require('../lib/stdin');
const { passThrough, systemMessage } = require('../lib/output');
const { gitRoot, ensureLedger } = require('../lib/project');
const { writeAutoHandoff } = require('../lib/handoff');
const occupancy = require('../lib/occupancy');
const { compactionNudgeMessage } = require('../lib/messages');

function main() {
  const input = parseHookInput();
  const root = gitRoot(input.cwd || process.cwd());
  if (root) {
    ensureLedger(root);
    writeAutoHandoff(root); // refuse d'écraser un handoff manuel non consommé, comme au Stop
  }
  // Rappel chiffré uniquement sur compaction manuelle : l'auto est imposée, un nudge
  // serait du bruit. Fail-open : toute erreur de lecture d'occupation → passThrough.
  if (input.trigger === 'manual') {
    let occ = null;
    try { occ = occupancy.readLastOccupancy(input.transcript_path); } catch (_) { occ = null; }
    return systemMessage(compactionNudgeMessage(occ));
  }
  return passThrough();
}

main();
process.exit(0);
