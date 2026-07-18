#!/usr/bin/env node
'use strict';
// Installe PMZ pour OpenCode — core cross-platform, Node stdlib uniquement.
// Déploie vers <target> (défaut : ~/.config/opencode, XDG honoré) :
//   plugin/pmz.js            ← loader (opencode/plugin/pmz.js)
//   pmz/{impl,lib,scripts,templates,VERSION}  ← implémentation + libs vendorées
//                              depuis promptimizer/ (source unique, copie — ni symlink
//                              ni require inter-dossiers au runtime)
//   command/pmz/*.md         ← commandes (à partir du lot OC2, si présentes)
// Invariants : idempotent ; pmz/state/ préservé aux réinstalls ; ne touche JAMAIS
// opencode.json ni quoi que ce soit d'autre dans la config utilisateur.
// Usage : node install-opencode.js [--target <dir>] [--json]
const fs = require('fs');
const path = require('path');
const ocdir = require('../plugin/impl/oc-dir');

const SRC = path.join(__dirname, '..'); // opencode/
const PKG = path.join(SRC, '..', 'promptimizer'); // source des libs vendorées
const VENDORED = ['lib', 'scripts', 'templates'];

function parseArgs(argv) {
  const args = { target: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && argv[i + 1]) { args.target = path.resolve(argv[++i]); continue; }
    if (argv[i] === '--json') { args.json = true; continue; }
    if (argv[i] === '--help' || argv[i] === '-h') { args.help = true; continue; }
  }
  return args;
}

function fail(msg) { console.error('install-opencode : ' + msg); process.exit(1); }

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage : node install-opencode.js [--target <dir>] [--json]');
    process.exit(0);
  }
  if (!fs.existsSync(path.join(PKG, 'VERSION'))) fail('source promptimizer/ introuvable (' + PKG + ')');
  const version = fs.readFileSync(path.join(PKG, 'VERSION'), 'utf8').trim();
  const target = args.target || ocdir.opencodeConfigDir();
  fs.mkdirSync(target, { recursive: true });

  // 1. Nouveau payload pmz/ assemblé à côté puis swap — jamais d'état à moitié écrit.
  const pmzDir = path.join(target, 'pmz');
  const tmp = path.join(target, 'pmz.new-' + process.pid);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  for (const d of VENDORED) {
    const from = path.join(PKG, d);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(tmp, d), { recursive: true });
  }
  fs.copyFileSync(path.join(PKG, 'VERSION'), path.join(tmp, 'VERSION'));
  fs.cpSync(path.join(SRC, 'plugin', 'impl'), path.join(tmp, 'impl'), { recursive: true });

  // 2. Préservation de l'état utilisateur (journal, anti-spam) à travers les réinstalls.
  const oldState = path.join(pmzDir, 'state');
  if (fs.existsSync(oldState)) fs.cpSync(oldState, path.join(tmp, 'state'), { recursive: true });

  // 3. Swap.
  fs.rmSync(pmzDir, { recursive: true, force: true });
  fs.renameSync(tmp, pmzDir);

  // 4. Loader — seul fichier posé dans plugin/ (les plugins tiers restent intouchés).
  fs.mkdirSync(path.join(target, 'plugin'), { recursive: true });
  fs.copyFileSync(path.join(SRC, 'plugin', 'pmz.js'), path.join(target, 'plugin', 'pmz.js'));

  // 5. Commandes (namespace pmz/ uniquement — le reste de command/ est intouché).
  const cmdSrc = path.join(SRC, 'command', 'pmz');
  let commands = 0;
  if (fs.existsSync(cmdSrc)) {
    const files = fs.readdirSync(cmdSrc).filter((f) => f.endsWith('.md'));
    if (files.length) {
      const cmdDst = path.join(target, 'command', 'pmz');
      fs.rmSync(cmdDst, { recursive: true, force: true });
      fs.cpSync(cmdSrc, cmdDst, { recursive: true });
      commands = files.length;
    }
  }

  const summary = { ok: true, version, target, commands };
  if (args.json) console.log(JSON.stringify(summary));
  else {
    console.log('PMZ pour OpenCode v' + version + ' installé dans ' + target);
    console.log('  plugin/pmz.js + pmz/ (impl, lib, scripts, templates)' +
      (commands ? ' + ' + commands + ' commande(s) /pmz' : ' — aucune commande (lot OC2+)'));
  }
}

main();
