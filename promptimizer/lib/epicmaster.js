'use strict';
// Plan de SESSION MAÎTRE (lot #133, epic « Session maître ») — fonctions PURES sauf mention.
//
// Une session maître est une session fraîche qui ne code pas elle-même : elle lance les lots
// ouverts du backlog en SOUS-AGENTS (outil Agent/Task), chacun au modèle + effort préconisés
// par le lot, puis consolide — commits par lot, clôtures, CHANGELOG, et UN handoff final qui
// porte la dette et ce qui reste à trancher. Troisième voie entre la série classique (un lot
// par session) et la vague D3 (N sessions Claude Code réelles + fleet.json) : la validation
// humaine demeure (confirmation de la liste embarquée, tout coché par défaut), le lancement
// est automatisé, sans session fille ni worktree.
//
// Ce module CALCULE et REND ; il ne lance rien, ne démarre aucun lot, n'écrit rien (sauf
// writeMasterHandoff, explicitement nommé). Trois questions, trois réponses :
//   1. QUOI embarquer : lots ouverts (todo + in_progress), filtrables par epic, décochables
//      (--skip) ou restreints (--only) ; regroupés par epic pour la confirmation.
//   2. DANS QUEL ORDRE : vagues « maître » — même règle de disjonction des périmètres que
//      backlog.planWaves (D3), mais un lot SANS périmètre n'est pas « non parallélisable » : il
//      est EXCLUSIF (seul en vol dans sa vague, en série) — un sous-agent sans zone réservée ne
//      peut cohabiter avec personne, mais il peut parfaitement tourner seul. Les dépendances
//      sont honorées par les vagues antérieures ; une dépendance sur un lot ouvert NON embarqué
//      bloque (jamais contournée en silence).
//   3. COMBIEN à la fois : parallélisme borné par un plafond (MAX_PARALLEL_DEFAULT, réglable)
//      ET par le budget de contexte du maître — chaque lot délégué coûte au maître son brief +
//      le rapport du sous-agent + les commandes de clôture (MASTER_COST_PER_LOT, estimation
//      prudente, jamais mesurée ici) ; au-delà de la zone rouge du modèle maître
//      (occupancy.resolveRedZone, qui honore rules.yaml), on COUPE en plusieurs sessions maîtres
//      successives plutôt que de subir l'auto-compact en pleine vague.
// Fail-open : toute entrée malformée donne un plan vide, jamais un throw.
const path = require('path');
const perimeterLib = require('./perimeter');
const occupancy = require('./occupancy');
const { modelEffortTag, estimateCost } = require('./backlog');
const { writeAtomicText } = require('./fsjson');
const { MANUAL_MARKER, MAX_INJECT_CHARS } = require('./handoff');

const MAX_PARALLEL_DEFAULT = 4;  // sous-agents en vol simultanément, sans réglage
const MAX_PARALLEL_CAP = 8;      // borne dure du réglage --max-parallel (au-delà : ignoré)
const MASTER_BASELINE_TOKENS = 60000; // socle d'une session (système, CLAUDE.md, injections, skill)
const MASTER_COST_PER_LOT = 6000;     // brief + rapport (≤ REPORT_MAX_WORDS) + commit/clôture, côté maître
const REPORT_MAX_WORDS = 250;         // plafond du rapport rendu par un sous-agent
const DEFAULT_MASTER_MODEL = 'sonnet';
const DEFAULT_MASTER_EFFORT = 'medium';
const NO_EPIC = '(sans epic)';
const OWNER_PREFIX = 'master/lot-';   // session_owner posé par le maître : distinct par lot, cf. startLot (fleet)
const MAX_HANDOFF_LOT_LINES = 24;     // lignes de lots dans le handoff maître (cap d'injection 6000 chars)

function lotsOf(b) { return (b && Array.isArray(b.lots)) ? b.lots : []; }
function isOpen(l) { return l && (l.status === 'todo' || l.status === 'in_progress'); }
function idList(v) {
  if (v == null) return [];
  const raw = Array.isArray(v) ? v : String(v).split(',');
  return raw.map((s) => Number(String(s).trim())).filter((n) => Number.isFinite(n));
}
function hasPerimeter(l) { return Array.isArray(l.perimeter) && l.perimeter.length > 0; }

// 1. SÉLECTION — lots ouverts, filtre epic, --only / --skip. `excluded` dit pourquoi, par lot.
function selectLots(b, opts) {
  const o = opts || {};
  const only = new Set(idList(o.only));
  const skip = new Set(idList(o.skip));
  const selected = [];
  const excluded = [];
  for (const l of lotsOf(b)) {
    if (!isOpen(l)) continue;
    if (o.epic && l.epic !== o.epic) { excluded.push({ lot: l, reason: `hors epic « ${o.epic} »` }); continue; }
    if (only.size && !only.has(l.id)) { excluded.push({ lot: l, reason: 'hors --only' }); continue; }
    if (skip.has(l.id)) { excluded.push({ lot: l, reason: 'décoché' }); continue; }
    selected.push(l);
  }
  selected.sort((a, c) => a.id - c.id);
  return { selected, excluded };
}

// Regroupe par epic, dans l'ordre de première apparition (id croissant) ; « sans epic » en dernier.
function groupByEpic(lots) {
  const groups = [];
  const byName = new Map();
  for (const l of lots) {
    const name = l.epic || NO_EPIC;
    if (!byName.has(name)) { const g = { epic: name, lots: [] }; byName.set(name, g); groups.push(g); }
    byName.get(name).lots.push(l);
  }
  const noEpic = groups.find((g) => g.epic === NO_EPIC);
  return noEpic ? groups.filter((g) => g !== noEpic).concat([noEpic]) : groups;
}

// 2. VAGUES MAÎTRE. Retour { waves: [[lot…], …], blocked: [{ lot, reason }] }.
function planMasterWaves(b, selected) {
  const all = lotsOf(b);
  const selIds = new Set(selected.map((l) => l.id));
  const openNotSelected = new Set(all.filter((l) => isOpen(l) && !selIds.has(l.id)).map((l) => l.id));
  const placed = new Set(all.filter((l) => l.status === 'done').map((l) => l.id));
  const blocked = [];
  let remaining = selected.filter((l) => {
    const deps = Array.isArray(l.depends_on) ? l.depends_on : [];
    const bad = deps.filter((d) => openNotSelected.has(d));
    if (bad.length) { blocked.push({ lot: l, reason: `dépend de ${bad.map((d) => '#' + d).join(', ')} (ouvert mais non embarqué)` }); return false; }
    return true;
  });
  // Dépendance satisfaite : lot fait, lot embarqué déjà placé, ou référence hors-plan (abandonné /
  // inconnu — tolérée, comme planWaves). Un lot ouvert non embarqué a déjà bloqué ci-dessus.
  const depsOk = (l) => (Array.isArray(l.depends_on) ? l.depends_on : [])
    .every((d) => placed.has(d) || !selIds.has(d));
  const waves = [];
  while (remaining.length) {
    const ready = remaining.filter(depsOk).sort((a, c) => a.id - c.id);
    if (!ready.length) {
      for (const l of remaining) blocked.push({ lot: l, reason: 'dépendance circulaire ou impossible' });
      break;
    }
    // Une vague PARALLÈLE si au moins un lot prêt porte un périmètre ; sinon le premier lot
    // exclusif (sans périmètre) part seul. Un exclusif n'entre jamais dans une vague à plusieurs.
    const withPer = ready.filter(hasPerimeter);
    const wave = [];
    if (withPer.length) {
      for (const l of withPer) {
        if (wave.every((w) => perimeterLib.disjoint(w.perimeter, l.perimeter))) wave.push(l);
      }
    } else {
      wave.push(ready[0]);
    }
    const ids = new Set(wave.map((l) => l.id));
    wave.forEach((l) => placed.add(l.id));
    waves.push(wave);
    remaining = remaining.filter((l) => !ids.has(l.id));
  }
  return { waves, blocked };
}

// Découpe toute vague plus large que `max` en tranches successives (ordre conservé).
function chunkWaves(waves, max) {
  const m = Math.max(1, Math.floor(max));
  const out = [];
  for (const w of waves) for (let i = 0; i < w.length; i += m) out.push(w.slice(i, i + m));
  return out;
}

// Modèle du maître : il arbitre et consolide — `opus` dès qu'un lot embarqué le préconise,
// sinon le modèle majoritaire des lots, sinon DEFAULT_MASTER_MODEL. Effort DEFAULT_MASTER_EFFORT :
// le maître ne raisonne pas sur le code, il orchestre.
function masterModel(lots, override) {
  if (override && String(override).trim()) return String(override).trim().toLowerCase();
  const hints = lots.map((l) => String(l.model_hint || '').toLowerCase()).filter(Boolean);
  if (hints.some((h) => h.includes('opus'))) return 'opus';
  const count = new Map();
  for (const h of hints) count.set(h, (count.get(h) || 0) + 1);
  let best = null;
  for (const [h, n] of count) if (!best || n > best.n) best = { h, n };
  return best ? best.h : DEFAULT_MASTER_MODEL;
}

// 3. BUDGET DE CONTEXTE du maître. `root` sert à lire rules.yaml (borne de projet) ; null → fenêtre.
// La borne retenue est la PLUS BASSE de : zone rouge résolue (rules.yaml ou 85 % de la fenêtre)
// et seuil « session fraîche recommandée » (occupancy.BUCKETS[1] = 300k, même seuil que le verdict
// de /close-batch, lot #109) — sur une fenêtre de 1M la zone rouge seule (850k) ne borne rien
// d'utile : le coût de cache est dissuasif bien avant, et c'est la consommation qu'on surveille.
function contextBudget(root, model, nLots) {
  const red = occupancy.resolveRedZone(root || null, model);
  const fresh = occupancy.BUCKETS[1];
  const bound = red.tokens < fresh ? red : { tokens: fresh, source: 'fresh-session' };
  const usable = Math.max(0, bound.tokens - MASTER_BASELINE_TOKENS);
  const maxLots = Math.max(1, Math.floor(usable / MASTER_COST_PER_LOT));
  return {
    red_zone_tokens: bound.tokens,
    red_zone_source: bound.source,
    baseline_tokens: MASTER_BASELINE_TOKENS,
    per_lot_tokens: MASTER_COST_PER_LOT,
    max_lots_per_session: maxLots,
    sessions_needed: nLots ? Math.ceil(nLots / maxLots) : 0,
  };
}

// Répartit les vagues (déjà tranchées) en sessions maîtres successives de `capacity` lots.
function splitSessions(waves, capacity) {
  const cap = Math.max(1, Math.floor(capacity));
  const sessions = [];
  let cur = [];
  let n = 0;
  for (const w of waves) {
    if (n + w.length > cap && cur.length) { sessions.push(cur); cur = []; n = 0; }
    cur.push(w);
    n += w.length;
  }
  if (cur.length) sessions.push(cur);
  return sessions;
}

function slim(l) {
  return {
    id: l.id, title: l.title, status: l.status, epic: l.epic || null,
    model: l.model_hint || null, effort: l.effort_hint || null, verify: l.verify || null,
    us: l.us || null, perimeter: Array.isArray(l.perimeter) ? l.perimeter : [],
    depends_on: Array.isArray(l.depends_on) ? l.depends_on : [], session_owner: l.session_owner || null,
  };
}

// PLAN COMPLET — l'objet que la CLI rend en --json et que les rendus ci-dessous consomment.
// opts : { epic, only, skip, maxParallel, masterModel, masterEffort }.
function planMaster(root, b, opts) {
  const o = opts || {};
  const sel = selectLots(b, o);
  const mw = planMasterWaves(b, sel.selected);
  const launchable = mw.waves.flat().sort((a, c) => a.id - c.id); // liste de confirmation : ordre d'id
  const model = masterModel(launchable, o.masterModel);
  const effort = (o.masterEffort && String(o.masterEffort).trim()) || DEFAULT_MASTER_EFFORT;
  const budget = contextBudget(root, model, launchable.length);
  let cap = Number(o.maxParallel);
  if (!Number.isFinite(cap) || cap < 1 || cap > MAX_PARALLEL_CAP) cap = MAX_PARALLEL_DEFAULT;
  const maxParallel = Math.max(1, Math.min(cap, budget.max_lots_per_session));
  const waves = chunkWaves(mw.waves, maxParallel);
  const sessions = splitSessions(waves, budget.max_lots_per_session);
  const largest = waves.reduce((m, w) => Math.max(m, w.length), 0);
  return {
    launched: false,
    master: { model, effort },
    lots: launchable.map(slim),
    groups: groupByEpic(launchable).map((g) => ({ epic: g.epic, ids: g.lots.map((l) => l.id) })),
    waves: waves.map((w, i) => ({ index: i + 1, parallel: w.length, ids: w.map((l) => l.id) })),
    blocked: mw.blocked.map((x) => ({ id: x.lot.id, title: x.lot.title, reason: x.reason })),
    excluded: sel.excluded.map((x) => ({ id: x.lot.id, title: x.lot.title, reason: x.reason })),
    parallelism: { max: maxParallel, cap, largest_wave: largest, opportunity: largest >= 2 },
    budget,
    sessions: sessions.map((s) => s.flat().map((l) => l.id)),
    _lotsById: new Map(lotsOf(b).map((l) => [l.id, l])), // interne (rendus) — retiré du JSON par la CLI
  };
}

// Une ligne de confirmation par lot, ALIGNÉE (titre padé) + une ligne de détail indentée :
// la liste se lit en colonne (case · id · titre · modèle · vague), le détail reste disponible.
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function lotLine(l, b, waveOf, checked) {
  const tag = l.model_hint ? `${l.model_hint}${l.effort_hint ? ' · ' + l.effort_hint : ''}` : '?';
  const w = waveOf && waveOf.get(l.id);
  const head = `[${checked === false ? ' ' : 'x'}] ${pad('#' + l.id, 4)} ${pad(String(l.title || '').slice(0, 44), 44)} ${pad(tag, 16)}${w ? ` ← vague ${w.index}${w.parallel > 1 ? '' : ' (série)'}` : ''}`;
  const det = [];
  if (l.verify) det.push(`verify : ${l.verify}`);
  det.push(hasPerimeter(l) ? `périmètre : ${l.perimeter.join(', ')}` : 'sans périmètre → série');
  if (l.depends_on && l.depends_on.length) det.push(`dépend de : ${l.depends_on.map((d) => '#' + d).join(', ')}`);
  if (l.us) det.push(`US : ${l.us}`);
  const est = b ? estimateCost(b, l) : null;
  if (est) det.push(`~${Math.round(est.avg / 1000)}k tokens`);
  if (l.status === 'in_progress') det.push(`⟳ en cours${l.session_owner ? ` (session ${l.session_owner})` : ''} — sera repris`);
  return `${head}\n        ${det.join(' · ')}`;
}

// RENDU LISIBLE du plan : liste de confirmation (tout coché), vagues, parallélisme, budget.
function renderPlan(plan, b, pmzBase) {
  const base = pmzBase || '~/.claude/promptimizer';
  const L = [];
  if (!plan.lots.length) {
    L.push('## Session maître — aucun lot à embarquer (rien n\'est lancé)');
    if (plan.blocked.length) for (const x of plan.blocked) L.push(`⛔ Bloqué : #${x.id} « ${x.title} » — ${x.reason}.`);
    if (plan.excluded.length) L.push(`Exclus : ${plan.excluded.map((x) => `#${x.id} (${x.reason})`).join(', ')}.`);
    return L.join('\n');
  }
  const waveOf = new Map();
  for (const w of plan.waves) for (const id of w.ids) waveOf.set(id, w);
  L.push(`## Session maître — ${plan.lots.length} lot(s) à embarquer (proposition, rien n'est lancé)`);
  L.push('Tous cochés par défaut. Décocher : « sans #id » (ou `epicmaster --skip id,id`).');
  L.push('');
  for (const g of plan.groups) {
    L.push(`### Epic « ${g.epic} » — ${g.ids.length} lot(s)`);
    for (const id of g.ids) L.push(lotLine(plan._lotsById.get(id), b, waveOf));
    L.push('');
  }
  if (plan.blocked.length) {
    for (const x of plan.blocked) L.push(`⛔ Bloqué (non embarqué) : #${x.id} « ${x.title} » — ${x.reason}.`);
    L.push('');
  }
  if (plan.excluded.length) {
    L.push(`Exclus : ${plan.excluded.map((x) => `#${x.id} (${x.reason})`).join(', ')}.`);
    L.push('');
  }
  L.push(`### Ordre de lancement — ${plan.waves.length} vague(s), ${plan.parallelism.max} sous-agent(s) max en vol`);
  for (const w of plan.waves) {
    const ids = w.ids.map((id) => {
      const l = plan._lotsById.get(id);
      return `#${id}${l && l.model_hint ? ` [${l.model_hint}${l.effort_hint ? ' · ' + l.effort_hint : ''}]` : ''}`;
    }).join(', ');
    L.push(`- Vague ${w.index} — ${w.parallel > 1 ? `${w.parallel} en parallèle` : 'série (seul en vol)'} : ${ids}`);
  }
  if (!plan.parallelism.opportunity) L.push('Parallélisation : aucune opportunité — tout part en série (sans périmètre, dépendances en chaîne ou périmètres chevauchants).');
  L.push('');
  const bg = plan.budget;
  const src = { config: 'borne rules.yaml', window: 'zone rouge du modèle', 'fresh-session': 'seuil « session fraîche »' }[bg.red_zone_source] || bg.red_zone_source;
  L.push(`### Session maître — modèle préconisé : ${plan.master.model} · effort ${plan.master.effort}`);
  L.push(`- borne ${Math.round(bg.red_zone_tokens / 1000)}k (${src}) · socle ~${Math.round(bg.baseline_tokens / 1000)}k · ~${Math.round(bg.per_lot_tokens / 1000)}k par lot délégué (brief + rapport ≤ ${REPORT_MAX_WORDS} mots + clôture)`);
  L.push(`- capacité : ${bg.max_lots_per_session} lot(s) par session maître → ${bg.sessions_needed} session(s) pour ${plan.lots.length} lot(s)`);
  if (plan.sessions.length > 1) {
    plan.sessions.forEach((ids, i) => L.push(`  - session ${i + 1} : ${ids.map((id) => '#' + id).join(', ')}`));
    L.push('  Après la dernière vague d\'une session : handoff consolidé, puis session fraîche — `/epicmaster` reprend les lots restés ouverts.');
  }
  L.push('');
  L.push('⚠️ Proposition seule : aucun lot démarré, aucun sous-agent lancé.');
  L.push(`Lancer (après confirmation) : /epicmaster — brief d'un lot : node ${base}/scripts/backlog.js epicmaster --brief --id <id>.`);
  return L.join('\n');
}

// BRIEF D'UN SOUS-AGENT — ce que le maître colle dans le prompt de l'outil Agent. Autonome :
// le sous-agent n'a ni le backlog ni la conversation du maître. Toute règle de contrat tient ici.
function renderBrief(l, b, pmzBase) {
  const base = pmzBase || '~/.claude/promptimizer';
  const L = [];
  L.push(`# Lot #${l.id} « ${l.title} » — brief de sous-agent (session maître Promptimizer)`);
  L.push(`Modèle : ${l.model_hint || '?'} · effort ${l.effort_hint || '?'} — à passer à l'outil Agent (model=${l.model_hint || '?'}${l.effort_hint ? `, effort=${l.effort_hint}` : ''}).`);
  if (l.epic) L.push(`Epic : ${l.epic}`);
  L.push(`Fait quand : ${l.scope || '(non précisé — demande au maître avant de coder)'}`);
  L.push(`Verify (preuve de clôture, à exécuter avant de rendre la main) : ${l.verify || '(aucune — lot non vérifiable par commande)'}`);
  if (l.us) L.push(`US (contrat du lot, à lire en premier) : ${l.us}`);
  L.push(hasPerimeter(l)
    ? `Périmètre EXCLUSIF — n'écris NULLE PART ailleurs (d'autres sous-agents travaillent en parallèle) : ${l.perimeter.join(', ')}`
    : 'Périmètre : aucun — tu es seul en vol, mais reste strictement dans le sujet du lot.');
  if (l.depends_on && l.depends_on.length) {
    const st = l.depends_on.map((d) => { const x = b && lotsOf(b).find((y) => y.id === d); return `#${d}${x ? ` (${x.status === 'done' ? 'clos' : x.status})` : ''}`; });
    L.push(`Dépend de : ${st.join(', ')} — déjà livré(s) dans l'arbre de travail.`);
  }
  const est = b ? estimateCost(b, l) : null;
  if (est) L.push(`Coût attendu : ~${Math.round(est.avg / 1000)}k tokens de sortie (${est.count} lot(s) comparable(s)).`);
  L.push('');
  L.push('Règles :');
  L.push('- Ne commite JAMAIS, ne touche ni à .vibe-agent/ ni à CHANGELOG.md : le maître commite, clôt et consolide.');
  L.push('- Ne lance aucun script Promptimizer (backlog.js, close-batch.js…) : le suivi est tenu par le maître.');
  L.push('- Lecture minimale (git grep, lecture partielle) ; pas de scan large du dépôt.');
  L.push('- Exécute la verify avant de rendre la main ; si elle est rouge, dis-le, ne la contourne pas.');
  L.push(`- Rapport final ≤ ${REPORT_MAX_WORDS} mots, EXACTEMENT ces sections, rien d'autre :`);
  L.push('  Fait / Fichiers modifiés / Verify (verdict ok|failed|none + 5 dernières lignes si rouge) / Non vérifié / Dette / À trancher / Bloc CHANGELOG (3 à 6 puces).');
  L.push('- Interdits dans le rapport : diff, contenu de fichier, listing de code, sortie complète de tests.');
  L.push(`(Référence : node ${base}/scripts/backlog.js show --json pour le maître uniquement.)`);
  return L.join('\n');
}

// Commandes côté maître (texte, rien d'exécuté). `launchCommand` AVANT de lancer le sous-agent :
// démarre le lot avec un owner distinct par lot (sinon startLot, régime classique, rétrograde le
// précédent en « à faire »). `closeCommands` À LA RÉCEPTION du rapport : commit borné au
// périmètre (pathspec `:(glob)` — `**` traverse les dossiers), puis clôture avec verdict persisté.
function launchCommand(l, pmzBase) {
  const base = pmzBase || '~/.claude/promptimizer';
  return `node ${base}/scripts/backlog.js start --id ${l.id} --owner "${OWNER_PREFIX}${l.id}"`;
}
function closeCommands(l, pmzBase) {
  const base = pmzBase || '~/.claude/promptimizer';
  const add = hasPerimeter(l)
    ? `git add -- ${l.perimeter.map((g) => `':(glob)${g}'`).join(' ')}`
    : 'git add -A';
  return [
    `${add} && git commit -m "<type>(<zone>): lot #${l.id} — ${String(l.title || '').slice(0, 60)}"`,
    `node ${base}/scripts/backlog.js done --id ${l.id} --commit "$(git rev-parse --short HEAD)" --verify-verdict <ok|failed|none>`,
  ];
}

// HANDOFF MAÎTRE (manuel, injecté au démarrage de la session fraîche) — court par contrat
// (cap d'injection MAX_INJECT_CHARS) : le plan, le modèle à poser, la prochaine action. Les briefs
// par lot ne sont PAS inclus : ils se régénèrent à la demande (`epicmaster --brief --id`).
function renderMasterHandoff(plan, opts) {
  const o = opts || {};
  const base = o.pmzBase || '~/.claude/promptimizer';
  const L = [];
  L.push(MANUAL_MARKER);
  L.push('## Handoff session fraîche — SESSION MAÎTRE');
  L.push('');
  L.push(`Objectif : lancer ${plan.lots.length} lot(s) ouvert(s)${o.epic ? ` de l'epic « ${o.epic} »` : ''} en sous-agents (modèle + effort préconisés par lot), puis consolider en un handoff dette / à trancher.`);
  L.push(`Modèle à poser pour CETTE session : ${plan.master.model} · effort ${plan.master.effort} (/model ${plan.master.model}).`);
  L.push('');
  L.push(`Plan (${plan.waves.length} vague(s), parallélisme max ${plan.parallelism.max}) :`);
  let shown = 0;
  for (const w of plan.waves) {
    const ids = w.ids.map((id) => { const l = plan._lotsById.get(id); return `#${id}${l && l.model_hint ? ` [${l.model_hint}${l.effort_hint ? '·' + l.effort_hint : ''}]` : ''}`; });
    L.push(`- Vague ${w.index} (${w.parallel > 1 ? `${w.parallel} en parallèle` : 'série'}) : ${ids.join(', ')}`);
    if (++shown >= MAX_HANDOFF_LOT_LINES) { L.push(`- … (${plan.waves.length - shown} vague(s) de plus — \`backlog.js epicmaster\` les affiche)`); break; }
  }
  if (plan.blocked.length) L.push(`Bloqués (non embarqués) : ${plan.blocked.map((x) => `#${x.id} — ${x.reason}`).join(' ; ')}.`);
  L.push('');
  const bg = plan.budget;
  L.push(`Budget contexte : au plus ${bg.max_lots_per_session} lot(s) par session maître (zone rouge ${Math.round(bg.red_zone_tokens / 1000)}k, ~${Math.round(bg.per_lot_tokens / 1000)}k/lot) → ${bg.sessions_needed} session(s) maître.`);
  if (plan.sessions.length > 1) L.push(`Cette session s'arrête après : ${plan.sessions[0].map((id) => '#' + id).join(', ')} ; handoff consolidé, puis session fraîche + /epicmaster pour la suite.`);
  L.push('');
  L.push('Prochaine action recommandée :');
  L.push('- /epicmaster (ou /pmz:epicmaster) — confirme la liste (tout coché), puis lance les vagues.');
  L.push('');
  L.push('Contrainte budget :');
  L.push(`- ne jamais relire la sortie brute d'un sous-agent : rapport ≤ ${REPORT_MAX_WORDS} mots par lot, sections fixes.`);
  L.push('- après chaque vague : commit + `done` par lot, rien de plus en contexte.');
  L.push(`- plan machine : node ${base}/scripts/backlog.js epicmaster --json`);
  let text = L.join('\n') + '\n';
  if (text.length > MAX_INJECT_CHARS) text = text.slice(0, MAX_INJECT_CHARS - 40) + '\n[handoff maître tronqué]\n';
  return text;
}

// Seule fonction qui ÉCRIT : pose le handoff maître dans .vibe-agent/handoff.md (ou le fichier
// donné). Le marqueur manuel le protège de l'écrasement par le handoff auto de fin de tour.
function writeMasterHandoff(root, text, file) {
  const target = file || path.join(root, '.vibe-agent', 'handoff.md');
  try { return writeAtomicText(target, text) ? target : null; } catch (_) { return null; }
}

module.exports = {
  selectLots, groupByEpic, planMasterWaves, chunkWaves, masterModel, contextBudget, splitSessions,
  planMaster, renderPlan, renderBrief, launchCommand, closeCommands, renderMasterHandoff, writeMasterHandoff,
  MAX_PARALLEL_DEFAULT, MAX_PARALLEL_CAP, MASTER_BASELINE_TOKENS, MASTER_COST_PER_LOT,
  REPORT_MAX_WORDS, DEFAULT_MASTER_MODEL, DEFAULT_MASTER_EFFORT, NO_EPIC, OWNER_PREFIX,
};
