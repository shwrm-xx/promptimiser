#!/usr/bin/env node
'use strict';
// CLI du plan de lots (.vibe-agent/backlog.json). Invoqué par l'assistant via
// /scope, /close-batch ou la consigne MSG_LARGE. Arguments par argv (citables,
// auditables par PreToolUse), sortie lisible par défaut, --json pour la machine.
// Toujours exit 0 (fail-open) : une erreur de plan ne doit jamais casser un flux.
const fs = require('fs');
const path = require('path');
const { gitRoot, runVerify } = require('../lib/project');
const { resolveVerifyCloseMs } = require('../lib/timeouts');
const { parseCwd } = require('../lib/cli');
const backlog = require('../lib/backlog');
const reint = require('../lib/reintegrate');
const lot = require('../lib/lot');
const trigram = require('../lib/trigram');
const perimeter = require('../lib/perimeter');
const { fmtK } = require('../lib/messages');
const { previousSessionId, markPlanSession } = require('../lib/state');
const { loadContextLedger } = require('../lib/ledger');

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

// Garde anti-troncature de champ (#90) : une valeur au-delà de son plafond MAX_* serait
// stockée coupée par trunc() (« … » en pleine phrase) sans un mot dans la sortie. On refuse
// explicitement — longueur reçue vs plafond — sauf --allow-trunc (acceptation consciente,
// coupe annoncée). Renvoie true si la commande doit s'arrêter (refus émis).
function truncGuard(fields) {
  const over = backlog.overflowFields(fields);
  if (!over.length) return false;
  const detail = over.map((o) => `${o.name} : ${o.length} caractères reçus pour ${o.max} max`).join(' ; ');
  if (!process.argv.includes('--allow-trunc')) {
    out(`Refusé : ${detail} — la valeur serait tronquée en silence au stockage (« … » en pleine phrase).`);
    out('Préfère un résumé court sous le plafond + la spec complète dans un fichier du dépôt, référencé en note.');
    out('Pour accepter sciemment la troncature : ajoute --allow-trunc.');
    return true;
  }
  out(`⚠️ Troncature acceptée (--allow-trunc) : ${detail}.`);
  return false;
}

// Garde de `--depends` PARTAGÉE par `add` et `depends` (dette #98 soldée au lot #100) : `add`
// faisait `.map(Number).filter(Number.isFinite)`, donc `--depends "2,abc"` créait le lot avec
// [2] et jetait « abc » sans un mot — exactement le filtrage silencieux que la commande
// `depends` refuse depuis FIA-24. Une seule garde, un seul message, aucune dérive possible.
// Renvoie { ok:false } après avoir émis le refus, ou { ok:true, ids }.
function parseDepends() {
  const raw = flagList('depends');
  const bad = raw.filter((s) => !Number.isFinite(Number(s)));
  if (bad.length) {
    out(`Refusé : --depends attend des ids de lots — ${bad.map((s) => `« ${s} »`).join(', ')} n'en sont pas. `
      + 'Ex. --depends "2,3" ; pour vider : --depends "".');
    return { ok: false, ids: [] };
  }
  return { ok: true, ids: raw.map(Number) };
}

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
    if (l.us) line += ` [US : ${l.us}]`;
    if (l.perimeter && l.perimeter.length) line += ` [périmètre : ${l.perimeter.join(', ')}]`;
    if (l.depends_on && l.depends_on.length) line += ` [dépend de : ${l.depends_on.map((d) => '#' + d).join(', ')}]`;
    if (l.status === 'done' && l.closed_commit) line += ` — commit ${l.closed_commit}`;
    else if (l.scope) line += ` — ${l.scope}`;
    if (l.status === 'done' && l.closed_verify) line += ` [verify à la clôture : ${l.closed_verify}]`;
    if (l.status === 'done' && Number.isFinite(l.closed_occupancy)) line += ` (occupation à la clôture : ${l.closed_occupancy})`;
    if (Number.isFinite(l.cost_tokens) && l.cost_tokens > 0) line += ` (coût ~${fmtK(l.cost_tokens)} tokens de sortie)`;
    if (l.note) line += ` (note : ${l.note})`;
    // Troncature EN DONNÉE (#90) : show n'abrège rien à l'affichage — un « … » ici signifie
    // que le contenu STOCKÉ est coupé (legacy, ou --allow-trunc). On le rend explicite.
    const cut = [
      ['title', l.title, backlog.MAX_TITLE], ['scope', l.scope, backlog.MAX_SCOPE],
      ['epic', l.epic, backlog.MAX_EPIC], ['verify', l.verify, backlog.MAX_VERIFY],
      ['us', l.us, backlog.MAX_US], ['note', l.note, backlog.MAX_NOTE],
    ].filter(([, v, max]) => v && backlog.isTruncated(v, max)).map(([name]) => name);
    if (cut.length) line += ` [⚠️ tronqué en donnée : ${cut.join(', ')}]`;
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
    // Zone partagée (lot #119) : `test/**` & co. ne comptent plus dans la disjonction — sans quoi
    // la vague se réduisait à un lot. Le dire explicitement : le conflit de merge y est ATTENDU,
    // pas un accident, et c'est la réintégration en pipeline qui l'arbitre.
    const shared = Array.from(new Set(w.flatMap((l) => l.perimeter.filter((g) => perimeter.isShared(g)))));
    if (w.length > 1 && shared.length) {
      out(`Zone partagée entre ces lots (hors test de disjonction) : ${shared.join(', ')} — chaque lot y AJOUTE ses cas.`);
      out('Un conflit de merge y est normal : la réintégration en pipeline l\'annule et nomme le lot coupable.');
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
// Gates (lot #97) : `--gate <cmd>` = gate de REPLI pour les lots sans verify ; `--allow-no-gate` =
// merge assumé sans filet (refus explicite sinon) ; `--final-gate <cmd>` = gate FINAL de vague
// dédié (à défaut : union des verify de la vague, dédoublonnée de la dernière déjà passée verte).
function reintegrate(root, json, execute, into, gates) {
  const g = gates || {};
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
        no_gate: reint.noGateSteps(plan, g.gate),
        wave_gate: reint.waveGateCommands(fleet, b),
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
        const gate = s.verify || g.gate || null;
        out(`${i + 1}. #${s.id} « ${s.title || '?'} »${dep} — branche \`${s.branch || '?'}\` — gate : ${gate || '⚠️ (aucune)'}`);
      });
      // FIA-16 : un lot sans gate est mergé sans filet ; si ce merge casse le build, c'est le gate
      // du lot SUIVANT qui rougit et le pipeline nomme le mauvais coupable.
      const ng = reint.noGateSteps(plan, g.gate);
      if (ng.length) {
        out('');
        out(`⚠️ ${ng.length} lot(s) sans gate (${ng.map((x) => '#' + x.id).join(', ')}) : mergé(s) sans aucune vérification.`);
        out('Le --execute REFUSERA tant que tu n\'auras pas tranché : --gate "<cmd>" (gate de repli) ou --allow-no-gate (merge assumé sans filet).');
      }
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
    const wg = reint.waveGateCommands(fleet, b);
    out(wg.length
      ? `Gate FINAL de vague (après le dernier merge, sur la branche d'intégration) : ${wg.join(' && ')} — ou --final-gate "<cmd>" pour une commande dédiée (typecheck + tests + build).`
      : 'Gate FINAL de vague : aucun lot ne porte de verify — la vague se clôturerait sans preuve (pose --final-gate "<cmd>").');
    return;
  }

  // --execute : exécution réelle du pipeline.
  const res = reint.runPipeline(root, { into, gate: g.gate, allowNoGate: g.allowNoGate, finalGate: g.finalGate });
  // FIA-22 : rapport persisté AVANT toute sortie, donc valable pour TOUS les chemins de retour
  // (conflit, gate rouge, succès). Écrit seulement si quelque chose a réellement été tenté —
  // un refus (nothing-ready, no-gate) n'a aucun diagnostic à conserver.
  const report = (res.merged && res.merged.length) || res.finalGate
    ? reint.writeReintegrateReport(root, res, { waveId: fleet.wave_id })
    : null;
  const reportLine = report ? `Rapport complet (plan, sorties de gates, bloc changelog) : ${report}` : null;
  if (json) {
    return out(JSON.stringify({ executed: true, report, ...res }, null, 2));
  }
  if (res.reason === 'no-integration-branch') return out('Refusé : aucune branche d\'intégration (ni fleet.integration_branch, ni --into, ni branche courante).');
  if (res.reason === 'nothing-ready') return out('Rien à réintégrer : aucun lot « prêt à merger ».');
  if (res.reason === 'checkout-failed') return out(`Refusé : checkout de \`${res.integrationBranch}\` impossible (arbre sale ?).\n${(res.out || '').trim()}`);
  if (res.reason === 'no-gate') {
    out(`Refusé : ${res.noGate.length} lot(s) sans gate (${res.noGate.map((x) => '#' + x.id).join(', ')}) — rien n'a été mergé.`);
    out('Un merge non vérifié fait rougir le gate du lot SUIVANT et nomme le mauvais coupable.');
    return out('Tranche : --gate "<cmd>" (gate de repli pour ces lots) ou --allow-no-gate (merge assumé sans filet).');
  }

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
    // La sortie brute du conflit/gate rouge n'est PAS affichée ici (elle noierait le message) :
    // elle est intégralement dans le rapport persisté, référencé par chemin.
    out(`⛔ Vague NON close : corrige le lot #${res.culprit.id}, remets-le « prêt », puis relance --execute.`);
    if (reportLine) out(reportLine);
    return;
  }
  out('');
  out(reint.aggregateChangelog(res.merged, { waveId: fleet.wave_id, date: dateOf(), integrationBranch: res.integrationBranch }));
  out('');
  // Gate FINAL de vague (lot #97) : deux lots verts séparément peuvent être rouges combinés.
  const fg = res.finalGate;
  if (fg) {
    if (fg.ran && fg.ok) out(`✅ Gate final de vague vert sur \`${res.integrationBranch}\` : ${fg.commands.join(' && ')}.`);
    else if (fg.ran) out(`❌ Gate final de vague ROUGE : \`${fg.failed}\`.\n${(fg.out || '').trim().slice(-1500)}`);
    else if (fg.reason === 'already-green') out('✅ Gate final de vague : déjà couvert (le gate du dernier lot a tourné vert sur l\'état final).');
    else out('⚠️ Gate final de vague : AUCUN lot de la vague ne porte de verify — vague close sans preuve (pose --final-gate "<cmd>").');
    out('');
  }
  if (res.reason === 'final-gate-failed') {
    out('⛔ Vague NON close : les merges restent faits (aucun rollback automatique), la branche d\'intégration est rouge. Corrige sur place, puis relance --execute (ou --final-gate) pour reclôturer.');
    if (reportLine) out(reportLine);
    return;
  }
  out(res.waveClosed
    ? '🎉 Vague entièrement réintégrée et close. Colle le bloc ci-dessus dans CHANGELOG.md, puis commit.'
    : 'Lots prêts réintégrés. La vague reste ouverte (des lots sont encore en vol).');
  // Rangement de fin de vague (FIA-19/FIA-20) : annoncé, jamais silencieux — l'orchestrateur
  // doit savoir que fleet.json est vidé (la vague redevient inerte) et que les handoffs de lot
  // ont disparu. Le snapshot de la vague reste dans le rapport.
  if (res.waveClosed && (res.wavePurged || res.handoffsPurged)) {
    out(`Rangement : fleet.json vidé (vague inerte)${res.handoffsPurged ? `, ${res.handoffsPurged} handoff(s) de lot purgé(s)` : ''}.`);
  }
  if (reportLine) out(reportLine);
}

// FIA-21 (lot #99) : canal d'écriture OUTILLÉ du registre de vague. Jusqu'ici, s'inscrire dans
// fleet.json et passer un lot « prêt » se faisaient à la main dans le JSON : une faute de frappe
// et loadFleet (fail-open, contrat hooks) désactive TOUTE la vague en silence — garde de
// périmètre ET injection de périmètre éteintes, sans un mot. Ici on est dans une COMMANDE, pas
// un hook : les refus sont explicites (toujours exit 0, cf. en-tête).
function fleetCmd(root, sub, json) {
  const fleetLib = require('../lib/fleet');
  const fs = require('fs');
  const file = fleetLib.fleetFile(root);
  const rel = '.vibe-agent/fleet.json';

  // Diagnostic du fichier AVANT tout loadFleet : readJson quarantine un JSON invalide
  // (rename en .corrupt) dès la première lecture — après, on ne saurait plus distinguer
  // « absent » de « corrompu », que loadFleet confond de toute façon (les deux → vague inerte).
  function diagnose() {
    if (!fs.existsSync(file)) {
      const quarantined = fs.existsSync(`${file}.corrupt`);
      return { state: 'absent', quarantined };
    }
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!v || typeof v !== 'object') return { state: 'invalid', why: 'racine JSON non-objet' };
      return { state: 'ok' };
    } catch (e) {
      return { state: 'invalid', why: String((e && e.message) || 'JSON invalide') };
    }
  }

  if (sub === 'show' || !sub) {
    const d = diagnose();
    if (d.state === 'invalid') {
      if (json) return out(JSON.stringify({ active: false, diagnostic: 'invalid', why: d.why }, null, 2));
      out(`⚠️ Vague DÉSACTIVÉE : ${rel} existe mais son JSON est illisible (${d.why}).`);
      out('Les hooks échouent en silence (contrat fail-open) : garde de périmètre ET injection de vague sont éteintes SANS avertissement.');
      return out('Répare le fichier à la main, ou supprime-le et réinscris les lots avec `fleet join`.');
    }
    if (d.state === 'absent') {
      if (json) return out(JSON.stringify({ active: false, diagnostic: d.quarantined ? 'quarantined' : 'absent' }, null, 2));
      if (d.quarantined) out(`⚠️ ${rel} absent mais ${rel}.corrupt présent : un fleet corrompu a été mis en quarantaine — la vague est éteinte.`);
      return out('Aucune vague active (pas de fleet.json). Les sessions sont autonomes.');
    }
    const f = fleetLib.loadFleet(root);
    if (json) return out(JSON.stringify(f, null, 2));
    if (!f.active) return out(`Vague inerte : ${rel} présent mais aucun lot en vol (vague close ou purgée).`);
    out(`Vague${f.wave_id ? ` « ${f.wave_id} »` : ''} : ${f.lots.length} lot(s).`);
    if (f.integration_branch || f.integration_head) {
      out(`Tête d'intégration : ${f.integration_branch || '?'}${f.integration_head ? `@${String(f.integration_head).slice(0, 7)}` : ''}.`);
    }
    for (const l of f.lots) {
      const per = l.perimeter.length ? ` — périmètre : ${l.perimeter.join(', ')}` : ' — ⚠️ AUCUN périmètre (écritures non bridées)';
      const ext = l.ext_requests.length ? ` — demandes hors zone : ${l.ext_requests.join(', ')}` : '';
      out(`- #${l.id}${l.title ? ` « ${l.title} »` : ''} [${l.state}] — session ${l.session_owner} — branche \`${l.branch || '?'}\`${per}${ext}`);
    }
    return;
  }

  // Number(null) vaut 0 (fini !) : tester la PRÉSENCE du flag avant sa finitude, sinon un
  // `fleet ready` sans --id irait chercher un lot #0 fantôme.
  const rawId = flag('id');
  const idn = Number(rawId);
  if (rawId == null || String(rawId).trim() === '' || !Number.isFinite(idn)) {
    return out('Refusé : --id manquant ou non numérique. Ex. `fleet join --id 42 --perimeter "src/a/**"`.');
  }
  const d = diagnose();
  if (d.state === 'invalid') {
    return out(`Refusé : ${rel} est illisible (${d.why}) — l'écrire par-dessus perdrait les autres lots de la vague. Répare-le (ou supprime-le) d'abord, puis relance.`);
  }

  if (sub === 'join') {
    // Une entrée sans session_owner est rejetée par normalizeLot : le refus doit être explicite
    // ici, pas un no-op silencieux. Repli sur l'id de session persisté (session-state.json),
    // que l'assistant n'a aucun moyen de connaître autrement.
    //
    // Dette #99 soldée (lot #100) : ce repli n'est fiable QU'APRÈS le premier SessionStart de la
    // session courante — avant, session-state.json porte encore l'id de la session PRÉCÉDENTE
    // (c'est même sa raison d'être, cf. lib/state.js:previousSessionId). Inscrire un lot au nom
    // d'une session morte est silencieusement catastrophique : la garde de périmètre ne bride
    // personne et l'injection de vague n'arrive jamais. Deux parades, sans jamais bloquer le cas
    // nominal : (1) si l'id déduit tient DÉJÀ un autre lot en vol, c'est le symptôme direct du
    // mauvais propriétaire — on refuse et on exige --session ; (2) sinon on annonce la déduction
    // au lieu de la taire, pour qu'une attribution fausse soit rattrapable.
    const explicitSession = flag('session');
    const session = explicitSession || previousSessionId(root);
    if (!session) {
      return out('Refusé : --session manquante et aucun id de session persisté dans .vibe-agent/session-state.json. '
        + 'Sans propriétaire, le lot ne peut être attribué à personne (ni garde de périmètre, ni injection).');
    }
    if (!explicitSession) {
      const held = fleetLib.lotForSession(root, session);
      if (held && held.id !== idn) {
        return out(`Refusé : --session absente, et l'id déduit de .vibe-agent/session-state.json (${session}) tient déjà le lot #${held.id}. `
          + 'Une session ne tient qu\'un lot par vague : soit ce fichier porte encore l\'id de la session précédente '
          + `(il n'est à jour qu'après le 1er SessionStart), soit l'inscription est en double. Relance avec \`--session <id réel>\`.`);
      }
    }
    const state = flag('state') || 'in_flight';
    if (!fleetLib.STATES.includes(state)) {
      return out(`Refusé : --state invalide (« ${state} »). Valeurs acceptées : ${fleetLib.STATES.join(' | ')}.`);
    }
    const perimeter = flagList('perimeter');
    const fields = [
      { name: '--session', value: session, max: fleetLib.MAX_STR },
      { name: '--branch', value: flag('branch'), max: fleetLib.MAX_STR },
      { name: '--title', value: flag('title'), max: fleetLib.MAX_STR },
    ].concat(perimeter.map((p, i) => ({ name: `--perimeter[${i + 1}]`, value: p, max: fleetLib.MAX_STR })));
    if (truncGuard(fields)) return;

    const b = backlog.loadBacklog(root);
    const known = b.lots.find((x) => x.id === idn);
    const okw = fleetLib.upsertLot(root, {
      id: idn,
      session_owner: session,
      branch: flag('branch') || (known ? backlog.waveBranch(known) : null),
      perimeter,
      state,
      title: flag('title') || (known ? known.title : null),
    });
    if (!okw) return out(`Refusé : inscription du lot #${idn} impossible (écriture de ${rel} en échec).`);
    const warn = known ? '' : ` ⚠️ Aucun lot #${idn} au plan (backlog.json) — vérifie l'id.`;
    const noPer = perimeter.length ? '' : ' ⚠️ Sans --perimeter, la garde d\'écriture ne bride RIEN pour cette session.';
    const deduced = explicitSession ? '' : ' ⚠️ Session DÉDUITE de .vibe-agent/session-state.json (à jour seulement après le 1er SessionStart)'
      + ' — si ce n\'est pas la tienne, refais l\'inscription avec `--session <id réel>`.';
    out(`Lot #${idn} inscrit dans la vague (session ${session}, état ${state}).${warn}${noPer}${deduced}`);
    return;
  }

  if (sub === 'ready') {
    if (!fleetLib.setLotState(root, idn, 'ready')) {
      return out(`Refusé : lot #${idn} absent du registre de vague (inscris-le d'abord : \`fleet join --id ${idn}\`).`);
    }
    return out(`Lot #${idn} passé « prêt à merger ». L'orchestrateur peut le réintégrer (\`reintegrate --execute\`).`);
  }

  // Dette #99 soldée (lot #100) : `join` n'avait pas de réciproque. Une fille inscrite à tort
  // (mauvais id, mauvaise session, vague abandonnée) ne pouvait se désinscrire qu'en éditant
  // fleet.json à la main — hors gardes — ou en subissant une réintégration qu'elle ne voulait
  // pas. `leave` retire l'entrée ET son handoff de lot (sinon il traîne en orphelin jusqu'à la
  // clôture d'une vague, cf. purgeLotHandoffs). Ne touche PAS au backlog : quitter la vague
  // n'abandonne pas le lot, il redevient simplement un lot de session autonome.
  if (sub === 'leave') {
    if (d.state === 'absent') return out('Refusé : aucune vague active (pas de fleet.json) — rien à quitter.');
    const before = fleetLib.loadFleet(root).lots.find((l) => l.id === idn);
    if (!fleetLib.removeLot(root, idn)) {
      return out(`Refusé : lot #${idn} absent du registre de vague (rien à désinscrire).`);
    }
    let purged = 0;
    try { purged = require('../lib/handoff').purgeLotHandoffs(root, [idn]); } catch (_) { /* best-effort */ }
    const wasReady = before && before.state === 'ready';
    const rest = fleetLib.loadFleet(root);
    out(`Lot #${idn} retiré de la vague${purged ? ` (handoff de lot purgé)` : ''}. `
      + 'La session redevient autonome : plus de garde de périmètre, plus d\'injection de vague.');
    if (wasReady) out('⚠️ Ce lot était « prêt à merger » : il sort du plan de réintégration — sa branche ne sera plus mergée automatiquement.');
    if (!rest.active) out(`Plus aucun lot en vol : la vague est inerte (${rel} vidé de ses lots).`);
    return;
  }

  return out(`Sous-commande fleet inconnue : ${sub}. Sous-commandes : join | ready | leave | show.`);
}

function main() {
  const root = gitRoot(parseCwd());
  if (!root) return out('Pas un dépôt git — backlog indisponible.');
  const cmd = (process.argv[2] || '').startsWith('--') ? 'show' : (process.argv[2] || 'show');
  // Garde anti-troncature (#88) : un flag mono-valeur non quoté (« --title fait quand : X »)
  // ne capte que le 1er token ; les tokens nus suivants seraient jetés en silence.
  // On les repère et on rejette explicitement plutôt que de tronquer sans le dire.
  // Dispatch à DEUX tokens pour `fleet <sub>` (seul verbe à sous-commandes) : le sous-verbe
  // n'est pas un argument orphelin, il décale le début du balayage argv d'un cran.
  const rawSub = process.argv[3] || '';
  const sub = cmd === 'fleet' && rawSub && !rawSub.startsWith('--') ? rawSub : null;
  const argStart = (process.argv[2] || '').startsWith('--') ? 2 : (sub ? 4 : 3);
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
    // Poser un epic = acte de CONCEPTION (/pmz:scope étape 3, lot #130) : la session courante
    // sera titrée « [XXX · Plan] <epic> » par la suivante. Best-effort, jamais bloquant.
    if (okw) { try { markPlanSession(root); } catch (_) { /* fail-open */ } }
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
    if (truncGuard([
      { name: '--title', value: flag('title'), max: backlog.MAX_TITLE },
      { name: '--scope', value: flag('scope'), max: backlog.MAX_SCOPE },
      { name: '--model', value: model, max: backlog.MAX_MODEL_HINT },
      { name: '--epic', value: flag('epic'), max: backlog.MAX_EPIC },
      { name: '--verify', value: flag('verify'), max: backlog.MAX_VERIFY },
      { name: '--us', value: flag('us'), max: backlog.MAX_US },
    ])) return;
    const dep = parseDepends();
    if (!dep.ok) return;
    // Garde d'existence (fait quand du lot « Pointeur US vérifié ») : un chemin --us qui ne
    // pointe vers rien est REFUSÉ, jamais avalé — un pointeur mort serait pire qu'aucune US.
    // addLot revalide en interne (défense en profondeur) ; on refuse ici en premier pour un
    // message explicite, distinct du refus générique --title/plafond ci-dessous.
    const usPath = flag('us');
    if (usPath && !fs.existsSync(path.join(root, usPath))) {
      return out(`Refusé : --us pointe vers un chemin inexistant (« ${usPath} », relatif à la racine du dépôt « ${root} »). `
        + 'Crée le fichier d\'abord (cf. templates/us-template.md), ou omets --us si l\'US n\'est pas encore rédigée.');
    }
    const newLot = backlog.addLot(root, flag('title'), flag('scope'), model, flag('epic'), flag('verify'), effort, flagList('perimeter'), dep.ids, usPath);
    if (!newLot) {
      const b = backlog.loadBacklog(root);
      if (b.lots.filter((l) => l.status === 'todo' || l.status === 'in_progress').length >= backlog.MAX_LOTS_OPEN) {
        return out(`Refusé : ${backlog.MAX_LOTS_OPEN} lots ouverts au plafond — un backlog n'est pas un Jira. Clore ou abandonner d'abord.`);
      }
      return out('Refusé : --title manquant ou vide.');
    }
    // NOTE (lot #130) : `add` ne marque PAS la session comme session de plan, même avec --epic.
    // Se poser un lot avant de le traiter est le geste ORDINAIRE d'une session de travail (et le
    // marquer « Plan » la décrivait à faux) ; l'acte de conception tracé est `epic --set`, que
    // /pmz:scope exécute pour le plan qu'il découpe.
    let addMsg =`Lot #${newLot.id} « ${newLot.title} » ajouté (à faire)${backlog.modelEffortTag(newLot)}${newLot.epic ? ` [epic : ${newLot.epic}]` : ''}${newLot.verify ? ` [verify : ${newLot.verify}]` : ''}${newLot.us ? ` [US : ${newLot.us}]` : ''}${newLot.perimeter.length ? ` [périmètre : ${newLot.perimeter.join(', ')}]` : ''}${newLot.depends_on.length ? ` [dépend de : ${newLot.depends_on.map((d) => '#' + d).join(', ')}]` : ''}.`;
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
    if (truncGuard([{ name: '--set', value: set, max: backlog.MAX_VERIFY }])) return;
    const l = backlog.setVerify(root, id, set);
    return out(l ? `Verify du lot #${l.id} enregistrée : ${l.verify}` : `Lot #${id} introuvable ou commande vide.`);
  }

  // Lot #106 : le champ `us` (lot #101) n'avait qu'une porte d'entrée, `add --us`, et supposait
  // l'US déjà rédigée. Trois régimes ici, sur le modèle de `verify` :
  //  - sans flag : LECTURE du pointeur (coût zéro, pas d'ouverture du fichier) ;
  //  - --new : pose docs/us/US-<id>.md depuis le gabarit ET rattache le pointeur ;
  //  - --set <chemin> : rattache une US déjà écrite ailleurs (issue du refus doux « existe déjà »).
  if (cmd === 'us') {
    const b = backlog.loadBacklog(root);
    const cur = b.lots.find((x) => x.id === Number(id));
    if (!cur) return out(`Lot #${id} introuvable.`);
    const set = flag('set');
    const wantNew = process.argv.includes('--new');
    if (wantNew && set) {
      return out('Refusé : --new et --set s\'excluent (générer un gabarit ou rattacher un fichier existant, pas les deux).');
    }
    if (set) {
      if (truncGuard([{ name: '--set', value: set, max: backlog.MAX_US }])) return;
      if (!fs.existsSync(path.join(root, set))) {
        return out(`Refusé : --set pointe vers un chemin inexistant (« ${set} », relatif à « ${root} »). `
          + `Un pointeur mort est pire qu'aucune US — écris le fichier d'abord, ou pose le gabarit avec \`us --id ${cur.id} --new\`.`);
      }
      const l = backlog.setUs(root, id, set);
      if (!l) return out(`Refusé : le lot #${cur.id} est ${LABELS[cur.status]} — son pointeur US n'est plus modifiable.`);
      return out(`US du lot #${l.id} rattachée : ${l.us}`);
    }
    if (!wantNew) {
      return out(`US du lot #${cur.id} : ${cur.us || '(aucune)'}${cur.us ? '' : ` — poser le gabarit : \`us --id ${cur.id} --new\``}`);
    }
    const res = backlog.createUsFile(root, id);
    if (res.ok) {
      out(`US du lot #${res.lot.id} créée : ${res.rel} (gabarit posé, pointeur rattaché).`);
      return out('À remplir à la main : récit, critères d\'acceptation vérifiables, hors périmètre. Le backlog ne porte QUE le chemin.');
    }
    if (res.reason === 'exists') {
      const already = cur.us === res.rel;
      out(`Refusé : ${res.rel} existe déjà — cette commande génère un gabarit, elle n'écrase jamais une US rédigée.`);
      return out(already ? 'Ce fichier est déjà le pointeur US du lot : rien à faire, édite-le directement.'
        : `${cur.us ? `Le lot pointe vers « ${cur.us} »` : 'Le lot ne pointe vers aucune US'} — pour rattacher ce fichier : \`us --id ${cur.id} --set ${res.rel}\`.`);
    }
    if (res.reason === 'closed') {
      return out(`Refusé : le lot #${cur.id} est ${LABELS[cur.status]} — une US écrite après la clôture ne gouverne plus rien.`);
    }
    if (res.reason === 'template') {
      return out(`Refusé : gabarit d'US illisible (attendu : ${PMZ_BASE}/templates/us-template.md). Réinstalle Promptimizer.`);
    }
    return out(`Refusé : écriture impossible sous ${res.rel} (droits ? dépôt en lecture seule ?).`);
  }

  // FIA-24 (lot #98) : `setDepends` existait sans chemin CLI — corriger une dépendance après
  // création (ajout, retrait, faute de frappe d'id) imposait d'éditer backlog.json à la main,
  // hors des gardes que le reste du CLI applique. Sans --depends : LECTURE. Avec --depends "" :
  // vidage explicite (flagList filtre les vides — d'où le test de présence sur argv, pas sur la
  // liste). Remplacement intégral, comme setDepends côté lib.
  if (cmd === 'depends') {
    const b = backlog.loadBacklog(root);
    const cur = b.lots.find((x) => x.id === Number(id));
    if (!cur) return out(`Lot #${id} introuvable.`);
    const fmt = (ds) => (ds.length ? ds.map((d) => '#' + d).join(', ') : '(aucune)');
    if (!process.argv.includes('--depends')) {
      return out(`Dépendances du lot #${cur.id} : ${fmt(cur.depends_on)}`);
    }
    const dep = parseDepends();
    if (!dep.ok) return;
    const lot = backlog.setDepends(root, id, dep.ids);
    if (!lot) return out(`Refusé : le lot #${cur.id} est ${LABELS[cur.status]} — ses dépendances ne sont plus modifiables.`);
    // Ids ne correspondant à aucun lot : AVERTIS, pas refusés — `blockedByOf`/`planWaves` les
    // traitent comme satisfaits (tolérance hors-plan volontaire), mais c'est le symptôme n°1
    // de la faute de frappe que cette commande sert justement à corriger.
    const unknown = lot.depends_on.filter((d) => !b.lots.some((x) => x.id === d));
    const warn = unknown.length ? ` ⚠️ Aucun lot ne porte ${unknown.map((d) => '#' + d).join(', ')} (dépendance ignorée au calcul de vagues).` : '';
    return out(`Dépendances du lot #${lot.id} : ${fmt(lot.depends_on)}.${warn}`);
  }

  // FIA-25 (lot #98) : soupape de réouverture d'un lot clos (scope insuffisant découvert après
  // coup, régression). --note obligatoire : la réouverture EFFACE la trace de clôture.
  if (cmd === 'reopen') {
    if (truncGuard([{ name: '--note', value: flag('note'), max: backlog.MAX_NOTE }])) return;
    const note = flag('note');
    const b = backlog.loadBacklog(root);
    const cur = b.lots.find((x) => x.id === Number(id));
    if (!cur) return out(`Lot #${id} introuvable.`);
    if (cur.status === 'dropped') {
      return out(`Refusé : le lot #${cur.id} est abandonné, pas clos — un lot dropped se re-crée (add), il ne se rouvre pas.`);
    }
    if (cur.status !== 'done') return out(`Refusé : le lot #${cur.id} est déjà ouvert (${LABELS[cur.status]}).`);
    if (!note) {
      return out('Refusé : --note manquante. Une réouverture efface la trace de clôture (commit, verdict verify, '
        + 'session, occupation) — elle doit dire pourquoi. Ex. --note "régression détectée sur X".');
    }
    const lot = backlog.reopenLot(root, id, note);
    if (!lot) return out(`Lot #${id} : échec d'écriture, rien n'a été modifié.`);
    const n = (lot.reopened || []).length;
    return out(`Lot #${lot.id} « ${lot.title} » rouvert (à faire)${backlog.modelEffortTag(lot)} — clôture effacée`
      + `, réouverture n°${n} tracée. Démarre-le avec : backlog.js start --id ${lot.id}`);
  }

  if (cmd === 'start') {
    const lot = backlog.startLot(root, id, flag('owner'));
    if (!lot) return out(`Lot #${id} introuvable ou déjà clos/abandonné.`);
    let startMsg = `Lot #${lot.id} « ${lot.title} » démarré (en cours)${backlog.modelEffortTag(lot)}${lot.session_owner ? ` [session : ${lot.session_owner}]` : ''}.`;
    startMsg += estimateSuffix(backlog.loadBacklog(root), lot);
    return out(startMsg);
  }

  if (cmd === 'done') {
    // Structure de l'US (lot #107) : une US aux sections obligatoires manquantes n'a pas la
    // valeur de contrat qu'elle prétend avoir. Refus DOUX (message actionnable, pas de fail-hard
    // ni de blocage de session) — --allow-incomplete-us débloque un lot clos malgré tout.
    const preUs = backlog.loadBacklog(root).lots.find((x) => x.id === Number(id));
    if (preUs && preUs.us && !process.argv.includes('--allow-incomplete-us')) {
      const struct = backlog.checkUsStructure(root, preUs.us);
      if (struct && struct.missing.length) {
        return out(`Refusé : l'US du lot #${preUs.id} (${preUs.us}) n'a pas toutes ses sections obligatoires — `
          + `manque : ${struct.missing.join(', ')}. Complète le fichier, ou clos quand même avec --allow-incomplete-us.`);
      }
    }
    // Auto-remplissage session/occupancy (lot #96, DEP-6) : la clôture CLI est le chemin
    // RECOMMANDÉ (/close-batch) mais laissait ces deux champs à null faute de --session/
    // --occupancy jamais tapés. On lit l'état déjà posé PAR LA SESSION COURANTE plutôt que de
    // faire saisir une valeur à l'assistant (halluciner un id fausserait suggestedTitle,
    // lib/backlog.js). --no-session/--no-occupancy pour l'opt-out ; --session/--occupancy
    // pour une valeur explicite (occupancy coercée en Number, un argv est toujours une string).
    const sessionId = process.argv.includes('--no-session')
      ? null
      : (flag('session') || previousSessionId(root));
    let occupancy = null;
    if (!process.argv.includes('--no-occupancy')) {
      const occFlag = flag('occupancy');
      if (occFlag != null) occupancy = Number(occFlag);
      else {
        const cl = loadContextLedger(root);
        occupancy = cl.occupancy && Number.isFinite(cl.occupancy.last) ? cl.occupancy.last : null;
      }
    }
    // Verdict de vérification (lot #119) : jusqu'ici SEULE l'auto-clôture du hook Stop savait
    // écrire closed_verify — la clôture CLI, qui est le chemin RECOMMANDÉ (/close-batch), laissait
    // le champ à null. Résultat : les lots clos proprement étaient ceux SANS preuve persistée,
    // exactement l'inverse de l'intention (cf. #96). Deux chemins, aucun ne devine :
    //   - `--verify-verdict <ok|failed|timeout|none>` : verdict DÉJÀ obtenu (c'est ce que
    //     /close-batch injecte : il vient d'exécuter le verify, le relancer ici serait payer
    //     deux fois la même preuve) ;
    //   - à défaut, on exécute la commande `verify` du lot ici même (délai large résolu par
    //     projet, `resolveVerifyCloseMs` — même budget que /close-batch : ce n'est pas un hook).
    //     `--no-verify` coupe l'exécution — le champ reste alors null, comme avant, jamais un
    //     verdict inventé.
    // Non bloquant par choix : en CLI la clôture est un acte délibéré (le refus doux sur ÉCHEC est
    // déjà porté par /close-batch). Un verdict rouge est PERSISTÉ et ANNONCÉ, pas escamoté.
    const verdictFlag = flag('verify-verdict');
    const preDone = backlog.loadBacklog(root).lots.find((x) => x.id === Number(id));
    let verdict = null;
    let verifyTail = '';
    if (verdictFlag) {
      if (!backlog.CLOSED_VERIFY_VALUES.includes(verdictFlag)) {
        return out(`Refusé : --verify-verdict invalide (« ${verdictFlag} »). Valeurs acceptées : ${backlog.CLOSED_VERIFY_VALUES.join(' | ')}.`);
      }
      verdict = verdictFlag;
    } else if (preDone && preDone.status !== 'done' && !process.argv.includes('--no-verify')) {
      if (!preDone.verify) verdict = 'none';
      else {
        const v = runVerify(root, preDone.verify, resolveVerifyCloseMs(root));
        verdict = v.ok ? 'ok' : (v.timedOut ? 'timeout' : 'failed');
        if (verdict === 'failed') verifyTail = v.tail ? `\n  ${v.tail}` : '';
      }
    }
    const lot = backlog.doneLot(root, id, flag('commit'), null, sessionId, occupancy);
    if (!lot) return out(`Lot #${id} introuvable.`);
    const posted = verdict ? backlog.setClosedVerify(root, lot.id, verdict) : null;
    const proof = posted
      ? ` — verify : ${verdict}${verdict === 'failed' ? ' ⚠️ échec PERSISTÉ (closed_verify), à corriger' : ''}${verdict === 'timeout' ? ' ⚠️ non terminée dans le délai — ce n\'est PAS une preuve de réussite (suite longue ? pose `verify_close_ms` sous `budget:` dans .vibe-agent/rules.yaml)' : ''}`
      : (verdict ? ` — verify : ${verdict} (verdict non persisté : déjà posé)` : '');
    return out(`Lot #${lot.id} « ${lot.title} » clos${lot.closed_commit ? ` (commit ${lot.closed_commit})` : ''}.${proof}${verifyTail}`);
  }

  if (cmd === 'drop') {
    if (truncGuard([{ name: '--note', value: flag('note'), max: backlog.MAX_NOTE }])) return;
    const lot = backlog.dropLot(root, id, flag('note'));
    return out(lot ? `Lot #${lot.id} « ${lot.title} » abandonné.`
      : `Lot #${id} introuvable ou déjà fait.`);
  }

  if (cmd === 'note') {
    if (truncGuard([{ name: '--note', value: flag('note'), max: backlog.MAX_NOTE }])) return;
    const lot = backlog.noteLot(root, id, flag('note'));
    return out(lot ? `Note posée sur le lot #${lot.id}.` : `Lot #${id} introuvable ou --note manquante.`);
  }

  if (cmd === 'next') {
    const bn = backlog.loadBacklog(root);
    const lot = backlog.nextLot(bn);
    // blockedBy calculé à la volée, jamais persisté : l'objet JSON sorti est une COPIE enrichie
    // (annoter `lot` le ferait écrire dans backlog.json par un saveBacklog ultérieur).
    const bl = backlog.blockedByOf(bn, lot);
    if (json) return out(JSON.stringify(lot ? Object.assign({}, lot, { blockedBy: bl }) : null));
    if (!lot) return out('Aucun lot à faire.');
    const warn = bl.length ? ` ⚠️ Bloqué par ${bl.map((d) => '#' + d).join(', ')} encore ouvert (tous les lots restants le sont).` : '';
    return out(`Prochain lot : #${lot.id} « ${lot.title} »${backlog.modelEffortTag(lot)}${lot.scope ? ` — ${lot.scope}` : ''}.${warn}`);
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

  if (cmd === 'fleet') return fleetCmd(root, sub, json);

  if (cmd === 'reintegrate') {
    return reintegrate(root, json, process.argv.includes('--execute'), flag('into'), {
      gate: flag('gate'), finalGate: flag('final-gate'), allowNoGate: process.argv.includes('--allow-no-gate'),
    });
  }

  if (cmd === 'reconcile') {
    const r = backlog.reconcile(root);
    if (!r.fixed.length && !r.warnings.length) return out('Rien à réparer.');
    for (const f of r.fixed) out(`Réparé : ${f}`);
    for (const w of r.warnings) out(`Note : ${w}`);
    return;
  }

  out(`Commande inconnue : ${cmd}. Commandes : show | add | start | done | drop | note | reopen | depends | next | parallelize | fleet <join|ready|leave|show> | reintegrate | reconcile | epic | verify | us | trigram | export.`);
}

if (require.main === module) {
  try { main(); } catch (_) { /* fail-open */ }
  process.exit(0);
}
