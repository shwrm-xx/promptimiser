#!/usr/bin/env node
'use strict';
// Diagnostic Promptimizer — cross-platform (macOS / Linux / Windows), stdlib seule.
// Appelé par install.js (--no-pause) et par les lanceurs pmz-doctor.command/.sh/.ps1.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const cdir = require('../lib/claude-dir');
const { readVersion } = require('../lib/version');
const { readLineSync } = require('./lib-io');

const DEST = cdir.claudeDir();
const SETTINGS = cdir.settingsPath();
const PMZ = cdir.pmzDir();
// Sibling direct de ce fichier (pas via pmzDir()) : doctor.js n'est jamais expédié dans le
// plugin (EXCLUDE de build-plugin.js), donc merge-settings.js vit toujours à côté de lui dans
// le canal manuel — même si CLAUDE_PLUGIN_ROOT est posée par ailleurs (double install, D3).
const MS = path.join(__dirname, 'merge-settings.js');
const NO_PAUSE = process.argv.slice(2).includes('--no-pause');

function log(s) { process.stdout.write(s + '\n'); }
// « command -v » cross-platform : tente `<cmd> --version`, vrai si ça n'échoue pas au lancement.
function hasCmd(cmd) {
  try {
    const r = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
    return !r.error && r.status !== null;
  } catch (_) { return false; }
}

// Claude settings
const setOk = fs.existsSync(SETTINGS) ? 'OK' : '—';

// Hooks PMZ + double Stop (via merge-settings --check)
let hooksOk = '—';
let double = false;
let legacyHooksPresent = false;
if (fs.existsSync(MS)) {
  try {
    const chk = execFileSync(process.execPath, [MS, SETTINGS, '--check'], { encoding: 'utf8' });
    legacyHooksPresent = /"pmz_hooks_present":\s*true/.test(chk);
    if (legacyHooksPresent) hooksOk = 'OK';
    if (/"double_stop":\s*true/.test(chk)) double = true;
  } catch (_) { /* ignore */ }
}

// Double install (lot D3) : deux scénarios détectés indépendamment, chacun signale que
// l'installeur manuel n'a jamais été retiré après un passage au plugin (les deux canaux
// tirent alors les mêmes hooks en même temps) :
//   A. ce doctor tourne SOUS le plugin (CLAUDE_PLUGIN_ROOT posé par le harness) et des hooks
//      PMZ légataires traînent encore dans settings.json ;
//   B. ce doctor tourne en canal manuel et `claude plugin list` rapporte pmz déjà
//      installé (best-effort : absence de la commande = non détecté, jamais un throw).
const IS_PLUGIN = !!(process.env.CLAUDE_PLUGIN_ROOT && process.env.CLAUDE_PLUGIN_ROOT.trim());
function pluginAlsoInstalled() {
  try {
    const r = spawnSync('claude', ['plugin', 'list'], { encoding: 'utf8' });
    if (r.error || r.status !== 0) return false;
    return /\bpmz\b/i.test(String(r.stdout || ''));
  } catch (_) { return false; }
}
const doubleInstall = IS_PLUGIN ? legacyHooksPresent : (legacyHooksPresent && pluginAlsoInstalled());

// Skill
const skillOk = fs.existsSync(path.join(DEST, 'skills', 'promptimizer', 'SKILL.md')) ? 'OK' : '—';

// Scripts + dry-run réel d'un hook
let scriptsOk = '—';
const sessionStart = path.join(PMZ, 'hooks', 'session-start.js');
if (fs.existsSync(sessionStart)) {
  try {
    execFileSync(process.execPath, [sessionStart], { input: '{}', stdio: ['pipe', 'ignore', 'ignore'] });
    scriptsOk = 'OK';
  } catch (_) { /* ignore */ }
}

// Projet courant
let proj = 'non initialisé';
const detect = path.join(PMZ, 'scripts', 'detect-project.js');
if (fs.existsSync(detect)) {
  try {
    const det = execFileSync(process.execPath, [detect], { encoding: 'utf8' });
    if (/"is_git_repo":\s*false/.test(det)) proj = 'hors dépôt git';
    if (/"initialized":\s*true/.test(det)) proj = 'initialisé';
  } catch (_) { /* ignore */ }
}

// Capacités
const nodeV = process.version;
const gitOk = hasCmd('git') ? 'OK' : 'absent';
const rgOk = hasCmd('rg') ? 'présent' : 'absent (git grep/grep utilisés)';

const version = readVersion();

log('Promptimizer — diagnostic');
log('');
log('Version installée : ' + (version || 'inconnue'));
log('Claude settings : ' + setOk);
log('Hooks globaux : ' + hooksOk);
log('Skill globale : ' + skillOk);
log('Scripts exécutables : ' + scriptsOk);
log('Projet courant : ' + proj);
log('');
log('node : ' + nodeV + ' | git : ' + gitOk + ' | rg : ' + rgOk);
if (double) log('Avertissement : deux hooks Stop actifs (PMZ + context-guard.py).');
if (doubleInstall) {
  log('Avertissement : double installation détectée (plugin + canal manuel legacy) — ' +
    'les hooks PMZ tirent deux fois. Migration : node install/migrate-to-plugin.js.');
}

let status = 'vert';
if (setOk !== 'OK' || hooksOk !== 'OK') status = 'rouge';
else if (skillOk !== 'OK' || scriptsOk !== 'OK' || double || doubleInstall) status = 'orange';
log('');
log('Statut : ' + status);

if (!NO_PAUSE && process.stdin.isTTY) {
  log('');
  log('Appuie sur Entrée pour fermer.');
  readLineSync();
}
