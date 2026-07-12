#!/usr/bin/env node
'use strict';
// Désinstalleur Promptimizer — cross-platform, stdlib seule.
// Retire UNIQUEMENT les hooks PMZ de settings.json (restaure context-guard.py si applicable),
// puis propose de supprimer les fichiers installés. Ne touche jamais aux projets utilisateur.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const cdir = require('../lib/claude-dir');
const { readLineSync } = require('./lib-io');

const DEST = cdir.claudeDir();
const SETTINGS = cdir.settingsPath();
const MS = path.join(cdir.pmzDir(), 'install', 'merge-settings.js');
const NO_PAUSE = process.argv.slice(2).includes('--no-pause');
const IS_TTY = !!process.stdin.isTTY;

function log(s) { process.stdout.write(s + '\n'); }
function err(s) { process.stderr.write(s + '\n'); }
function pause() {
  if (NO_PAUSE || !IS_TTY) return;
  log('Appuie sur Entrée pour fermer.');
  readLineSync();
}

log('── Promptimizer — désinstallation ──');
log('');

if (!fs.existsSync(MS)) {
  log('merge-settings.js introuvable (' + MS + '). PMZ ne semble pas installé.');
  pause();
  process.exit(1);
}

// 1. Retrait des hooks PMZ (backup + restauration du sidecar context-guard.py si applicable)
const rMs = spawnSync(process.execPath, [MS, SETTINGS, '--remove'], { stdio: 'inherit' });
if (rMs.status === 0) log('Hooks PMZ retirés de settings.json (sauvegarde créée).');
else err('ERREUR : modification de settings.json impossible (rien changé).');

// 2. Suppression optionnelle des fichiers installés (défaut : conserver)
log('');
let ans = 'N';
if (IS_TTY) {
  process.stdout.write('Supprimer aussi les fichiers PMZ (' + cdir.pmzDir() + ', skill, commands) ? [o/N] ');
  const a = readLineSync();
  ans = a === '' ? 'N' : a;
}
if (/^o/i.test(ans)) {
  try { fs.rmSync(cdir.pmzDir(), { recursive: true, force: true }); } catch (_) { /* ignore */ }
  try { fs.rmSync(path.join(DEST, 'skills', 'promptimizer'), { recursive: true, force: true }); } catch (_) { /* ignore */ }
  for (const c of ['budget', 'check-context', 'close-batch', 'fresh-session', 'pmz-init', 'pmz-about', 'pmz-scope']) {
    try { fs.rmSync(path.join(DEST, 'commands', c + '.md'), { force: true }); } catch (_) { /* ignore */ }
  }
  log('Fichiers PMZ supprimés.');
} else {
  log('Fichiers conservés (réinstall possible).');
}

log('');
log('Note : PMZ ne touche jamais à tes projets (.vibe-agent/, CLAUDE.md… restent en place).');
log('Redémarre Claude Code pour prendre en compte le retrait.');
pause();
