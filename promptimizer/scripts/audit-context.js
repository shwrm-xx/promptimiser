#!/usr/bin/env node
'use strict';
// Advisory court d'économie de contexte (format spec). S'appuie sur les ledgers + git.
// Le statut est piloté par les TOKENS RÉELS : occupation courante (miroir posé par le
// hook Stop dans context-ledger.json.occupancy) combinée au gaspillage de relecture (B1).
// Fallback annoncé sur le comptage de relectures quand aucune occupation token n'est connue.
const { gitRoot, isInitialized } = require('../lib/project');
const { loadReadLedger, loadContextLedger, WASTE_BUCKETS } = require('../lib/ledger');
const { BUCKETS, stateFileFor } = require('../lib/occupancy');
const { readJson } = require('../lib/fsjson');
const { parseCwd } = require('../lib/cli');
const rtkStatus = require('../lib/rtk-status');
const rtkMetrics = require('../lib/rtk-metrics');
const { rtkStatusLine } = require('../lib/messages');

// Best-effort, jamais bloquant : une panne RTK ne doit jamais faire échouer /pmz:budget.
function rtkLine(root) {
  try {
    return rtkStatusLine(rtkStatus.computeStatus({ root }), rtkMetrics.snapshot());
  } catch (_) {
    return null;
  }
}

// Sparkline (lot #61) : restitue turnstats.turns[] (FIFO 40, écrit à chaque Stop mais
// jamais relu jusqu'ici) sans reparser le transcript — juste le miroir d'état par session.
const SPARK_CHARS = '▁▂▃▄▅▆▇█';
function sparkline(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values.map((v) => SPARK_CHARS[Math.round(((v - min) / range) * (SPARK_CHARS.length - 1))]).join('');
}

// Seuils de statut alignés sur les paliers d'occupation d'occupancy.js (pas d'échelle inventée).
const ORANGE_AT = BUCKETS[1]; // 300k : session substantielle
const ROUGE_AT = BUCKETS[2]; // 500k : envisager sérieusement une session fraîche
// Seuil de gaspillage « significatif » = dernier palier FIXE d'alerte (lot #52) : dès que
// stop.js a crié au franchissement du plus haut palier fixe (100k), /budget lit au moins
// orange — pas de contradiction entre l'alerte de fin de tour et le statut d'audit.
const WASTE_SIGNIFICANT = WASTE_BUCKETS[WASTE_BUCKETS.length - 1]; // 100k

// Statut token : l'occupation courante domine ; le gaspillage de relecture peut
// aggraver d'un cran (beaucoup de relectures inutiles = risque même à occupation modérée).
function tokenStatus(occ, wasteTotal) {
  let statut = 'vert';
  if (occ >= ORANGE_AT) statut = 'orange';
  if (occ >= ROUGE_AT) statut = 'rouge';
  // Gaspillage significatif (≥ dernier palier fixe) pousse d'un cran vers le rouge.
  if (wasteTotal >= WASTE_SIGNIFICANT && statut === 'vert') statut = 'orange';
  if (wasteTotal >= ORANGE_AT && statut === 'orange') statut = 'rouge';
  return statut;
}

function main() {
  const root = gitRoot(parseCwd());
  if (!root || !isInitialized(root)) {
    process.stdout.write('## Économie de contexte\n\nStatut : non applicable (projet non initialisé)\n');
    return;
  }
  const cl = loadContextLedger(root);
  const rl = loadReadLedger(root);
  const fmtK = (t) => `${(t / 1000).toFixed(1)}k`;

  const wasteTotal = cl.estimated_context_waste || 0;
  const wasteEntries = Object.entries(cl.waste_by_file || {})
    .filter(([, t]) => t > 0)
    .sort((a, b) => b[1] - a[1]);

  // Source de vérité du statut : occupation en tokens réels (miroir du hook Stop).
  const occ = cl.occupancy && typeof cl.occupancy.last === 'number' ? cl.occupancy.last : null;
  const delta = cl.occupancy && typeof cl.occupancy.delta_last_turn === 'number'
    ? cl.occupancy.delta_last_turn : null;
  // hitRate cache (lot #58) : miroir posé par recordOccupancy, jamais recalculé ici.
  const hitRate = cl.occupancy && typeof cl.occupancy.hit_rate === 'number' ? cl.occupancy.hit_rate : null;

  let statut;
  let baseLabel;
  if (occ != null) {
    statut = tokenStatus(occ, wasteTotal);
    baseLabel = `≈ ${fmtK(occ)} tokens de contexte`
      + (delta != null ? ` (dernier tour ${delta >= 0 ? '+' : ''}${fmtK(delta)})` : '');
  } else {
    // Fallback annoncé : aucune occupation token connue (jamais passé par un Stop
    // récent, ou hors-git). On retombe sur le comptage de relectures — jamais de
    // chiffre tokens fantôme.
    const reread = (cl.repeated_reads || []).length;
    statut = 'vert';
    if (reread >= 1 && reread <= 2) statut = 'orange';
    if (reread > 2) statut = 'rouge';
    baseLabel = `données tokens absentes — comptage de relectures (${reread})`;
  }

  const avoidable = (rl.avoid_reread_notes || []).slice(0, 20);
  const known = Object.keys(cl.files_read || {}).slice(0, 20);

  const lines = [];
  lines.push('## Économie de contexte');
  lines.push('');
  lines.push(`Statut : ${statut} — ${baseLabel}`);
  if (hitRate != null) lines.push(`Cache hitRate (dernier tour) : ${Math.round(hitRate * 100)}%`);
  const rtk = rtkLine(root);
  if (rtk) lines.push(rtk);

  // Courbe des tours (lot #61) : miroir turnstats.turns[] pour la session courante
  // (cl.session_id, posé par recordOccupancy). Rien à montrer hors session connue.
  const sid = cl.session_id || null;
  const turnsState = sid ? readJson(stateFileFor(sid, 'turns.json'), null) : null;
  const turnsHist = turnsState && Array.isArray(turnsState.turns) ? turnsState.turns : [];
  if (turnsHist.length) {
    const deltas = turnsHist.map((t) => (typeof t.d === 'number' ? t.d : 0));
    const outs = turnsHist.map((t) => (typeof t.o === 'number' ? t.o : 0));
    const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const avgOut = outs.reduce((a, b) => a + b, 0) / outs.length;
    lines.push('');
    lines.push(`Courbe des tours (${turnsHist.length} mesurés) :`);
    lines.push(sparkline(deltas));
    lines.push(`- delta moyen : ${avgDelta >= 0 ? '+' : ''}${fmtK(avgDelta)} / tour · sortie moyenne : ${fmtK(avgOut)} / tour`);
  }
  lines.push('');
  lines.push('Gaspillage estimé :');
  if (wasteEntries.length) {
    lines.push(`- ≈ ${fmtK(wasteTotal)} tokens sur ${wasteEntries.length} fichier(s)`);
    wasteEntries.slice(0, 20).forEach(([f, t]) => lines.push(`  - ${f} ≈ ${fmtK(t)}`));
  } else {
    lines.push('- (aucun détecté)');
  }
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
