#!/usr/bin/env node
'use strict';
// Wrapper CLI de /pmz-init. La logique de bootstrap vit dans lib/bootstrap.js
// (réutilisée telle quelle par les hooks pour l'auto-scaffold d'un projet neuf).
const { gitRoot } = require('../lib/project');
const { runBootstrap } = require('../lib/bootstrap');
const { parseCwd } = require('../lib/cli');

function emit(result) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

try {
  const root = gitRoot(parseCwd());
  emit(runBootstrap(root));
} catch (e) {
  emit({ ok: false, reason: String(e && e.message ? e.message : e) });
}
process.exit(0);
