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

module.exports = { disabled, hasTool, resolveNode };
