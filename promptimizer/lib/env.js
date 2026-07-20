'use strict';
// Garde-fous d'environnement : kill-switch, résolution de node, détection d'outils.
const fs = require('fs');
const path = require('path');

function disabled() {
  return process.env.PMZ_DISABLE === '1';
}

// Opt-out de l'advisory intra-tour (Lot B4, relecture redondante) — le reste des
// hooks continue de tourner normalement, seul ce signal informatif est coupé.
function advisoryDisabled() {
  return process.env.PMZ_NO_ADVISORY === '1';
}

const EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

function hasTool(name) {
  const fromPath = (process.env.PATH || '').split(path.delimiter);
  for (const dir of [...fromPath, ...EXTRA_DIRS]) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch (_) {
      /* continue */
    }
  }
  return false;
}

function resolveNode() {
  if (process.execPath) return process.execPath;
  for (const c of EXTRA_DIRS.map((d) => path.join(d, 'node'))) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch (_) {
      /* continue */
    }
  }
  return 'node';
}

// Chemin absolu d'un outil (PATH + dirs Homebrew/usuels). Repli : le nom nu (PATH le résout).
// Utile car les hooks lancés par Claude Code héritent parfois d'un PATH épuré (apps GUI macOS).
function resolveTool(name) {
  const fromPath = (process.env.PATH || '').split(path.delimiter);
  for (const dir of [...fromPath, ...EXTRA_DIRS]) {
    if (!dir) continue;
    const cand = path.join(dir, name);
    try {
      fs.accessSync(cand, fs.constants.X_OK);
      return cand;
    } catch (_) {
      /* continue */
    }
  }
  return name;
}

// Chemin absolu d'un outil s'il est exécutable, sinon null (distinct de resolveTool qui renvoie
// le nom nu en repli). Utilisé par le socle command-optimizer (lot #81) pour détecter RTK sans
// lancer `rtk --version` : présence binaire seule, sur le PATH + dirs usuels.
function findTool(name) {
  const fromPath = (process.env.PATH || '').split(path.delimiter);
  for (const dir of [...fromPath, ...EXTRA_DIRS]) {
    if (!dir) continue;
    const cand = path.join(dir, name);
    try {
      fs.accessSync(cand, fs.constants.X_OK);
      return cand;
    } catch (_) {
      /* continue */
    }
  }
  return null;
}

module.exports = { disabled, advisoryDisabled, hasTool, resolveNode, resolveTool, findTool };
