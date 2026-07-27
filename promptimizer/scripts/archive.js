#!/usr/bin/env node
'use strict';
// CLI de l'archive des lots clos (.vibe-agent/archive/). TIER 0 uniquement à ce stade :
// rétro-remplissage de l'index depuis le plan de lots. Les tiroirs de consultation
// (index / fiche / brut) et l'écriture de fiches arrivent avec la commande /pmz:archive.
// Toujours exit 0 (fail-open) : une erreur d'archive ne casse jamais un flux.
const { gitRoot } = require('../lib/project');
const { parseCwd } = require('../lib/cli');
const archive = require('../lib/archive');

function has(name) { return process.argv.indexOf('--' + name) !== -1; }
function out(s) { process.stdout.write(s + '\n'); }

function main() {
  const cmd = process.argv[2];
  const root = gitRoot(parseCwd());
  if (!root) { out('Pas un dépôt git : rien à archiver.'); return; }

  if (cmd === 'backfill') {
    const dryRun = has('dry-run');
    const r = archive.backfill(root, { dryRun });
    if (!r.ok) { out('Backfill impossible (archive non écrite) — rien de changé.'); return; }
    const verbe = dryRun ? 'à ajouter' : 'ajoutée(s)';
    out(`Backfill tier 0 — ${r.total} lot(s) clos · ${r.added.length} ligne(s) ${verbe} · ${r.skipped} déjà indexé(s).`);
    for (const e of r.added) out('  ' + archive.formatEntry(e));
    if (dryRun) out('(--dry-run : rien écrit. Relance sans --dry-run pour appliquer.)');
    else if (r.added.length) out(`Index : ${archive.indexFile(root)} (stagé).`);
    return;
  }

  out('Commande inconnue : ' + (cmd || '(aucune)') + '. Commandes : backfill [--dry-run].');
}

if (require.main === module) {
  try { main(); } catch (_) { /* fail-open */ }
  process.exit(0);
}
