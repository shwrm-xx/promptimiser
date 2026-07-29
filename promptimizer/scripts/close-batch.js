#!/usr/bin/env node
'use strict';
// Checklist de clôture (format spec). Pré-rempli via audit-batch quand détectable.
const fs = require('fs');
const path = require('path');
const { compute } = require('./audit-batch');
const handoff = require('../lib/handoff');
const { previousSessionId } = require('../lib/state');
const { modelEffortTag } = require('../lib/backlog');
const { runVerify, git } = require('../lib/project');
const archive = require('../lib/archive');
const { VERIFY_CLOSE_MS } = require('../lib/timeouts');
const { parseCwd } = require('../lib/cli');
const { fmtK } = require('../lib/messages');
const rtkMetrics = require('../lib/rtk-metrics');
const occupancy = require('../lib/occupancy');

// Bloc « Gain RTK » du bilan de clôture (lot #83). Le lot n'est pas encore clos ici → on calcule
// le gain EN DIRECT depuis le snapshot de démarrage figé sur le lot + l'état courant du compteur.
// Rien à afficher si aucune preuve (pas de snapshot, aucune réécriture) — jamais de valeur inventée.
// root : nécessaire au niveau measured (lot #117) pour réinterroger EN DIRECT le contrat RTK
// (`rtk gain -p -f json`, filtré au projet courant) et le comparer au snapshot de démarrage.
function rtkGainBlock(root, cur) {
  try {
    const co = cur && cur.integrations && cur.integrations.command_optimizer;
    const start = co && co.snapshot_start ? co.snapshot_start : null;
    const rtkStart = co && co.rtk_gain_start ? co.rtk_gain_start : null;
    let rtkStats = null;
    if (rtkStart) {
      const rtkEnd = rtkMetrics.rtkGainSnapshot(root);
      if (rtkEnd) {
        rtkStats = {
          raw_tokens: Math.max(0, rtkEnd.raw_tokens - rtkStart.raw_tokens),
          delivered_tokens: Math.max(0, rtkEnd.delivered_tokens - rtkStart.delivered_tokens),
        };
      }
    }
    // co déjà finalisé (lot rouvert/clos) OU calcul en direct depuis le snapshot de démarrage.
    const gain = (co && co.evidence) ? co : rtkMetrics.computeLotGain({ start, rtkStats });
    const lines = rtkMetrics.gainLines(gain, fmtK);
    return lines.length ? `\n${lines.join('\n')}\n` : '';
  } catch (_) {
    return '';
  }
}

function yn(v) { return v ? 'oui' : 'non'; }

// Verdict « session fraîche » (lot #109) : plus de « oui si le sujet change » (jugement
// laissé à l'assistant, jamais vérifiable) mais un booléen fondé sur le palier d'occupation
// PERSISTÉ par le hook Stop (fichier d'état occupancy, un seul chiffre) — zéro relecture du
// transcript ici, close-batch.js n'a de toute façon pas transcript_path (ce n'est pas un hook).
// Seuil = BUCKETS[1] (300k), déjà calibré et en usage pour le nudge subagent
// (occupancy.evaluateSubagentNudge) — repris tel quel plutôt qu'inventé au jugé pour ce lot.
function freshSessionVerdict(root) {
  const threshold = occupancy.BUCKETS[1];
  try {
    const sid = previousSessionId(root);
    if (!sid) return { fresh: false, reason: 'aucune session identifiée — pas de palier connu' };
    const sf = occupancy.stateFileFor(sid);
    const raw = fs.readFileSync(sf, 'utf8').trim();
    const bucket = parseInt(raw || '0', 10);
    if (!Number.isFinite(bucket)) return { fresh: false, reason: 'palier illisible — pas de mesure exploitable' };
    const fresh = bucket >= 2; // bucket 2 == occ >= BUCKETS[1] (300k)
    const reason = fresh
      ? `occupation ≥ ${fmtK(threshold)} (palier ${bucket})`
      : `occupation < ${fmtK(threshold)} (palier ${bucket})`;
    return { fresh, reason };
  } catch (_) {
    return { fresh: false, reason: `aucune mesure d'occupation disponible pour cette session (seuil : ${fmtK(threshold)})` };
  }
}

// Bloc « Fiche d'archive » (lot #95) : squelette tier 1 pré-rempli + la ligne de commande
// qui l'écrit. C'est ICI, et nulle part ailleurs, que le résultat de la vérification existe
// (calculé quelques lignes plus bas) — il n'est persisté dans aucun champ du backlog. Émis
// dans la checklist plutôt qu'écrit d'office : la machine ne sait pas rédiger un « pourquoi ».
// Chemin (relatif au repo) où CETTE session doit écrire son handoff manuel. `handoff.md` hors
// vague ; `handoff-lot-<id>.md` pour une session fille inscrite au fleet (lot #99, FIA-19) —
// sinon deux filles s'écraseraient, et son propre handoff auto masquerait le manuel qu'elle
// aurait écrit dans handoff.md. L'id de session vient de session-state.json : l'assistant n'a
// aucun moyen de connaître le sien.
function handoffRel(root) {
  try {
    const f = handoff.handoffFile(root, previousSessionId(root));
    return `.vibe-agent/${path.basename(f)}`;
  } catch (_) {
    return '.vibe-agent/handoff.md';
  }
}

function ficheBlock(root, cur, verifyVerdict) {
  try {
    if (!cur) return '';
    const md = archive.ficheSkeleton({
      id: cur.id,
      title: cur.title,
      epic: cur.epic,
      date: new Date().toISOString().slice(0, 10),
      commit: (git(['rev-parse', '--short', 'HEAD'], root) || '').trim(),
      verifyCmd: cur.verify,
      verify: verifyVerdict,
      us: cur.us || undefined,
    });
    return `
## Fiche d'archive (tier 1)

Remplis les sections puis écris-la (elle est immuable une fois posée) :
\`\`\`
node ${PMZ_BASE}/scripts/archive.js write --id ${cur.id} --stdin
\`\`\`
Squelette :
\`\`\`markdown
${md}\`\`\`
Puis archive le handoff manuel avant qu'il ne soit détruit :
\`node ${PMZ_BASE}/scripts/archive.js raw --id ${cur.id} --file ${handoffRel(root)}\`
`;
  } catch (_) {
    return '';
  }
}

// Trailers git à coller en pied du message de commit de clôture — traçabilité coût/modèle
// par lot (lot #60), lisibles par `git log --format=%(trailers)` sans reparser le sujet.
function trailerBlock(l) {
  if (!l) return '';
  const model = l.model_hint ? `${l.model_hint}${l.effort_hint ? `/${l.effort_hint}` : ''}` : 'non posé';
  const cost = l.cost_tokens > 0 ? `~${fmtK(l.cost_tokens)} tokens` : 'non mesuré';
  return `\n\n## Trailers du commit\n\nÀ coller en pied du message de commit :\n\`\`\`\nPMZ-Lot: ${l.id}\nPMZ-Cost: ${cost}\nPMZ-Model: ${model}\n\`\`\`\n`;
}
// Base des chemins d'aide affichés : racine du plugin en mode plugin, sinon install manuelle.
const PMZ_BASE = (process.env.CLAUDE_PLUGIN_ROOT || '').trim() || '~/.claude/promptimizer';

// Exécute la commande verify du lot en cours (si posée) AVANT le `done` — preuve de
// clôture. Jamais bloquant : un échec ne fait qu'ajouter une ligne « à corriger » dans
// la checklist, la décision de marquer le lot fait reste à l'humain/l'assistant. Timeout
// large (VERIFY_CLOSE_MS) : /close-batch est piloté par l'assistant, pas dans le budget serré
// d'un hook. L'ÉCHEC est prononcé UNIQUEMENT sur un exit ≠ 0 réel (runVerify.ok=false && !timedOut) :
// un dépassement de délai tue l'enfant (status null) et son stdout bufferisé peut contenir des
// motifs trompeurs (p.ex. la ligne ABORT d'un test négatif volontaire) — ce n'est pas un échec.
function main() {
  const d = compute(parseCwd());
  const changelog = yn(d.changelog_touched);
  const commit = yn(d.has_commit && !d.needs_closure);
  const closable = d.is_git_repo && !d.needs_closure;
  const fresh = freshSessionVerdict(d.root);

  const bl = d.backlog;
  let verifyLine = '';
  let verifyVerdict = bl && bl.current && bl.current.verify ? 'inconnu' : 'aucune';
  if (bl && bl.current && bl.current.verify) {
    const v = runVerify(d.root, bl.current.verify, VERIFY_CLOSE_MS);
    verifyVerdict = v.ok ? 'OK' : v.timedOut ? 'timeout' : 'ÉCHEC';
    verifyLine = v.ok
      ? `\n- Verify (\`${bl.current.verify}\`) : OK`
      : v.timedOut
        ? `\n- Verify (\`${bl.current.verify}\`) : non terminée dans le délai (${Math.round(VERIFY_CLOSE_MS / 1000)} s) — verify LOURDE, ne la relance PAS dans ce contexte : délègue-la à un subagent isolé (outil Agent/Task) qui l'exécute au complet et ne renvoie QUE le verdict (OK / ÉCHEC + 5 dernières lignes). Zéro sortie de tests ici (un timeout n'est PAS un échec)`
        : `\n- Verify (\`${bl.current.verify}\`) : ÉCHEC — refus doux, corriger avant de marquer fait (clôture non bloquée automatiquement) :\n  ${v.tail}\n  Après correction, re-vérifie en subagent isolé (outil Agent/Task) : seul le verdict revient ici, jamais la sortie des tests`;
  }
  const backlogBlock = bl ? `
## Plan de lots

- Avancement : ${bl.done}/${bl.total} faits${bl.current ? ` — en cours : #${bl.current.id} « ${bl.current.title} »` : ' — aucun lot en cours'}
- Périmètre conforme au lot du backlog : à confirmer (dévié → node ${PMZ_BASE}/scripts/backlog.js note --id N --note "…")${verifyLine}
- Après le commit : node ${PMZ_BASE}/scripts/backlog.js done --id ${bl.current ? bl.current.id : 'N'} (SHA du HEAD pris automatiquement ; le hook Stop le fait aussi tout seul)${bl.next ? `
- Lot suivant à reprendre dans le handoff : #${bl.next.id} « ${bl.next.title} »${modelEffortTag(bl.next)} — reporter ce tag modèle/effort dans le handoff (champ « Prochaine action recommandée »)` : ''}
` : '';
  const out = `## Clôture du lot

Handoff à écrire dans : \`${handoffRel(d.root)}\`

Checklist :
- Demande littérale traitée : à confirmer
- Scope creep évité : à confirmer
- Vérification ciblée faite : à confirmer
- Console/tests/lint selon contexte : à confirmer
- README mis à jour : à confirmer / non applicable
- ARCHITECTURE mis à jour : à confirmer / non applicable
- CHANGELOG mis à jour : ${changelog}
- Commit fait : ${commit}
- Non vérifié explicitement listé : à confirmer
${backlogBlock}${ficheBlock(d.root, bl && bl.current, verifyVerdict)}${rtkGainBlock(d.root, bl && bl.current)}${trailerBlock(bl && bl.current)}
## Économie de contexte

- lectures évitées : voir .vibe-agent/read-ledger.json
- relectures faites : voir .vibe-agent/context-ledger.json (repeated_reads)
- contexte redondant probable : voir alertes de palier (occupancy)
- session fraîche recommandée : ${d.needs_closure ? 'après clôture' : yn(fresh.fresh)}
- raison : ${d.needs_closure ? 'lot ouvert (modifs non commitées)' : fresh.reason}

Décision :
- ${closable ? 'clôturable' : 'non clôturable (modifs non commitées ou hors git)'}
`;
  process.stdout.write(out);
}

try { main(); } catch (_) { process.stdout.write('## Clôture du lot\n\n(erreur d\'audit)\n'); }
process.exit(0);
