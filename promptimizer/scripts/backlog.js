#!/usr/bin/env node
'use strict';
// CLI du plan de lots (.vibe-agent/backlog.json). Invoqué par l'assistant via
// /scope, /close-batch ou la consigne MSG_LARGE. Arguments par argv (citables,
// auditables par PreToolUse), sortie lisible par défaut, --json pour la machine.
// Toujours exit 0 (fail-open) : une erreur de plan ne doit jamais casser un flux.
const { gitRoot } = require('../lib/project');
const { parseCwd } = require('../lib/cli');
const backlog = require('../lib/backlog');
const reint = require('../lib/reintegrate');
const lot = require('../lib/lot');
const trigram = require('../lib/trigram');
const { fmtK } = require('../lib/messages');

const LABELS = { todo: 'à faire', in_progress: 'en cours', done: 'fait', dropped: 'abandonné' };

function flag(name) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] != null ? process.argv[i + 1] : null;
}
// Liste de valeurs, RÉPÉTABLE (« --perimeter a --perimeter b ») ET à virgules
// (« --perimeter "lib/a,lib/b" ») — les deux formes se cumulent dans l'ordre d'apparition.
// Nettoyée (trim, vides écartés). [] si le flag est absent.
function flagList(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === '--' + name && process.argv[i + 1] != null) {
      for (const s of String(process.argv[i + 1]).split(',').map((x) => x.trim()).filter(Boolean)) out.push(s);
    }
  }
  return out;
}
function out(s) { process.stdout.write(s + '\n'); }
// Suffixe texte de l'estimation prédictive (lot #63) : vide si backlog.estimateCost n'a
// aucune famille comparable (pas de lot clos avec cost_tokens > 0 sur ce modèle/effort/epic).
function estimateSuffix(b, l) {
  const est = backlog.estimateCost(b, l);
  if (!est) return '';
  return ` Estimation (${est.count} lot${est.count > 1 ? 's' : ''} comparable${est.count > 1 ? 's' : ''} par ${est.basis}) : ~${fmtK(est.avg)} tokens.`;
}
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
    line += backlog.modelEffortTag(l);
    if (l.verify) line += ` [verify : ${l.verify}]`;
    if (l.perimeter && l.perimeter.length) line += ` [périmètre : ${l.perimeter.join(', ')}]`;
    if (l.depends_on && l.depends_on.length) line += ` [dépend de : ${l.depends_on.map((d) => '#' + d).join(', ')}]`;
    if (l.status === 'done' && l.closed_commit) line += ` — commit ${l.closed_commit}`;
    else if (l.scope) line += ` — ${l.scope}`;
    if (l.status === 'done' && Number.isFinite(l.closed_occupancy)) line += ` (occupation à la clôture : ${l.closed_occupancy})`;
    if (Number.isFinite(l.cost_tokens) && l.cost_tokens > 0) line += ` (coût ~${fmtK(l.cost_tokens)} tokens de sortie)`;
    if (l.note) line += ` (note : ${l.note})`;
    out(line);
  }
}

// pmz:parallelize — calcule un plan de vagues parallèles (périmètres disjoints + ordre
// depends_on) et le PROPOSE : branches + périmètres, sans RIEN lancer (ni branche, ni worktree,
// ni session fille). Refuse les intersections (jamais deux périmètres chevauchants dans une
// vague). Le lancement reste manuel et validé par l'humain (cf. D3, palier 2).
function parallelize(root, json, epicFilter) {
  let b = backlog.loadBacklog(root);
  if (epicFilter) b = { ...b, lots: b.lots.filter((l) => l.epic === epicFilter) };
  const plan = backlog.planWaves(b);
  const withBranch = (l) => ({ id: l.id, title: l.title, branch: backlog.waveBranch(l), perimeter: l.perimeter, depends_on: l.depends_on });

  if (json) {
    return out(JSON.stringify({
      launched: false,
      waves: plan.waves.map((w) => w.map(withBranch)),
      unplannable: plan.unplannable.map((u) => ({ id: u.lot.id, title: u.lot.title, reason: u.reason })),
      blocked: plan.blocked.map((x) => ({ id: x.lot.id, title: x.lot.title, reason: x.reason })),
    }, null, 2));
  }

  const nParallel = plan.waves.reduce((s, w) => s + w.length, 0);
  out('## Plan de vagues (proposition — rien n\'est lancé)');
  if (!nParallel && !plan.unplannable.length && !plan.blocked.length) {
    return out(epicFilter ? `Aucun lot « à faire » pour l'epic « ${epicFilter} » — rien à paralléliser.`
      : 'Aucun lot « à faire » — rien à paralléliser.');
  }
  out(`${nParallel} lot(s) parallélisable(s) sur ${plan.waves.length} vague(s).`);
  out('');
  plan.waves.forEach((w, i) => {
    out(`### Vague ${i + 1} — ${w.length} lot(s) en parallèle`);
    for (const l of w) {
      const dep = l.depends_on.length ? ` (dépend de ${l.depends_on.map((d) => '#' + d).join(', ')})` : '';
      out(`- #${l.id} « ${l.title} »${dep} — branche \`${backlog.waveBranch(l)}\` — périmètre : ${l.perimeter.join(', ')}`);
    }
    out('');
  });
  if (plan.unplannable.length) {
    out(`Non parallélisables (aucun périmètre) : ${plan.unplannable.map((u) => '#' + u.lot.id).join(', ')} — à traiter en série.`);
  }
  if (plan.blocked.length) {
    for (const x of plan.blocked) out(`Bloqué : #${x.lot.id} « ${x.lot.title} » — ${x.reason}.`);
  }
  out('');
  out('⚠️ Proposition seule : aucune branche, worktree ni session fille n\'a été créé.');
  out(`Pour lancer une vague, valide le plan puis démarre chaque lot manuellement : node ${PMZ_BASE}/scripts/backlog.js start --id <id> --owner <session>.`);
}

// pmz:reintegrate — réintègre une vague parallèle EN PIPELINE (D3, P3) : merge séquentiel dans
// l'ordre du graphe depends_on, gate `verify` à chaque étape, avance de la tête d'intégration
// (signal de rebase) + changelog agrégé. Par défaut PROPOSE le plan (rien mergé) ; `--execute`
// exécute réellement. `--into <branche>` force la branche d'intégration.
function reintegrate(root, json, execute, into) {
  const fleet = require('../lib/fleet').loadFleet(root);
  const b = backlog.loadBacklog(root);
  const plan = reint.planReintegration(fleet, b);
  const byId = new Map(b.lots.map((l) => [l.id, l]));
  const dateOf = () => new Date().toISOString().slice(0, 10);

  const extensions = require('../lib/fleet').pendingExtensions(fleet);
  if (!execute) {
    if (json) {
      return out(JSON.stringify({
        executed: false,
        integration_branch: into || fleet.integration_branch || null,
        steps: plan.steps,
        notReady: plan.notReady,
        blocked: plan.blocked,
        extensions,
        complete: plan.complete,
      }, null, 2));
    }
    out('## Plan de réintégration (proposition — rien n\'est mergé)');
    if (!plan.steps.length && !plan.notReady.length && !plan.blocked.length) {
      return out('Aucune vague active à réintégrer (aucun lot « prêt à merger » dans fleet.json).');
    }
    const ib = into || fleet.integration_branch;
    out(ib ? `Branche d'intégration : \`${ib}\`.` : 'Branche d\'intégration : (courante au moment du --execute).');
    out('');
    if (plan.steps.length) {
      out(`${plan.steps.length} lot(s) à merger, dans l'ordre du graphe :`);
      plan.steps.forEach((s, i) => {
        const dep = s.depends_on.length ? ` (dépend de ${s.depends_on.map((d) => '#' + d).join(', ')})` : '';
        out(`${i + 1}. #${s.id} « ${s.title || '?'} »${dep} — branche \`${s.branch || '?'}\` — gate : ${s.verify || '(aucune)'}`);
      });
    } else {
      out('Aucun lot « prêt à merger ».');
    }
    if (plan.notReady.length) {
      out('');
      out(`Encore en vol (tiennent la vague ouverte) : ${plan.notReady.map((x) => '#' + x.id).join(', ')}.`);
    }
    if (plan.blocked.length) {
      out('');
      for (const x of plan.blocked) out(`Bloqué : #${x.id} « ${x.title || '?'} » — ${x.reason}.`);
    }
    if (extensions.length) {
      out('');
      out('Demandes d\'élargissement de périmètre en attente (à arbitrer avant de merger) :');
      for (const e of extensions) {
        out(`- #${e.id}${e.title ? ` « ${e.title} »` : ''} a voulu écrire hors zone : ${e.paths.join(', ')}.`);
      }
    }
    out('');
    out('⚠️ Proposition seule : aucune branche n\'a été mergée, fleet.json inchangé.');
    out(`Pour exécuter le pipeline (merge + gate à chaque étape) : node ${PMZ_BASE}/scripts/backlog.js reintegrate --execute.`);
    return;
  }

  // --execute : exécution réelle du pipeline.
  const res = reint.runPipeline(root, { into });
  if (json) {
    return out(JSON.stringify({ executed: true, ...res }, null, 2));
  }
  if (res.reason === 'no-integration-branch') return out('Refusé : aucune branche d\'intégration (ni fleet.integration_branch, ni --into, ni branche courante).');
  if (res.reason === 'nothing-ready') return out('Rien à réintégrer : aucun lot « prêt à merger ».');
  if (res.reason === 'checkout-failed') return out(`Refusé : checkout de \`${res.integrationBranch}\` impossible (arbre sale ?).\n${(res.out || '').trim()}`);

  out('## Réintégration de vague');
  out(`Branche d'intégration : \`${res.integrationBranch}\`.`);
  out('');
  for (const m of res.merged) {
    const t = m.title ? ` « ${m.title} »` : '';
    if (m.status === 'reintegrated') out(`✅ #${m.id}${t} — mergé + gate vert (${String(m.head || '').slice(0, 7)}).`);
    else if (m.status === 'conflict') out(`❌ #${m.id}${t} — CONFLIT de merge, annulé. Pipeline stoppé (le coupable est ce lot).`);
    else if (m.status === 'gate-failed') out(`❌ #${m.id}${t} — merge OK mais GATE ROUGE, merge annulé. Pipeline stoppé (le coupable est ce lot).`);
    else out(`⏭️ #${m.id}${t} — sauté (${m.reason || 'raison inconnue'}).`);
  }
  if (!res.ok && res.culprit) {
    out('');
    out(`⛔ Vague NON close : corrige le lot #${res.culprit.id}, remets-le « prêt », puis relance --execute.`);
    return;
  }
  out('');
  out(reint.aggregateChangelog(res.merged, { waveId: fleet.wave_id, date: dateOf(), integrationBranch: res.integrationBranch }));
  out('');
  out(res.waveClosed
    ? '🎉 Vague entièrement réintégrée et close. Colle le bloc ci-dessus dans CHANGELOG.md, puis commit.'
    : 'Lots prêts réintégrés. La vague reste ouverte (des lots sont encore en vol).');
}

function main() {
  const root = gitRoot(parseCwd());
  if (!root) return out('Pas un dépôt git — backlog indisponible.');
  const cmd = (process.argv[2] || '').startsWith('--') ? 'show' : (process.argv[2] || 'show');
  // Garde anti-troncature (#88) : un flag mono-valeur non quoté (« --title fait quand : X »)
  // ne capte que le 1er token ; les tokens nus suivants seraient jetés en silence.
  // On les repère et on rejette explicitement plutôt que de tronquer sans le dire.
  const argStart = (process.argv[2] || '').startsWith('--') ? 2 : 3;
  const orphans = backlog.orphanArgs(process.argv, argStart);
  if (orphans.length) {
    return out(`Refusé : argument(s) orphelin(s) ignoré(s) — ${orphans.map((o) => `« ${o} »`).join(', ')}. `
      + 'Probablement une valeur non quotée : mets-la entre guillemets, ex. --title "fait quand : …".');
  }
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

  if (cmd === 'trigram') {
    if (process.argv.includes('--suggest')) {
      return out(trigram.suggestTrigrams(root).map((t) => `[${t}]`).join(' / '));
    }
    const set = flag('set');
    if (!set) return out(`Trigramme actuel : [${trigram.readTrigram(root)}]`);
    const applied = trigram.writeTrigram(root, set);
    return out(applied ? `Trigramme « [${applied}] » enregistré (.vibe-agent/trigram).`
      : 'Refusé : trigramme invalide.');
  }

  if (cmd === 'add') {
    const model = flag('model');
    if (!model) {
      return out('Refusé : --model manquant. Une préconisation de modèle par lot est obligatoire (ex. --model sonnet ou --model opus).');
    }
    const effort = flag('effort');
    if (effort && !backlog.EFFORT_LEVELS.includes(effort)) {
      return out(`Refusé : --effort invalide (« ${effort} »). Valeurs acceptées : ${backlog.EFFORT_LEVELS.join(' | ')}.`);
    }
    const depends = flagList('depends').map(Number).filter(Number.isFinite);
    const newLot = backlog.addLot(root, flag('title'), flag('scope'), model, flag('epic'), flag('verify'), effort, flagList('perimeter'), depends);
    if (!newLot) {
      const b = backlog.loadBacklog(root);
      if (b.lots.filter((l) => l.status === 'todo' || l.status === 'in_progress').length >= backlog.MAX_LOTS_OPEN) {
        return out(`Refusé : ${backlog.MAX_LOTS_OPEN} lots ouverts au plafond — un backlog n'est pas un Jira. Clore ou abandonner d'abord.`);
      }
      return out('Refusé : --title manquant ou vide.');
    }
    let addMsg = `Lot #${newLot.id} « ${newLot.title} » ajouté (à faire)${backlog.modelEffortTag(newLot)}${newLot.epic ? ` [epic : ${newLot.epic}]` : ''}${newLot.verify ? ` [verify : ${newLot.verify}]` : ''}${newLot.perimeter.length ? ` [périmètre : ${newLot.perimeter.join(', ')}]` : ''}${newLot.depends_on.length ? ` [dépend de : ${newLot.depends_on.map((d) => '#' + d).join(', ')}]` : ''}.`;
    addMsg += estimateSuffix(backlog.loadBacklog(root), newLot);
    return out(addMsg);
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
    const lot = backlog.startLot(root, id, flag('owner'));
    if (!lot) return out(`Lot #${id} introuvable ou déjà clos/abandonné.`);
    let startMsg = `Lot #${lot.id} « ${lot.title} » démarré (en cours)${backlog.modelEffortTag(lot)}${lot.session_owner ? ` [session : ${lot.session_owner}]` : ''}.`;
    startMsg += estimateSuffix(backlog.loadBacklog(root), lot);
    return out(startMsg);
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
    return out(lot ? `Prochain lot : #${lot.id} « ${lot.title} »${backlog.modelEffortTag(lot)}${lot.scope ? ` — ${lot.scope}` : ''}.`
      : 'Aucun lot à faire.');
  }

  if (cmd === 'export') {
    const format = flag('format') || 'md';
    if (format !== 'md' && format !== 'csv') {
      return out(`Refusé : --format invalide (« ${format} »). Valeurs acceptées : md | csv.`);
    }
    const b = backlog.loadBacklog(root);
    return out(format === 'csv' ? backlog.exportCsv(b) : backlog.exportMarkdown(b));
  }

  if (cmd === 'parallelize') return parallelize(root, json, flag('epic'));

  if (cmd === 'reintegrate') return reintegrate(root, json, process.argv.includes('--execute'), flag('into'));

  if (cmd === 'reconcile') {
    const r = backlog.reconcile(root);
    if (!r.fixed.length && !r.warnings.length) return out('Rien à réparer.');
    for (const f of r.fixed) out(`Réparé : ${f}`);
    for (const w of r.warnings) out(`Note : ${w}`);
    return;
  }

  out(`Commande inconnue : ${cmd}. Commandes : show | add | start | done | drop | note | next | parallelize | reintegrate | reconcile | epic | verify | trigram | export.`);
}

if (require.main === module) {
  try { main(); } catch (_) { /* fail-open */ }
  process.exit(0);
}
