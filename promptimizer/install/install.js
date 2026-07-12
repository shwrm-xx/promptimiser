#!/usr/bin/env node
'use strict';
// Installeur Promptimizer — SOURCE DE VÉRITÉ UNIQUE (macOS / Linux / Windows).
// La logique d'install vit ici (stdlib seule) ; les lanceurs install.command/.sh/.ps1
// ne font que trouver node et appeler ce fichier — pas de duplication bash+ps1 (→ dérive).
// Fail-open : aucune étape ne doit laisser la config Claude à moitié cassée sans le dire.
//
// Usage : node install.js [--no-pause] [--takeover|--no-takeover]
//   --no-pause     : pas d'attente « Entrée » en fin (tests, appel automatisé)
//   --takeover     : reprend le rôle d'un hook Stop context-guard.py sans demander
//   --no-takeover  : laisse context-guard.py en place sans demander
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const cdir = require('../lib/claude-dir');
const { readVersion, compareSemver } = require('../lib/version');
const { readLineSync } = require('./lib-io');

const PMZ_SRC = path.resolve(__dirname, '..');    // .../promptimizer (source)
const REPO = path.resolve(PMZ_SRC, '..');         // racine du dépôt source
const DEST = cdir.claudeDir();                    // ~/.claude ou $CLAUDE_CONFIG_DIR
const SETTINGS = cdir.settingsPath();

const argv = process.argv.slice(2);
const NO_PAUSE = argv.includes('--no-pause');
const IS_WIN = process.platform === 'win32';
const IS_TTY = !!process.stdin.isTTY;

function log(s) { process.stdout.write(s + '\n'); }
function err(s) { process.stderr.write(s + '\n'); }

// Attente « Entrée » : seulement en interactif (jamais en test / --no-pause).
function pause() {
  if (NO_PAUSE || !IS_TTY) return;
  log('\nAppuie sur Entrée pour fermer.');
  readLineSync();
}
function fatal(msg) { err('ERREUR : ' + msg); pause(); process.exit(1); }

// Question O/n : renvoie le défaut si non interactif (parité avec `${ANS:-O}` du bash).
function ask(question, def) {
  if (!IS_TTY) return def;
  process.stdout.write(question);
  const a = readLineSync();
  return a === '' ? def : a;
}

log('── Promptimizer — installation ──');
log('Source : ' + PMZ_SRC);
log('Cible  : ' + DEST);
log('');

// 0. Hook git local : lève la quarantaine macOS sur les .command après chaque pull/merge.
//    Ne concerne que le dépôt SOURCE (pas la cible), et n'est utile qu'avec git présent.
if (fs.existsSync(path.join(REPO, '.git')) && fs.existsSync(path.join(REPO, '.githooks'))) {
  try {
    spawnSync('git', ['-C', REPO, 'config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
  } catch (_) { /* git absent → non bloquant */ }
}

// 1. Pré-requis node : on tourne déjà sous node, donc OK (les lanceurs vérifient en amont).

// 2. Dossiers cibles
try {
  fs.mkdirSync(DEST, { recursive: true });
  fs.mkdirSync(path.join(DEST, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(DEST, 'commands'), { recursive: true });
} catch (e) { fatal('création des dossiers cibles (' + e.message + ').'); }

// 3. Purge des sous-dossiers obsolètes d'une version précédente (cpSync fusionne sans
//    supprimer). On NE touche PAS à state/ (sidecar de prise de relais).
const DEST_PMZ = path.join(DEST, 'promptimizer');

// 3bis. Version installée lue AVANT écrasement (sinon perdue) vs version entrante.
//       Fail-open : version illisible/absente → traité comme première installation.
function readInstalledVersion() {
  try {
    const raw = fs.readFileSync(path.join(DEST_PMZ, 'VERSION'), 'utf8').trim();
    return raw || null;
  } catch (_) { return null; }
}
const installedVersion = readInstalledVersion();
const incomingVersion = readVersion();
// null = non comparable (absente, ou format legacy pré-semver comme "3") -> traité comme
// première installation, jamais de crash sur un ancien format entier.
const cmp = compareSemver(installedVersion, incomingVersion);
if (installedVersion === null || cmp === null) {
  log('Version : première installation (v' + (incomingVersion || '?') + ').');
} else if (cmp < 0) {
  log('Version : mise à jour v' + installedVersion + ' → v' + incomingVersion + '.');
} else if (cmp > 0) {
  log('Version : downgrade v' + installedVersion + ' → v' + incomingVersion + '.');
} else {
  log('Version : réinstallation (v' + incomingVersion + ').');
}

if (fs.existsSync(DEST_PMZ)) {
  for (const sub of ['hooks', 'lib', 'scripts', 'install', 'templates', 'commands']) {
    try { fs.rmSync(path.join(DEST_PMZ, sub), { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

// 4. Copie du package, de la skill et des slash commands
try {
  fs.cpSync(PMZ_SRC, DEST_PMZ, { recursive: true });
} catch (e) { fatal('copie du package (' + e.message + ').'); }
const skillSrc = path.join(REPO, 'skills', 'promptimizer');
if (fs.existsSync(skillSrc)) {
  try { fs.cpSync(skillSrc, path.join(DEST, 'skills', 'promptimizer'), { recursive: true }); }
  catch (e) { fatal('copie de la skill (' + e.message + ').'); }
}
const cmdSrc = path.join(PMZ_SRC, 'commands');
if (fs.existsSync(cmdSrc)) {
  for (const f of fs.readdirSync(cmdSrc)) {
    if (f.endsWith('.md')) {
      try { fs.copyFileSync(path.join(cmdSrc, f), path.join(DEST, 'commands', f)); } catch (_) { /* ignore */ }
    }
  }
}
log('Fichiers copiés.');

// 5. Permissions (+x) sur posix ; noop sous Windows.
if (!IS_WIN) {
  const execDir = path.join(DEST_PMZ, 'install');
  const chmodInDir = (dir, exts) => {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (exts.some((e) => f.endsWith(e))) {
          try { fs.chmodSync(path.join(dir, f), 0o755); } catch (_) { /* ignore */ }
        }
      }
    } catch (_) { /* dir absent → ignore */ }
  };
  chmodInDir(execDir, ['.command', '.sh']);
  chmodInDir(path.join(DEST_PMZ, 'hooks'), ['.js']);
  chmodInDir(path.join(DEST_PMZ, 'scripts'), ['.js']);
}

// 5bis. Quarantine macOS UNIQUEMENT (xattr n'existe pas ailleurs).
if (process.platform === 'darwin') {
  const targets = [DEST_PMZ, path.join(DEST, 'skills', 'promptimizer'), path.join(DEST, 'commands')]
    .filter((p) => fs.existsSync(p));
  try { execFileSync('xattr', ['-dr', 'com.apple.quarantine'].concat(targets), { stdio: 'ignore' }); }
  catch (_) { /* xattr absent ou rien à faire → non bloquant */ }
}

// 6. Fusion settings.json (via la copie INSTALLÉE de merge-settings.js).
const MS = path.join(DEST_PMZ, 'install', 'merge-settings.js');
let takeoverFlag = argv.includes('--takeover') ? '--takeover' : '';
if (!argv.includes('--takeover') && !argv.includes('--no-takeover')) {
  let check = '';
  try { check = execFileSync(process.execPath, [MS, SETTINGS, '--check'], { encoding: 'utf8' }); }
  catch (_) { check = ''; }
  if (/"context_guard_present":\s*true/.test(check) && /"pmz_hooks_present":\s*false/.test(check)) {
    log('');
    log("Un hook Stop 'context-guard.py' existe déjà.");
    log('PMZ sait suivre le coût/contexte (paliers de tokens) : il peut reprendre ce rôle');
    log("pour éviter des alertes en double. C'est RÉVERSIBLE (sauvegarde + désinstalleur).");
    const ans = ask('PMZ reprend ce rôle ? [O/n] ', 'O');
    if (/^n/i.test(ans)) { takeoverFlag = ''; log('→ Les deux hooks Stop resteront actifs.'); }
    else { takeoverFlag = '--takeover'; log('→ PMZ reprend le rôle.'); }
  }
}
const msArgs = [MS, SETTINGS].concat(takeoverFlag ? [takeoverFlag] : []);
const rMs = spawnSync(process.execPath, msArgs, { stdio: 'inherit' });
if (rMs.status !== 0) {
  fatal('la fusion de settings.json a échoué (rien modifié). Voir le message ci-dessus.');
}

// 7. Diagnostic (doctor.js, cross-platform)
log('');
try {
  spawnSync(process.execPath, [path.join(DEST_PMZ, 'install', 'doctor.js'), '--no-pause'], { stdio: 'inherit' });
} catch (_) { /* non bloquant */ }

// 8. Récapitulatif
log('');
log('── Installé. ──');
log('• Hooks globaux fusionnés dans : ' + SETTINGS + ' (sauvegarde horodatée créée)');
log('• Skill : ' + path.join(DEST, 'skills', 'promptimizer', 'SKILL.md'));
log('• Commands : /pmz-init /budget /check-context /close-batch /fresh-session');
log('• Redémarre Claude Code pour activer les hooks.');
log('• Désinstaller : promptimizer/install/uninstall' + (IS_WIN ? '.ps1' : '.command'));
pause();
