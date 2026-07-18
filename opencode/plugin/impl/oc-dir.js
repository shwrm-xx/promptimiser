'use strict';
// Résolution des chemins PMZ côté OpenCode — pendant de lib/claude-dir.js.
// Layout installé : <config opencode>/pmz/{impl,lib,scripts,templates,state,VERSION}
// + <config opencode>/plugin/pmz.js (loader). Ce module vit dans impl/ : pmzHome = ../.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Racine du package PMZ installé (…/pmz). Override PMZ_OC_ROOT pour les tests.
function pmzHome() {
  if (process.env.PMZ_OC_ROOT) return process.env.PMZ_OC_ROOT;
  return path.dirname(__dirname);
}

// Dossier d'état (journal, anti-spam) — préservé par les réinstalls (install-opencode.js).
function stateDir() {
  const dir = process.env.PMZ_OC_STATE_DIR || path.join(pmzHome(), 'state');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

// Dossier de config OpenCode (XDG honoré) — utilisé par les installers comme cible par défaut.
function opencodeConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg || path.join(os.homedir(), '.config'), 'opencode');
}

function readVersion() {
  const candidates = [
    path.join(pmzHome(), 'VERSION'), // layout installé
    path.join(pmzHome(), '..', '..', 'promptimizer', 'VERSION'), // source du dépôt (dev)
  ];
  for (const f of candidates) {
    try {
      const v = fs.readFileSync(f, 'utf8').trim();
      if (v) return v;
    } catch (_) {}
  }
  return '?';
}

module.exports = { pmzHome, stateDir, opencodeConfigDir, readVersion };
