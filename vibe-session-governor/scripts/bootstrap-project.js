#!/usr/bin/env node
'use strict';
// Bootstrap PRUDENT du socle projet. Gardes : repo git requis, jamais $HOME/dossiers système,
// jamais d'écrasement, ne touche QUE .vibe-agent/ + CLAUDE.md + AGENTS.md + CHANGELOG.md.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { gitRoot, vibeDir } = require('../lib/project');

const TEMPLATES = path.join(__dirname, '..', 'templates');
const FORBIDDEN = ['/', '/tmp', '/var', '/usr', '/etc', '/opt', '/Applications', '/System', '/Library', os.homedir()]
  .map((p) => path.resolve(p));

function parseCwd() {
  const i = process.argv.indexOf('--cwd');
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.cwd();
}

function copyIfAbsent(srcName, destPath, created, skipped) {
  try {
    if (fs.existsSync(destPath)) { skipped.push(destPath); return; }
    fs.copyFileSync(path.join(TEMPLATES, srcName), destPath);
    created.push(destPath);
  } catch (_) {
    skipped.push(destPath + ' (erreur)');
  }
}

function main() {
  const cwd = parseCwd();
  const root = gitRoot(cwd);
  const result = { ok: false, root: root || null, created: [], skipped: [], reason: null };

  if (!root) { result.reason = 'not_a_git_repo'; return emit(result); }
  if (FORBIDDEN.includes(path.resolve(root))) { result.reason = 'forbidden_root'; return emit(result); }

  const created = [];
  const skipped = [];
  const vd = vibeDir(root);
  try { fs.mkdirSync(vd, { recursive: true }); } catch (_) { /* ignore */ }

  copyIfAbsent('rules.yaml', path.join(vd, 'rules.yaml'), created, skipped);
  copyIfAbsent('context-ledger.json', path.join(vd, 'context-ledger.json'), created, skipped);
  copyIfAbsent('read-ledger.json', path.join(vd, 'read-ledger.json'), created, skipped);
  copyIfAbsent('session-state.json', path.join(vd, 'session-state.json'), created, skipped);
  copyIfAbsent('CLAUDE.md', path.join(root, 'CLAUDE.md'), created, skipped);
  copyIfAbsent('AGENTS.md', path.join(root, 'AGENTS.md'), created, skipped);
  copyIfAbsent('CHANGELOG.md', path.join(root, 'CHANGELOG.md'), created, skipped);

  result.ok = true;
  result.created = created;
  result.skipped = skipped;
  return emit(result);
}

function emit(result) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

try { main(); } catch (e) { emit({ ok: false, reason: String(e && e.message ? e.message : e) }); }
process.exit(0);
