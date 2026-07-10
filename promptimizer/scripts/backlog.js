#!/usr/bin/env node
'use strict';
// CLI du plan de lots (.vibe-agent/backlog.json). Invoqué par l'assistant via
// /pmz-scope, /close-batch ou la consigne MSG_LARGE. Arguments par argv (citables,
// auditables par PreToolUse), sortie lisible par défaut, --json pour la machine.
// Toujours exit 0 (fail-open) : une erreur de plan ne doit jamais casser un flux.
const { gitRoot } = require('../lib/project');
const { parseCwd } = require('../lib/cli');
const backlog = require('../lib/backlog');

const LABELS = { todo: 'à faire', in_progress: 'en cours', done: 'fait', dropped: 'abandonné' };

function flag(name) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] != null ? process.argv[i + 1] : null;
}
function out(s) { process.stdout.write(s + '\n'); }

function show(root, json) {
  const b = backlog.loadBacklog(root);
  if (json) return out(JSON.stringify(b, null, 2));
  if (!b.lots.length) {
    out('Aucun plan de lots.');
    out('Créer : node ~/.claude/promptimizer/scripts/backlog.js add --title "…" --scope "fait quand : …"');
    return;
  }
  const p = backlog.progress(b);
  out('## Plan de lots');
  out(`${p.done}/${p.total} faits.`);
  out('');
  for (const l of b.lots) {
    let line = `- [${LABELS[l.status]}] #${l.id} « ${l.title} »`;
    if (l.status === 'done' && l.closed_commit) line += ` — commit ${l.closed_commit}`;
    else if (l.scope) line += ` — ${l.scope}`;
    if (l.note) line += ` (note : ${l.note})`;
    out(line);
  }
}

function main() {
  const root = gitRoot(parseCwd());
  if (!root) return out('Pas un dépôt git — backlog indisponible.');
  const cmd = (process.argv[2] || '').startsWith('--') ? 'show' : (process.argv[2] || 'show');
  const json = process.argv.includes('--json');
  const id = flag('id');

  if (cmd === 'show') return show(root, json);

  if (cmd === 'add') {
    const lot = backlog.addLot(root, flag('title'), flag('scope'));
    if (!lot) {
      const b = backlog.loadBacklog(root);
      if (b.lots.filter((l) => l.status === 'todo' || l.status === 'in_progress').length >= backlog.MAX_LOTS_OPEN) {
        return out(`Refusé : ${backlog.MAX_LOTS_OPEN} lots ouverts au plafond — un backlog n'est pas un Jira. Clore ou abandonner d'abord.`);
      }
      return out('Refusé : --title manquant ou vide.');
    }
    return out(`Lot #${lot.id} « ${lot.title} » ajouté (à faire).`);
  }

  if (cmd === 'start') {
    const lot = backlog.startLot(root, id);
    return out(lot ? `Lot #${lot.id} « ${lot.title} » démarré (en cours).`
      : `Lot #${id} introuvable ou déjà clos/abandonné.`);
  }

  if (cmd === 'done') {
    const lot = backlog.doneLot(root, id, flag('commit'));
    return out(lot ? `Lot #${lot.id} « ${lot.title} » clos${lot.closed_commit ? ` (commit ${lot.closed_commit})` : ''}.`
      : `Lot #${id} introuvable.`);
  }

  if (cmd === 'drop') {
    const lot = backlog.dropLot(root, id, flag('note'));
    return out(lot ? `Lot #${lot.id} « ${lot.title} » abandonné.`
      : `Lot #${id} introuvable ou déjà fait.`);
  }

  if (cmd === 'note') {
    const lot = backlog.noteLot(root, id, flag('note'));
    return out(lot ? `Note posée sur le lot #${lot.id}.` : `Lot #${id} introuvable ou --note manquante.`);
  }

  if (cmd === 'next') {
    const lot = backlog.nextLot(backlog.loadBacklog(root));
    if (json) return out(JSON.stringify(lot));
    return out(lot ? `Prochain lot : #${lot.id} « ${lot.title} »${lot.scope ? ` — ${lot.scope}` : ''}.`
      : 'Aucun lot à faire.');
  }

  if (cmd === 'reconcile') {
    const r = backlog.reconcile(root);
    if (!r.fixed.length && !r.warnings.length) return out('Rien à réparer.');
    for (const f of r.fixed) out(`Réparé : ${f}`);
    for (const w of r.warnings) out(`Note : ${w}`);
    return;
  }

  out(`Commande inconnue : ${cmd}. Commandes : show | add | start | done | drop | note | next | reconcile.`);
}

if (require.main === module) {
  try { main(); } catch (_) { /* fail-open */ }
  process.exit(0);
}
