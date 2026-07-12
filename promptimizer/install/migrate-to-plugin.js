#!/usr/bin/env node
'use strict';
// Migration canal manuel -> plugin Claude Code (lot D3).
// Retire les hooks PMZ légataires de settings.json (réutilise merge-settings.js --remove, qui
// restaure aussi un éventuel sidecar de prise de relais context-guard.py) pour éviter le
// double-firing une fois le plugin installé. Ne touche jamais aux projets utilisateur.
// L'installeur Node manuel (install.js) reste le canal legacy ; ce script en est l'outil de
// sortie propre, cf. ARCHITECTURE.md « Canal plugin ».
//
// Usage : node migrate-to-plugin.js [--no-pause] [--purge]
//   --no-pause : pas d'attente « Entrée » en fin (tests, appel automatisé)
//   --purge    : supprime aussi les fichiers PMZ legacy (~/.claude/promptimizer, skill, commands)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const cdir = require('../lib/claude-dir');
const { readLineSync } = require('./lib-io');

const DEST = cdir.claudeDir();
const SETTINGS = cdir.settingsPath();
const PMZ_DIR = cdir.pmzDir();
const MS = path.join(PMZ_DIR, 'install', 'merge-settings.js');
const argv = process.argv.slice(2);
const NO_PAUSE = argv.includes('--no-pause');
const PURGE = argv.includes('--purge');
const IS_TTY = !!process.stdin.isTTY;

function log(s) { process.stdout.write(s + '\n'); }
function err(s) { process.stderr.write(s + '\n'); }
function pause() {
  if (NO_PAUSE || !IS_TTY) return;
  log('\nAppuie sur Entrée pour fermer.');
  readLineSync();
}
function fatal(msg) { err('ERREUR : ' + msg); pause(); process.exit(1); }

log('── Promptimizer — migration canal manuel → plugin ──');
log('');

if (!fs.existsSync(MS)) {
  log('merge-settings.js introuvable (' + MS + '). Rien à migrer (PMZ manuel non installé).');
  pause();
  process.exit(0);
}

// 1. État avant migration (diagnostic best-effort, non bloquant).
let before = '';
try { before = spawnSync(process.execPath, [MS, SETTINGS, '--check'], { encoding: 'utf8' }).stdout || ''; }
catch (_) { /* ignore */ }
if (!/"pmz_hooks_present":\s*true/.test(before)) {
  log('Aucun hook PMZ legacy dans ' + SETTINGS + ' — rien à migrer.');
  pause();
  process.exit(0);
}

// 2. Retrait des hooks PMZ legacy (backup + restauration du sidecar context-guard.py si
//    applicable) — même appel que uninstall.js, réutilisé tel quel.
const rMs = spawnSync(process.execPath, [MS, SETTINGS, '--remove'], { stdio: 'inherit' });
if (rMs.status !== 0) fatal('le retrait des hooks legacy a échoué (rien modifié). Voir ci-dessus.');
log('');
log('Hooks PMZ legacy retirés de ' + SETTINGS + ' (sauvegarde créée).');

// 3. Purge optionnelle des fichiers legacy (défaut : conservés, comme uninstall.js).
if (PURGE) {
  try { fs.rmSync(PMZ_DIR, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  try { fs.rmSync(path.join(DEST, 'skills', 'promptimizer'), { recursive: true, force: true }); } catch (_) { /* ignore */ }
  for (const c of ['budget', 'check-context', 'close-batch', 'fresh-session', 'pmz-init', 'pmz-about', 'pmz-scope']) {
    try { fs.rmSync(path.join(DEST, 'commands', c + '.md'), { force: true }); } catch (_) { /* ignore */ }
  }
  log('Fichiers PMZ legacy supprimés (' + PMZ_DIR + ', skill, commands).');
} else {
  log('Fichiers PMZ legacy conservés (relance avec --purge pour les supprimer).');
}

// 4. Prochaine étape : installer le plugin (rappel des commandes, cf. build-plugin.js).
log('');
log('── Étape suivante : installer le plugin ──');
log('  node promptimizer/install/build-plugin.js');
log('  claude plugin marketplace add dist/marketplace');
log('  claude plugin install promptimizer@pmz-local');
log('');
log('Vérification : claude plugin details promptimizer (doctor.js reste l\'outil du canal manuel).');
pause();
