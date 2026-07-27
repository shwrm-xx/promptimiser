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
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveTool } = require('./env');
const { writeAtomicText } = require('./fsjson');
const fleetLib = require('./fleet');
const backlogLib = require('./backlog');
const handoffLib = require('./handoff');

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

// PUR. Union DÉDOUBLONNÉE des commandes `verify` de TOUS les lots de la vague (fleet), résolues
// depuis le backlog. Base du gate FINAL de vague (lot #97) : on ne se limite PAS aux steps du run
// courant — planReintegration exclut les lots déjà `reintegrated`, donc en pipeline multi-runs
// (vague close en plusieurs invocations) l'union du dernier run raterait les verify des lots
// mergés aux runs précédents. Ordre stable par id (déterministe et testable).
function waveGateCommands(fleet, b) {
  const lots = (fleet && Array.isArray(fleet.lots) ? fleet.lots : []).slice().sort((a, c) => a.id - c.id);
  const byId = new Map(((b && Array.isArray(b.lots)) ? b.lots : []).map((l) => [l.id, l]));
  const seen = new Set();
  const cmds = [];
  for (const l of lots) {
    const bl = byId.get(l.id);
    const v = (bl && bl.verify) || null;
    if (v && !seen.has(v)) { seen.add(v); cmds.push(v); }
  }
  return cmds;
}

// Steps du plan qui seraient mergés SANS aucun gate (lot #97, FIA-16). Un lot sans verify était
// mergé sans filet : si ce merge cassait le build, c'était le gate du lot SUIVANT qui rougissait
// et le pipeline nommait le mauvais coupable. `fallbackGate` (flag --gate) couvre ces steps.
function noGateSteps(plan, fallbackGate) {
  if (fallbackGate) return [];
  return (plan && Array.isArray(plan.steps) ? plan.steps : [])
    .filter((s) => !s.verify)
    .map((s) => ({ id: s.id, title: s.title || null }));
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
    // Ne JAMAIS revendiquer « gate vert » pour un lot mergé sans gate (lot #97) : avec
    // --allow-no-gate le merge est délibérément non vérifié, le changelog doit le dire.
    const gate = m.gate ? 'gate verify vert' : 'SANS gate (--allow-no-gate)';
    lines.push(`- Lot #${m.id}${title} réintégré (${gate})${head}.`);
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
// into (branche d'intégration forcée), fleet, backlog, allowNoGate, gate, finalGate }.
// Défauts = git/verify réels, notify réel.
//   - allowNoGate : autorise le merge de lots SANS verify (refus explicite sinon, cf. noGateSteps).
//   - gate        : commande de gate de REPLI, exécutée pour les steps sans verify propre. Fournie
//                   ⇒ plus aucun step sans gate ⇒ pas de refus. Pas de changement de schéma
//                   (aucun champ verify dans fleet.json) : un simple flag CLI.
//   - finalGate   : commande de gate FINAL de vague dédiée ; à défaut, union des verify de la vague.
// Retour : { ok, reason?, culprit?, integrationBranch, merged:[{id,status,...}], plan, waveClosed,
//            finalGate? }. status par lot : reintegrated | conflict | gate-failed | skipped.
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

  // Refus AVANT tout merge (lot #97) : ce n'est pas un hook mais une COMMANDE délibérée, elle PEUT
  // refuser. Un lot sans gate mergé sans filet fait rougir le gate du lot SUIVANT et nomme le
  // mauvais coupable — l'humain tranche : --gate <cmd> (repli) ou --allow-no-gate (assumé).
  const noGate = noGateSteps(plan, o.gate);
  if (noGate.length && !o.allowNoGate) {
    return { ok: false, reason: 'no-gate', noGate, plan, merged, integrationBranch, waveClosed: false };
  }

  const co = git(['checkout', integrationBranch]);
  if (co.code !== 0) return { ok: false, reason: 'checkout-failed', out: co.out, plan, merged, integrationBranch, waveClosed: false };

  // Dernière commande de gate passée VERTE sur l'état fusionné final : sert à dédoublonner
  // l'exécution du gate final (chaque verify coûte jusqu'à 600 s).
  let lastGreen = null;
  const ctx = { notify, notifyOpts, verify, fleet: f, backlog: b, finalGate: o.finalGate || null };

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
      return finalize({ ok: false, reason: 'conflict', culprit: step, plan, merged, integrationBranch }, ctx);
    }
    const gateCmd = step.verify || o.gate || null;
    if (gateCmd) {
      const vf = verify(gateCmd);
      if (vf.code !== 0) {
        if (before) git(['reset', '--hard', before]); // annule le merge : le coupable est CE lot (P3)
        merged.push({ id: step.id, title: step.title, status: 'gate-failed', gate: gateCmd, out: vf.out });
        return finalize({ ok: false, reason: 'gate-failed', culprit: step, plan, merged, integrationBranch }, ctx);
      }
      lastGreen = gateCmd;
    } else {
      lastGreen = null; // merge non vérifié : plus rien n'est prouvé sur l'état final
    }
    const head = headSha(root, git);
    fleetLib.setIntegrationHead(root, head, integrationBranch); // signal de rebase pour les lots en vol
    fleetLib.setLotState(root, step.id, 'reintegrated');
    merged.push({ id: step.id, title: step.title, status: 'reintegrated', gate: gateCmd, head });
  }
  ctx.lastGreen = lastGreen;
  const res = finalize({ ok: true, plan, merged, integrationBranch }, ctx);
  if (res.waveClosed) closeWave(root, res);
  return res;
}

// Vague close : on RANGE derrière soi (lot #99, FIA-20/FIA-19). Sans cette purge, fleet.json
// gardait ses lots `reintegrated` — vague « active » indéfiniment — et les handoff-lot-*.md des
// filles restaient sur disque en péremption. Snapshot AVANT vidage : la trace de la vague
// (lots, ext_requests, wave_id) part dans le rapport persisté, elle n'est pas perdue.
// Best-effort intégral : un échec de rangement ne remet JAMAIS en cause la clôture.
function closeWave(root, res) {
  try {
    res.waveSnapshot = fleetLib.loadFleet(root);
    res.wavePurged = fleetLib.clearWave(root);
    res.handoffsPurged = handoffLib.purgeLotHandoffs(root);
  } catch (_) {
    /* fail-open */
  }
}

// Gate FINAL de vague (lot #97, décision D3 P3 : « la vague n'est close que quand la branche
// d'intégration passe typecheck + tests + build »). Deux lots verts SÉPARÉMENT peuvent être rouges
// COMBINÉS (interférence sémantique sans conflit git) : la clôture ne peut pas se déduire des seuls
// statuts. Commandes : finalGate dédié si fourni (intention explicite, toujours exécuté), sinon
// union des verify de TOUTE la vague privée de la dernière commande déjà passée verte sur l'état
// final (déduplication d'exécution). Retour : { ran, ok?, reason?, commands, failed?, out? }.
function finalGateOf(ctx) {
  if (ctx.finalGate) return runGateCommands([ctx.finalGate], ctx.verify);
  const all = waveGateCommands(ctx.fleet, ctx.backlog);
  const todo = all.filter((c) => c !== ctx.lastGreen);
  if (!todo.length) {
    // Cas dégénéré tranché explicitement : on CLÔT plutôt que de bloquer, mais la raison est
    // visible (« no-gate » = aucun lot de la vague ne porte de verify ; « already-green » = le
    // gate couvrant vient de tourner vert sur l'état final).
    return { ran: false, ok: true, reason: all.length ? 'already-green' : 'no-gate', commands: [] };
  }
  return runGateCommands(todo, ctx.verify);
}

function runGateCommands(cmds, verify) {
  for (const cmd of cmds) {
    const vf = verify(cmd);
    if (vf.code !== 0) return { ran: true, ok: false, reason: 'failed', commands: cmds, failed: cmd, out: vf.out };
  }
  return { ran: true, ok: true, commands: cmds };
}

// Vigie « vague close » : uniquement si TOUT est réintégré (aucun lot en vol, aucun bloqué, tous
// les steps mergés vert) ET que le gate FINAL passe sur la branche d'intégration. Un pipeline
// partiel (lots encore en vol) ne clôt pas la vague.
// Gate final rouge → waveClosed:false + reason 'final-gate-failed', SANS rollback ni retouche des
// états fleet `reintegrated` déjà posés : les merges restent faits, seul le signal de clôture est
// retenu — l'humain arbitre (D3, palier 2).
function finalize(res, ctx) {
  const allMerged = res.merged.length > 0 && res.merged.every((m) => m.status === 'reintegrated');
  const complete = !!res.ok && res.plan.notReady.length === 0 && res.plan.blocked.length === 0 && allMerged;
  if (!complete) { res.waveClosed = false; return res; }
  const fg = finalGateOf(ctx);
  res.finalGate = fg;
  if (!fg.ok) {
    res.ok = false;
    res.reason = 'final-gate-failed';
    res.waveClosed = false;
    return res;
  }
  res.waveClosed = true;
  ctx.notify.notifyWaveClosed({ count: res.merged.length, branch: res.integrationBranch }, ctx.notifyOpts);
  return res;
}

// PUR. Rapport COMPLET d'un run de `--execute` (lot #99, FIA-22). Le bloc changelog agrégé et
// surtout la SORTIE des gates rouges n'existaient que sur stdout : une session qui crashe ou
// qui omet le collage les perdait sans recours — une ré-exécution renvoie 'nothing-ready' (les
// lots sont déjà `reintegrated`) et rien ne sait régénérer le bloc. Ici, tout est sur disque.
// opts : { waveId, date (ISO court), stamp (horodatage lisible) }.
function reintegrateReport(res, opts) {
  const o = opts || {};
  const r = res || {};
  const merged = Array.isArray(r.merged) ? r.merged : [];
  const plan = r.plan || { steps: [], notReady: [], blocked: [] };
  const L = [];
  L.push(`# Réintégration de vague${o.waveId ? ` « ${o.waveId} »` : ''} — ${o.stamp || o.date || ''}`);
  L.push('');
  L.push(`- Branche d'intégration : \`${r.integrationBranch || '?'}\``);
  L.push(`- Résultat : ${r.ok ? 'OK' : 'ÉCHEC'}${r.reason ? ` (${r.reason})` : ''}`);
  L.push(`- Vague close : ${r.waveClosed ? 'oui' : 'non'}`);
  if (r.culprit) L.push(`- Coupable nommé : lot #${r.culprit.id}${r.culprit.title ? ` « ${r.culprit.title} »` : ''}`);
  L.push('');

  L.push('## Plan exécuté');
  if (plan.steps.length) {
    for (const s of plan.steps) {
      const dep = s.depends_on && s.depends_on.length ? ` (dépend de ${s.depends_on.map((d) => '#' + d).join(', ')})` : '';
      L.push(`- #${s.id} « ${s.title || '?'} »${dep} — branche \`${s.branch || '?'}\` — gate : ${s.verify || '(aucune)'}`);
    }
  } else {
    L.push('- (aucun lot mergeable)');
  }
  if (plan.notReady && plan.notReady.length) L.push(`- Encore en vol : ${plan.notReady.map((x) => '#' + x.id).join(', ')}`);
  if (plan.blocked && plan.blocked.length) for (const x of plan.blocked) L.push(`- Bloqué : #${x.id} — ${x.reason}`);
  L.push('');

  L.push('## Statut par lot');
  for (const m of merged) {
    L.push(`- #${m.id}${m.title ? ` « ${m.title} »` : ''} — **${m.status}**${m.head ? ` (${String(m.head).slice(0, 7)})` : ''}${m.gate ? ` — gate : \`${m.gate}\`` : ''}${m.reason ? ` — ${m.reason}` : ''}`);
  }
  if (!merged.length) L.push('- (aucun merge tenté)');
  // Sortie INTÉGRALE des échecs : c'est le diagnostic qui disparaissait avec le terminal (et
  // que le mode humain du CLI n'affichait même pas — seul --json le portait).
  for (const m of merged) {
    if (!m.out) continue;
    L.push('');
    L.push(`### Sortie — #${m.id} (${m.status})`);
    L.push('```');
    L.push(String(m.out).trim());
    L.push('```');
  }
  L.push('');

  const fg = r.finalGate;
  if (fg) {
    L.push('## Gate final de vague');
    if (fg.ran && fg.ok) L.push(`✅ vert : ${(fg.commands || []).join(' && ')}`);
    else if (fg.ran) {
      L.push(`❌ ROUGE : \`${fg.failed}\``);
      L.push('```');
      L.push(String(fg.out || '').trim());
      L.push('```');
    } else L.push(`non exécuté (${fg.reason || '?'})`);
    L.push('');
  }

  L.push('## Bloc changelog agrégé (à coller dans CHANGELOG.md)');
  L.push('');
  L.push(aggregateChangelog(merged, { waveId: o.waveId, date: o.date, integrationBranch: r.integrationBranch }));
  L.push('');

  // Snapshot pris AVANT le vidage du fleet : seule trace restante de la composition de la
  // vague (qui tenait quoi, quelles demandes d'élargissement) une fois fleet.json purgé.
  const snap = r.waveSnapshot;
  if (snap && Array.isArray(snap.lots) && snap.lots.length) {
    L.push('## Composition de la vague (snapshot avant purge de fleet.json)');
    for (const l of snap.lots) {
      const ext = l.ext_requests && l.ext_requests.length ? ` — demandes hors périmètre : ${l.ext_requests.join(', ')}` : '';
      L.push(`- #${l.id}${l.title ? ` « ${l.title} »` : ''} — session ${l.session_owner} — branche \`${l.branch || '?'}\` — état ${l.state}${ext}`);
    }
    L.push('');
  }
  return L.join('\n');
}

// Persiste le rapport sous `.vibe-agent/logs/reintegrate-<stamp>.md`. Même motif de « tiroir
// brut » que lib/output-fallback : jamais injecté au SessionStart (aucun code SessionStart ne
// lit .vibe-agent/logs), référencé par CHEMIN dans la sortie du CLI. Horodatage à la seconde +
// suffixe unique : un rerun le même jour (cas nominal après correction d'un gate rouge) ne doit
// pas écraser le rapport du run précédent. Renvoie le chemin relatif au repo, ou null.
function writeReintegrateReport(root, res, opts) {
  try {
    if (!root || !res) return null;
    const now = new Date();
    const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const dir = path.join(root, '.vibe-agent', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `reintegrate-${stamp}-${process.pid.toString(36)}.md`);
    const body = reintegrateReport(res, Object.assign({
      date: now.toISOString().slice(0, 10),
      stamp: `${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    }, opts || {}));
    return writeAtomicText(file, body + '\n') ? path.relative(root, file) : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  planReintegration,
  aggregateChangelog,
  runPipeline,
  waveGateCommands,
  noGateSteps,
  reintegrateReport,
  writeReintegrateReport,
};
