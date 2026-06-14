'use strict';
// Garde-fous d'environnement : kill-switch, résolution de node, détection d'outils.
const fs = require('fs');
const path = require('path');

function disabled() {
  return process.env.PMZ_DISABLE === '1';
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

module.exports = { disabled, hasTool, resolveNode, resolveTool };
