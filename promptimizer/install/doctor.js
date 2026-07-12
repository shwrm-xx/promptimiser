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

// ── Détection du canal plugin (lots D-E) ────────────────────────────────────────────────
// Le doctor est historiquement l'outil du canal MANUEL : il conclut « rouge » si les hooks PMZ
// ne sont pas câblés dans settings.json. En canal PLUGIN, hooks/skill/commandes sont fournis PAR
// le plugin (jamais dans settings.json ni ~/.claude/skills) : exiger le câblage manuel faisait
// donc conclure « rouge » sur une install pourtant saine (retour utilisateur 2026-07-12). On
// détecte le plugin par signaux INDÉPENDANTS de la commande `claude` (souvent introuvable dans
// le PATH épuré des apps GUI macOS), tous en lecture de fichier.
const IS_PLUGIN = !!(process.env.CLAUDE_PLUGIN_ROOT && process.env.CLAUDE_PLUGIN_ROOT.trim());
function pluginEnabledInSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    const ep = data && data.enabledPlugins;
    return !!ep && Object.keys(ep).some((k) => k.split('@')[0] === 'pmz' && ep[k] === true);
  } catch (_) { return false; }
}
// installed_plugins.json → chemin d'install du plugin pmz (pour exercer SES hooks quand le
// canal manuel a été nettoyé). Null si absent.
function pluginInstallPath() {
  if (IS_PLUGIN) return process.env.CLAUDE_PLUGIN_ROOT.trim();
  try {
    const data = JSON.parse(fs.readFileSync(path.join(DEST, 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const key of Object.keys(data.plugins || {})) {
      const arr = data.plugins[key];
      if (key.split('@')[0] === 'pmz' && Array.isArray(arr) && arr[0] && arr[0].installPath) return arr[0].installPath;
    }
  } catch (_) { /* fichier absent -> pas de plugin */ }
  return null;
}
const PLUGIN_ROOT = pluginInstallPath();
const pluginActive = IS_PLUGIN || pluginEnabledInSettings() || !!PLUGIN_ROOT;

// Racine du CODE PMZ à exercer (dry-run hook + détection projet). Priorité : canal manuel
// présent sur disque > plugin (env/installé). Le doctor étant l'outil du canal manuel, on
// diagnostique le code manuel s'il existe encore, sinon celui du plugin.
const MANUAL_PMZ = path.join(DEST, 'promptimizer');
const PMZ = fs.existsSync(path.join(MANUAL_PMZ, 'hooks', 'session-start.js'))
  ? MANUAL_PMZ
  : (PLUGIN_ROOT && fs.existsSync(path.join(PLUGIN_ROOT, 'hooks', 'session-start.js')) ? PLUGIN_ROOT : MANUAL_PMZ);

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

// Double install (lot D3) : l'installeur manuel n'a jamais été retiré après un passage au
// plugin — les deux canaux tirent alors les mêmes hooks en même temps. Détecté dès que des
// hooks PMZ légataires traînent dans settings.json ET que le plugin est actif par ailleurs
// (env CLAUDE_PLUGIN_ROOT, ou installed_plugins.json). Lecture de fichier seule : plus de
// dépendance à la commande `claude`, souvent absente du PATH GUI macOS.
const doubleInstall = legacyHooksPresent && pluginActive;

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

// Canal effectif : conflit (deux canaux) > plugin > manuel. En plugin sain, hooks/skill sont
// portés par le plugin — on l'affiche explicitement au lieu du « — » trompeur du canal manuel.
const channel = doubleInstall ? 'plugin + manuel (CONFLIT)' : pluginActive ? 'plugin' : 'manuel';
const pluginProvides = pluginActive && !legacyHooksPresent;

log('Promptimizer — diagnostic');
log('');
log('Version installée : ' + (version || 'inconnue'));
log('Claude settings : ' + setOk);
log('Canal : ' + channel);
if (pluginProvides) {
  log('Hooks / skill / commandes : fournis par le plugin');
} else {
  log('Hooks globaux : ' + hooksOk);
  log('Skill globale : ' + skillOk);
}
log('Scripts exécutables : ' + scriptsOk);
log('Projet courant : ' + proj);
log('');
log('node : ' + nodeV + ' | git : ' + gitOk + ' | rg : ' + rgOk);
if (double) log('Avertissement : deux hooks Stop actifs (PMZ + context-guard.py).');
if (doubleInstall) {
  log('Avertissement : double installation détectée (plugin + canal manuel legacy) — ' +
    'les hooks PMZ tirent deux fois. Migration : node install/migrate-to-plugin.js.');
}

// Statut. setOk illisible = rouge quel que soit le canal. Deux canaux actifs = orange (à
// résoudre). En plugin sain, hooks/skill sont fournis par le plugin : on n'exige PAS le
// câblage manuel (c'était la cause du faux « rouge »). En manuel, comportement historique.
let status = 'vert';
if (setOk !== 'OK') status = 'rouge';
else if (doubleInstall) status = 'orange';
else if (pluginActive) { if (scriptsOk !== 'OK' || double) status = 'orange'; }
else if (hooksOk !== 'OK') status = 'rouge';
else if (skillOk !== 'OK' || scriptsOk !== 'OK' || double) status = 'orange';
log('');
log('Statut : ' + status);

if (!NO_PAUSE && process.stdin.isTTY) {
  log('');
  log('Appuie sur Entrée pour fermer.');
  readLineSync();
}
