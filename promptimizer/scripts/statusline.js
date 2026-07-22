#!/usr/bin/env node
'use strict';
// Statusline Promptimizer (lot #45, opt-in) — invoquée par Claude Code via le champ
// `statusLine` de settings.json (une commande qui reçoit un JSON sur stdin et dont la
// PREMIÈRE ligne de stdout devient la barre d'état). N'affiche qu'UNE ligne :
//   PMZ v<version> · <epic> · lot #<id> <titre> · <faits>/<total> · ctx <occupation>
// Sources : VERSION du paquet, backlog du projet courant (déduit du cwd du workspace),
// occupation temps réel lue dans le transcript de la session.
//
// Fail-open TOTAL : une statusline ne doit jamais bruiter ni casser une session. Toute
// erreur (require corrompu, transcript illisible, projet non initialisé) → ligne vide et
// exit 0. Préambule fail-open AVANT tout require (module absent/corrompu ⇒ exit 0 muet).
process.on('uncaughtException', () => { process.exit(0); });
process.on('unhandledRejection', () => { process.exit(0); });

function emit(line) { process.stdout.write((line || '') + '\n'); process.exit(0); }

let parseHookInput, disabled, readVersion, gitRoot, isInitialized, readEpic,
  loadBacklog, currentLot, nextLot, progress, readLastOccupancy, statusLineText;
try {
  ({ parseHookInput } = require('../lib/stdin'));
  ({ disabled } = require('../lib/env'));
  ({ readVersion } = require('../lib/version'));
  ({ gitRoot, isInitialized } = require('../lib/project'));
  ({ readEpic } = require('../lib/lot'));
  ({ loadBacklog, currentLot, nextLot, progress } = require('../lib/backlog'));
  ({ readLastOccupancy } = require('../lib/occupancy'));
  ({ statusLineText } = require('../lib/messages'));
} catch (_) { emit(''); }

function main() {
  if (disabled()) emit(''); // kill-switch : statusline muette, comme les autres signaux PMZ.

  const input = parseHookInput();
  const version = readVersion() || null;
  const cwd = (input.workspace && input.workspace.current_dir) || input.cwd || process.cwd();
  const transcript = input.transcript_path || null;

  // Occupation temps réel — indépendante de l'état projet (marche même hors-git).
  let occ = null;
  try { occ = readLastOccupancy(transcript); } catch (_) { occ = null; }

  const info = { version, occ };
  try {
    const root = gitRoot(cwd);
    if (root && isInitialized(root)) {
      const b = loadBacklog(root);
      const cur = currentLot(b);
      const nxt = nextLot(b);
      info.epic = (cur && cur.epic) || (nxt && nxt.epic) || readEpic(root) || null;
      const lot = cur || nxt;
      if (lot) info.lot = { id: lot.id, title: lot.title };
      if (b.lots && b.lots.length) {
        const p = progress(b);
        info.done = p.done;
        info.total = p.total;
      }
    }
  } catch (_) { /* projet illisible → on garde version + occupation */ }

  emit(statusLineText(info));
}

try { main(); } catch (_) { emit(''); }
