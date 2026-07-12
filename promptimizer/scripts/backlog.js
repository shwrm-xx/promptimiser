#!/usr/bin/env node
'use strict';
// CLI du plan de lots (.vibe-agent/backlog.json). Invoqué par l'assistant via
// /pmz-scope, /close-batch ou la consigne MSG_LARGE. Arguments par argv (citables,
// auditables par PreToolUse), sortie lisible par défaut, --json pour la machine.
// Toujours exit 0 (fail-open) : une erreur de plan ne doit jamais casser un flux.
const { gitRoot } = require('../lib/project');
const { parseCwd } = require('../lib/cli');
const backlog = require('../lib/backlog');
const lot = require('../lib/lot');

const LABELS = { todo: 'à faire', in_progress: 'en cours', done: 'fait', dropped: 'abandonné' };

function flag(name) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] != null ? process.argv[i + 1] : null;
}
function out(s) { process.stdout.write(s + '\n'); }
// Base des chemins d'aide affichés : racine du plugin en mode plugin (substituée par
// Claude Code / exportée aux hooks), sinon l'emplacement de l'install manuelle.
const PMZ_BASE = (process.env.CLAUDE_PLUGIN_ROOT || '').trim() || '~/.claude/promptimizer';

function show(root, json, epicFilter) {
  const b = backlog.loadBacklog(root);
  const lots = epicFilter ? b.lots.filter((l) => l.epic === epicFilter) : b.lots;
  if (json) return out(JSON.stringify(epicFilter ? { ...b, lots } : b, null, 2));
  if (!lots.length) {
    out(epicFilter ? `Aucun lot pour l'epic « ${epicFilter} ».` : 'Aucun plan de lots.');
    if (!epicFilter) out(`Créer : node ${PMZ_BASE}/scripts/backlog.js add --title "…" --scope "fait quand : …"`);
    return;
  }
  const p = epicFilter ? { done: lots.filter((l) => l.status === 'done').length, total: lots.length } : backlog.progress(b);
  out('## Plan de lots');
  out(`${p.done}/${p.total} faits.`);
  out('');
  for (const l of lots) {
    let line = `- [${LABELS[l.status]}] #${l.id} « ${l.title} »`;
    if (l.epic) line += ` [epic : ${l.epic}]`;
    if (l.model_hint) line += ` [modèle : ${l.model_hint}]`;
    if (l.verify) line += ` [verify : ${l.verify}]`;
    if (l.status === 'done' && l.closed_commit) line += ` — commit ${l.closed_commit}`;
    else if (l.scope) line += ` — ${l.scope}`;
    if (l.status === 'done' && Number.isFinite(l.closed_occupancy)) line += ` (occupation à la clôture : ${l.closed_occupancy})`;
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

  if (cmd === 'show') return show(root, json, flag('epic'));

  if (cmd === 'epic') {
    const name = flag('set');
    if (!name) return out(`Epic actuel : ${lot.readEpic(root)}`);
    const okw = lot.writeEpic(root, name);
    return out(okw ? `Epic « ${name.trim().slice(0, lot.MAX_EPIC)} » enregistré (.vibe-agent/epic).`
      : 'Refusé : nom vide ou échec d\'écriture.');
  }

  if (cmd === 'add') {
    const model = flag('model');
    if (!model) {
      return out('Refusé : --model manquant. Une préconisation de modèle par lot est obligatoire (ex. --model sonnet ou --model opus).');
    }
    const newLot = backlog.addLot(root, flag('title'), flag('scope'), model, flag('epic'), flag('verify'));
    if (!newLot) {
      const b = backlog.loadBacklog(root);
      if (b.lots.filter((l) => l.status === 'todo' || l.status === 'in_progress').length >= backlog.MAX_LOTS_OPEN) {
        return out(`Refusé : ${backlog.MAX_LOTS_OPEN} lots ouverts au plafond — un backlog n'est pas un Jira. Clore ou abandonner d'abord.`);
      }
      return out('Refusé : --title manquant ou vide.');
    }
    return out(`Lot #${newLot.id} « ${newLot.title} » ajouté (à faire) [modèle : ${newLot.model_hint}]${newLot.epic ? ` [epic : ${newLot.epic}]` : ''}${newLot.verify ? ` [verify : ${newLot.verify}]` : ''}.`);
  }

  if (cmd === 'verify') {
    const set = flag('set');
    if (!set) {
      const b = backlog.loadBacklog(root);
      const l = b.lots.find((x) => x.id === Number(id));
      return out(l ? `Verify du lot #${l.id} : ${l.verify || '(aucune)'}` : `Lot #${id} introuvable.`);
    }
    const l = backlog.setVerify(root, id, set);
    return out(l ? `Verify du lot #${l.id} enregistrée : ${l.verify}` : `Lot #${id} introuvable ou commande vide.`);
  }

  if (cmd === 'start') {
    const lot = backlog.startLot(root, id);
    if (!lot) return out(`Lot #${id} introuvable ou déjà clos/abandonné.`);
    return out(`Lot #${lot.id} « ${lot.title} » démarré (en cours)${lot.model_hint ? ` [modèle : ${lot.model_hint}]` : ''}.`);
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
    return out(lot ? `Prochain lot : #${lot.id} « ${lot.title} »${lot.model_hint ? ` [modèle : ${lot.model_hint}]` : ''}${lot.scope ? ` — ${lot.scope}` : ''}.`
      : 'Aucun lot à faire.');
  }

  if (cmd === 'reconcile') {
    const r = backlog.reconcile(root);
    if (!r.fixed.length && !r.warnings.length) return out('Rien à réparer.');
    for (const f of r.fixed) out(`Réparé : ${f}`);
    for (const w of r.warnings) out(`Note : ${w}`);
    return;
  }

  out(`Commande inconnue : ${cmd}. Commandes : show | add | start | done | drop | note | next | reconcile | epic | verify.`);
}

if (require.main === module) {
  try { main(); } catch (_) { /* fail-open */ }
  process.exit(0);
}
