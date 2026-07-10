#!/usr/bin/env node
'use strict';
// Wrapper CLI de /pmz-init. La logique de bootstrap vit dans lib/bootstrap.js
// (réutilisée telle quelle par les hooks pour l'auto-scaffold d'un projet neuf).
// --augment : ajoute EN PLUS la section PMZ taguée aux CLAUDE.md/AGENTS.md déjà
// présents (projet en cours) — append-only, idempotent, réversible. Réservé au
// flux /pmz-init explicite ; les hooks n'augmentent jamais.
const { gitRoot } = require('../lib/project');
const { runBootstrap, augmentExisting } = require('../lib/bootstrap');
const { parseCwd } = require('../lib/cli');

function emit(result) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

try {
  const root = gitRoot(parseCwd());
  const result = runBootstrap(root);
  if (result.ok && process.argv.includes('--augment')) {
    const aug = augmentExisting(root);
    result.augmented = aug.augmented;
    result.skipped = result.skipped.concat(aug.skipped);
  }
  emit(result);
} catch (e) {
  emit({ ok: false, reason: String(e && e.message ? e.message : e) });
}
process.exit(0);
