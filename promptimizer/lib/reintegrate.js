'use strict';
// Réintégration en pipeline d'une vague parallèle (décision D3, principe P3 : « on ne fusionne
// jamais en big-bang »). Trois responsabilités, séparées pour rester testables :
//
//   1. planReintegration(fleet, backlog) — PUR : calcule l'ORDRE de merge (graphe depends_on)
//      des lots « prêts à merger » (état fleet `ready`), sans rien exécuter. Un lot encore en vol
//      (`in_flight`) tient la vague ouverte ; un lot dont une dépendance est encore en vol est
//      « bloqué » (jamais mergé avant elle). Ne lit/écrit rien.
//   2. aggregateChangelog(merged, opts) — PUR : bâtit l'entrée de changelog AGRÉGÉE de la vague.
//   3. runPipeline(root, opts) — EXÉCUTE le pipeline : pour chaque lot dans l'ordre, merge sa
//      branche dans la branche d'intégration → gate `verify` → si vert, avance la tête
//      d'intégration (fleet.setIntegrationHead = signal de rebase) + marque le lot `reintegrated`
//      + vigie « lot prêt » ; si rouge (conflit ou gate), ANNULE le merge et STOPPE (coupable
//      nommé, sans ambiguïté — cf. P3). Vigie « vague close » quand toute la vague est réintégrée.
//
// Contrairement aux hooks (fail-open muet), c'est une COMMANDE invoquée délibérément : elle PEUT
// rapporter une erreur (conflit, gate rouge). Mais elle reste prudente : par défaut le CLI ne fait
// que PROPOSER le plan (comme pmz:parallelize) ; l'exécution réelle exige `--execute` — la fusion
// est une frontière de vague que l'humain valide (D3, palier 2).
const { spawnSync } = require('child_process');
const { resolveTool } = require('./env');
const fleetLib = require('./fleet');
const backlogLib = require('./backlog');

const GIT = resolveTool('git');

// depends_on d'un lot, lu depuis le backlog (le fleet ne le porte pas). [] si inconnu.
function dependsOfLot(byId, id) {
  const bl = byId.get(id);
  return bl && Array.isArray(bl.depends_on) ? bl.depends_on : [];
}

// PUR. Ordonne les lots `ready` du fleet pour un merge séquentiel respectant depends_on.
// Retour : { steps:[{id,title,branch,verify,depends_on}], notReady:[{id,title,reason}],
//            blocked:[{id,title,reason}], complete:bool }.
//   - steps  : lots mergeable, dans l'ordre topologique (dépendances d'abord), id stable.
//   - notReady : lots encore `in_flight` — la vague ne peut PAS se clore tant qu'il en reste.
//   - blocked  : lot `ready` dont une dépendance in-fleet est encore en vol (ne peut merger avant
//                elle), ou pris dans un cycle. Jamais mis dans steps.
//   - complete : true si tout est réintégrable d'un coup (aucun notReady, aucun blocked).
function planReintegration(fleet, b) {
  const lots = fleet && Array.isArray(fleet.lots) ? fleet.lots : [];
  const byId = new Map(((b && Array.isArray(b.lots)) ? b.lots : []).map((l) => [l.id, l]));

  const reintegrated = new Set(lots.filter((l) => l.state === 'reintegrated').map((l) => l.id));
  const ready = lots.filter((l) => l.state === 'ready');
  const readyIds = new Set(ready.map((l) => l.id));
  // Un lot in-fleet ni ready ni déjà réintégré = encore en vol : il bloque le merge de ses dépendants.
  const inFlightIds = new Set(lots.filter((l) => l.state !== 'reintegrated' && !readyIds.has(l.id)).map((l) => l.id));

  const notReady = lots
    .filter((l) => l.state === 'in_flight')
    .map((l) => ({ id: l.id, title: l.title, reason: 'encore en vol (état in_flight)' }));

  const blocked = [];
  const candidates = ready.filter((l) => {
    const dep = dependsOfLot(byId, l.id).find((d) => inFlightIds.has(d));
    if (dep != null) {
      blocked.push({ id: l.id, title: l.title, reason: `dépend du lot #${dep} encore en vol` });
      return false;
    }
    return true;
  });

  // Tri topologique glouton : un candidat passe quand toutes ses dépendances in-fleet `ready`
  // sont déjà placées (les déjà-réintégrées comptent comme satisfaites). Progrès garanti sinon
  // cycle → tout le reste bloqué.
  const placed = new Set(reintegrated);
  const steps = [];
  let remaining = candidates.slice();
  while (remaining.length) {
    const batch = remaining
      .filter((l) => dependsOfLot(byId, l.id).every((d) => (readyIds.has(d) ? placed.has(d) : true)))
      .sort((a, c) => a.id - c.id);
    if (!batch.length) {
      for (const l of remaining) blocked.push({ id: l.id, title: l.title, reason: 'dépendance circulaire' });
      break;
    }
    for (const l of batch) {
      const bl = byId.get(l.id);
      steps.push({
        id: l.id,
        title: l.title || (bl && bl.title) || null,
        branch: l.branch || (bl ? backlogLib.waveBranch(bl) : null),
        verify: (bl && bl.verify) || null,
        depends_on: dependsOfLot(byId, l.id),
      });
      placed.add(l.id);
    }
    const done = new Set(batch.map((l) => l.id));
    remaining = remaining.filter((l) => !done.has(l.id));
  }

  return { steps, notReady, blocked, complete: notReady.length === 0 && blocked.length === 0 && steps.length > 0 };
}

// PUR. Entrée de changelog AGRÉGÉE de la vague : un seul bloc daté résumant tous les lots
// réellement réintégrés. opts : { waveId, date (ISO court), integrationBranch }. `date` est
// injecté (jamais new Date() ici) pour rester pur et testable.
function aggregateChangelog(merged, opts) {
  const o = opts || {};
  const done = (Array.isArray(merged) ? merged : []).filter((m) => m && m.status === 'reintegrated');
  const date = o.date || '';
  const wave = o.waveId ? ` « ${o.waveId} »` : '';
  const lines = [];
  lines.push(`## ${date} — Réintégration de vague${wave} (${done.length} lot${done.length > 1 ? 's' : ''})`);
  if (o.integrationBranch) lines.push('');
  if (o.integrationBranch) lines.push(`Branche d'intégration : \`${o.integrationBranch}\`.`);
  lines.push('');
  for (const m of done) {
    const title = m.title ? ` « ${m.title} »` : '';
    const head = m.head ? ` — ${String(m.head).slice(0, 7)}` : '';
    lines.push(`- Lot #${m.id}${title} réintégré (gate verify vert)${head}.`);
  }
  return lines.join('\n');
}

// Exécuteur git réel (chemin absolu résolu comme project.js). Renvoie { code, out }.
function realGit(root, args) {
  const r = spawnSync(GIT, args, { cwd: root, encoding: 'utf8', timeout: 120000 });
  return { code: r.status == null ? 1 : r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// Exécuteur du gate `verify` (commande shell). Renvoie { code, out }.
function realVerify(root, cmd) {
  const r = spawnSync(cmd, { cwd: root, shell: true, encoding: 'utf8', timeout: 600000 });
  return { code: r.status == null ? 1 : r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function headSha(root, git) {
  const r = git(['rev-parse', 'HEAD']);
  return r.code === 0 ? r.out.trim() : null;
}
function currentBranch(root, git) {
  const r = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.code === 0 && r.out.trim() && r.out.trim() !== 'HEAD' ? r.out.trim() : null;
}

// EXÉCUTE le pipeline de merge. opts injectables (tests) : { git, verify, notify, notifyOpts,
// into (branche d'intégration forcée), fleet, backlog }. Défauts = git/verify réels, notify réel.
// Retour : { ok, reason?, culprit?, integrationBranch, merged:[{id,status,...}], plan, waveClosed }.
// status par lot : reintegrated | conflict | gate-failed | skipped.
function runPipeline(root, opts) {
  const o = opts || {};
  const notify = o.notify || require('./notify');
  const notifyOpts = o.notifyOpts;
  const git = o.git || ((args) => realGit(root, args));
  const verify = o.verify || ((cmd) => realVerify(root, cmd));
  const f = o.fleet || fleetLib.loadFleet(root);
  const b = o.backlog || backlogLib.loadBacklog(root);
  const plan = planReintegration(f, b);
  const merged = [];

  const integrationBranch = o.into || f.integration_branch || currentBranch(root, git);
  if (!integrationBranch) return { ok: false, reason: 'no-integration-branch', plan, merged, integrationBranch: null, waveClosed: false };
  if (!plan.steps.length) return { ok: true, reason: 'nothing-ready', plan, merged, integrationBranch, waveClosed: false };

  const co = git(['checkout', integrationBranch]);
  if (co.code !== 0) return { ok: false, reason: 'checkout-failed', out: co.out, plan, merged, integrationBranch, waveClosed: false };

  for (const step of plan.steps) {
    if (!step.branch) { merged.push({ id: step.id, title: step.title, status: 'skipped', reason: 'branche inconnue' }); continue; }
    // Vigie « lot prêt à merger » : ce lot fille est prêt, on l'intègre maintenant (D3 §Signal).
    notify.notifyLotReady({ id: step.id, title: step.title }, notifyOpts);
    const before = headSha(root, git);
    const msg = `pmz: réintègre lot #${step.id}${step.title ? ` — ${step.title}` : ''}`;
    const mg = git(['merge', '--no-ff', step.branch, '-m', msg]);
    if (mg.code !== 0) {
      git(['merge', '--abort']);
      merged.push({ id: step.id, title: step.title, status: 'conflict', out: mg.out });
      return finalize({ ok: false, reason: 'conflict', culprit: step, plan, merged, integrationBranch }, notify, notifyOpts);
    }
    if (step.verify) {
      const vf = verify(step.verify);
      if (vf.code !== 0) {
        if (before) git(['reset', '--hard', before]); // annule le merge : le coupable est CE lot (P3)
        merged.push({ id: step.id, title: step.title, status: 'gate-failed', out: vf.out });
        return finalize({ ok: false, reason: 'gate-failed', culprit: step, plan, merged, integrationBranch }, notify, notifyOpts);
      }
    }
    const head = headSha(root, git);
    fleetLib.setIntegrationHead(root, head, integrationBranch); // signal de rebase pour les lots en vol
    fleetLib.setLotState(root, step.id, 'reintegrated');
    merged.push({ id: step.id, title: step.title, status: 'reintegrated', head });
  }
  return finalize({ ok: true, plan, merged, integrationBranch }, notify, notifyOpts);
}

// Vigie « vague close » : uniquement si TOUT est réintégré (aucun lot en vol, aucun bloqué, tous
// les steps mergés vert). Un pipeline partiel (lots encore en vol) ne clôt pas la vague.
function finalize(res, notify, notifyOpts) {
  const allMerged = res.merged.length > 0 && res.merged.every((m) => m.status === 'reintegrated');
  const complete = !!res.ok && res.plan.notReady.length === 0 && res.plan.blocked.length === 0 && allMerged;
  res.waveClosed = complete;
  if (complete) notify.notifyWaveClosed({ count: res.merged.length, branch: res.integrationBranch }, notifyOpts);
  return res;
}

module.exports = { planReintegration, aggregateChangelog, runPipeline };
