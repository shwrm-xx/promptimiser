#!/usr/bin/env node
'use strict';
// PreToolUse : (1) matcher Bash — deny catastrophique, ask destructif, sinon allow ; (2) mode
// fleet-fille (lot #78) — sur Edit/Write, refuse une écriture CERTAINEMENT hors du périmètre
// exclusif quand une vague parallèle est active ET que la session courante y tient un lot.
// Hors vague, ou session non inscrite : ZÉRO friction (respect du mode acceptEdits) — inchangé.
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
const { armFailOpen } = require('../lib/guard');
const { SETTINGS_TIMEOUT_S, watchdogMs } = require('../lib/timeouts');
armFailOpen(watchdogMs(SETTINGS_TIMEOUT_S.default));
const { disabled } = require('../lib/env');
if (disabled()) process.exit(0);

const { parseHookInput } = require('../lib/stdin');
const { preToolDecision, preToolUpdatedInput, passThrough } = require('../lib/output');
const { classify } = require('../lib/bash-guard');
const { rewriteCommand } = require('../lib/optimizer');
const { recordRewrite } = require('../lib/rtk-metrics');
const { findFleetRoot, loadFleet, lotForSession, requestExtension } = require('../lib/fleet');
const { memberVerdict, toRelPosix } = require('../lib/perimeter');

// Outils d'écriture-fichier soumis au test de périmètre. Edit/Write partagent le champ
// `file_path` ; MultiEdit aussi (même sémantique de cible) → même garde, sinon la garde se
// contourne d'un simple changement d'outil. Volontairement restreint à ces trois outils
// (interprétation minimale de « Edit/Write ») ; NotebookEdit (champ `notebook_path`, rare ici)
// et les autres outils sont hors périmètre du lot #78.
const PERIMETER_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

// Message de refus SI (et seulement si) une session fille d'une vague active tente d'écrire un
// chemin CERTAINEMENT hors de son périmètre exclusif. Sinon null (→ passThrough). Fail-open
// absolu : au moindre doute ou à la moindre erreur → null (allow), jamais d'exception.
function perimeterDeny(input) {
  try {
    if (!PERIMETER_TOOLS.has(input.tool_name)) return null;
    const fp = input.tool_input && input.tool_input.file_path;
    if (!fp) return null;
    const root = findFleetRoot(input.cwd || process.cwd()); // court-circuit : pas de fleet → pas de git
    if (!root) return null;
    const fleet = loadFleet(root);
    if (!fleet.active) return null;                          // hors vague : intact
    const mine = lotForSession(fleet, input.session_id || null);
    if (!mine || !mine.perimeter.length) return null;        // pas fille, ou périmètre vide → allow
    if (memberVerdict(mine.perimeter, fp, root) !== 'outside') return null; // inside/unknown → allow
    // Trace la friction dans le registre partagé (best-effort) — ce n'est PAS un droit d'écriture :
    // l'écriture reste refusée, mais l'orchestrateur voit ce que le lot a voulu toucher hors zone.
    try { requestExtension(root, mine.id, toRelPosix(fp, root) || fp); } catch (_) { /* jamais bloquant */ }
    return `Lot #${mine.id} — « ${fp} » est hors du périmètre exclusif (${mine.perimeter.join(', ')}). `
      + 'Écriture bloquée par Promptimizer (vague parallèle) : reste dans ton périmètre, ou demande '
      + 'l\'élargissement à l\'orchestrateur (demande tracée dans fleet.json).';
  } catch (_) {
    return null;
  }
}

function main() {
  const input = parseHookInput();
  if (input.tool_name === 'Bash') {
    const cmd = String((input.tool_input && input.tool_input.command) || '');
    const verdict = classify(cmd);
    const short = cmd.length > 200 ? cmd.slice(0, 200) + '…' : cmd;
    if (verdict === 'deny') {
      return preToolDecision('deny', 'Commande catastrophique bloquée par Promptimizer : ' + short);
    }
    if (verdict === 'ask') {
      return preToolDecision('ask', 'Commande destructive — confirmer avant exécution (Promptimizer) : ' + short);
    }
    // Commande SÛRE (allow) : bridge RTK optionnel, DEFAULT OFF (lot #81). La sécurité PMZ a déjà
    // tranché sur la commande ORIGINALE — on ne réécrit qu'une commande jugée sûre. Fail-open :
    // toute absence/panne RTK renvoie applied:false → passThrough (la commande originale passe).
    const rw = rewriteCommand(cmd, { cwd: input.cwd });
    if (rw.applied) {
      // Vérification défensive (spec §8) : la commande réécrite doit rester SÛRE. Un RTK produisant
      // une commande deny/ask (résultat anormal) est IGNORÉ — jamais d'exécution silencieuse d'une
      // commande dangereuse via réécriture. On préserve les autres champs de tool_input (timeout,
      // description, run_in_background) : updatedInput remplace l'objet, ne le fusionne pas.
      if (classify(rw.rewrittenCommand) === null) {
        // Métrologie honnête (lot #83) : compte la réécriture EFFECTIVEMENT livrée (compteur
        // local monotone). Best-effort strict — jamais bloquant, l'échec de mesure n'empêche
        // pas la livraison de la commande.
        try { recordRewrite(rw.rewrittenCommand); } catch (_) { /* fail-open */ }
        return preToolUpdatedInput(
          Object.assign({}, input.tool_input, { command: rw.rewrittenCommand })
        );
      }
    }
    return passThrough();
  }
  const deny = perimeterDeny(input);
  if (deny) return preToolDecision('deny', deny);
  return passThrough();
}

main();
process.exit(0);
