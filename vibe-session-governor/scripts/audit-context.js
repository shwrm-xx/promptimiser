#!/usr/bin/env node
'use strict';
// Advisory court d'économie de contexte (format spec). S'appuie sur les ledgers + git.
// Le signal de COÛT (occupation par tokens) vient des alertes de palier du hook Stop.
const { gitRoot, isInitialized } = require('../lib/project');
const { loadReadLedger, loadContextLedger } = require('../lib/ledger');

function parseCwd() {
  const i = process.argv.indexOf('--cwd');
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.cwd();
}

function main() {
  const root = gitRoot(parseCwd());
  if (!root || !isInitialized(root)) {
    process.stdout.write('## Économie de contexte\n\nStatut : non applicable (projet non initialisé)\n');
    return;
  }
  const cl = loadContextLedger(root);
  const rl = loadReadLedger(root);
  const reread = (cl.repeated_reads || []).length;
  let statut = 'vert';
  if (reread >= 1 && reread <= 2) statut = 'orange';
  if (reread > 2) statut = 'rouge';

  const avoidable = (rl.avoid_reread_notes || []).slice(0, 20);
  const known = Object.keys(cl.files_read || {}).slice(0, 20);

  const lines = [];
  lines.push('## Économie de contexte');
  lines.push('');
  lines.push(`Statut : ${statut}`);
  lines.push('');
  lines.push('Lectures évitables :');
  if (avoidable.length) avoidable.forEach((f) => lines.push(`- ${f}`));
  else lines.push('- (aucune détectée)');
  lines.push('');
  lines.push('Fichiers déjà connus :');
  if (known.length) known.forEach((f) => lines.push(`- ${f}`));
  else lines.push('- (aucun)');
  lines.push('');
  lines.push('Action la moins coûteuse :');
  lines.push('- utiliser git diff / git status');
  lines.push('- utiliser git grep');
  lines.push('- lire uniquement le bloc nécessaire');
  lines.push('- clôturer le lot si la demande est traitée');
  process.stdout.write(lines.join('\n') + '\n');
}

try { main(); } catch (_) { process.stdout.write('## Économie de contexte\n\nStatut : indéterminé\n'); }
process.exit(0);
