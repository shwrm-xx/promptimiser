#!/usr/bin/env node
'use strict';
// Désinstalle PMZ pour OpenCode : retire UNIQUEMENT ce que install-opencode.js a posé
// (plugin/pmz.js, command/pmz/, pmz/) — plugins tiers, commandes tierces et
// opencode.json ne sont jamais touchés.
// Usage : node uninstall-opencode.js [--target <dir>] [--keep-state] [--json]
const fs = require('fs');
const path = require('path');
const ocdir = require('../plugin/impl/oc-dir');

function main() {
  const argv = process.argv.slice(2);
  let target = null; let keepState = false; let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && argv[i + 1]) target = path.resolve(argv[++i]);
    else if (argv[i] === '--keep-state') keepState = true;
    else if (argv[i] === '--json') json = true;
  }
  target = target || ocdir.opencodeConfigDir();

  const removed = [];
  const loader = path.join(target, 'plugin', 'pmz.js');
  if (fs.existsSync(loader)) { fs.rmSync(loader); removed.push('plugin/pmz.js'); }
  const cmd = path.join(target, 'command', 'pmz');
  if (fs.existsSync(cmd)) { fs.rmSync(cmd, { recursive: true, force: true }); removed.push('command/pmz/'); }
  const pmzDir = path.join(target, 'pmz');
  if (fs.existsSync(pmzDir)) {
    if (keepState) {
      // On vide pmz/ sauf state/ (journal, anti-spam) — réinstall ultérieure le retrouvera.
      for (const entry of fs.readdirSync(pmzDir)) {
        if (entry === 'state') continue;
        fs.rmSync(path.join(pmzDir, entry), { recursive: true, force: true });
      }
      removed.push('pmz/ (état conservé)');
    } else {
      fs.rmSync(pmzDir, { recursive: true, force: true });
      removed.push('pmz/');
    }
  }

  if (json) console.log(JSON.stringify({ ok: true, target, removed }));
  else console.log(removed.length
    ? 'PMZ pour OpenCode retiré de ' + target + ' : ' + removed.join(', ')
    : 'Rien à retirer dans ' + target + ' (PMZ non installé).');
}

main();
