#!/usr/bin/env node
'use strict';
// Diagnostic de l'install PMZ pour OpenCode : arbo attendue, version (et dérive vs
// la source si lancé depuis le dépôt), état inscriptible, binaire opencode présent.
// Exit 0 si tous les checks requis passent, 1 sinon (les checks « info » ne comptent pas).
// Usage : node doctor-opencode.js [--target <dir>] [--json]
const fs = require('fs');
const os = require('os');
const path = require('path');
const ocdir = require('../plugin/impl/oc-dir');

const REPO_VERSION_FILE = path.join(__dirname, '..', '..', 'promptimizer', 'VERSION');

function main() {
  const argv = process.argv.slice(2);
  let target = null; let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && argv[i + 1]) target = path.resolve(argv[++i]);
    else if (argv[i] === '--json') json = true;
  }
  target = target || ocdir.opencodeConfigDir();

  const checks = [];
  function check(label, pass, required, detail) {
    checks.push({ label, pass: !!pass, required: required !== false, detail: detail || null });
  }

  const pmzDir = path.join(target, 'pmz');
  check('loader plugin/pmz.js', fs.existsSync(path.join(target, 'plugin', 'pmz.js')));
  check('implémentation pmz/impl/index.js', fs.existsSync(path.join(pmzDir, 'impl', 'index.js')));
  check('libs vendorées pmz/lib/backlog.js', fs.existsSync(path.join(pmzDir, 'lib', 'backlog.js')));
  check('scripts pmz/scripts/backlog.js', fs.existsSync(path.join(pmzDir, 'scripts', 'backlog.js')));

  let installed = null;
  try { installed = fs.readFileSync(path.join(pmzDir, 'VERSION'), 'utf8').trim(); } catch (_) {}
  check('version installée lisible', !!installed, true, installed);
  let repoVersion = null;
  try { repoVersion = fs.readFileSync(REPO_VERSION_FILE, 'utf8').trim(); } catch (_) {}
  if (repoVersion) {
    check('pas de dérive vs la source (' + repoVersion + ')', installed === repoVersion, false,
      installed ? 'installée : ' + installed : null);
  }

  let writable = false;
  try {
    const probe = path.join(pmzDir, 'state', '.doctor-probe');
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, 'ok'); fs.rmSync(probe);
    writable = true;
  } catch (_) {}
  check('état pmz/state/ inscriptible', writable);

  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  pathDirs.push(path.join(os.homedir(), '.opencode', 'bin'));
  const ocBin = pathDirs.some((d) => {
    try { return d && fs.existsSync(path.join(d, 'opencode')); } catch (_) { return false; }
  });
  check('binaire opencode trouvé', ocBin, false);

  const ok = checks.every((c) => c.pass || !c.required);
  if (json) console.log(JSON.stringify({ ok, target, version: installed, checks }));
  else {
    console.log('Doctor PMZ/OpenCode — cible : ' + target);
    for (const c of checks) {
      console.log('  ' + (c.pass ? '✓' : (c.required ? '✗' : '·')) + ' ' + c.label +
        (c.detail ? ' (' + c.detail + ')' : ''));
    }
    console.log(ok ? 'OK.' : 'Échec : install incomplète ou absente.');
  }
  process.exit(ok ? 0 : 1);
}

main();
