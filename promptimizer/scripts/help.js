#!/usr/bin/env node
'use strict';
// Liste les commandes Promptimizer réellement installées à côté de ce script (dossier
// `commands/` frère de `scripts/`, identique dans les deux canaux manuel/plugin) — jamais
// de liste codée en dur qui périmerait si une commande est ajoutée/retirée (build-plugin.js
// EXCLUDE en retire déjà côté plugin, ex. statusline.md réservée au canal manuel).
const fs = require('fs');
const path = require('path');

const CMD_DIR = path.join(__dirname, '..', 'commands');

function parseDescription(content) {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!m) return null;
  const line = m[1].split('\n').find((l) => l.startsWith('description:'));
  if (!line) return null;
  return line.slice('description:'.length).trim();
}

function main() {
  let files;
  try {
    files = fs.readdirSync(CMD_DIR).filter((f) => f.endsWith('.md'));
  } catch (_) {
    process.stdout.write('## Commandes Promptimizer\n\n(liste indisponible)\n');
    return;
  }
  const rows = files
    .map((f) => {
      const name = f.slice(0, -'.md'.length);
      let desc = null;
      try { desc = parseDescription(fs.readFileSync(path.join(CMD_DIR, f), 'utf8')); } catch (_) { /* ignore */ }
      return { name, desc: desc || '(description indisponible)' };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const lines = ['## Commandes Promptimizer', ''];
  for (const r of rows) lines.push(`- **${r.name}** — ${r.desc}`);
  process.stdout.write(lines.join('\n') + '\n');
}

try { main(); } catch (_) { process.stdout.write('## Commandes Promptimizer\n\n(liste indisponible)\n'); }
process.exit(0);
