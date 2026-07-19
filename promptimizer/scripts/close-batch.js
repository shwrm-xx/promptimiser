#!/usr/bin/env node
'use strict';
// Checklist de clôture (format spec). Pré-rempli via audit-batch quand détectable.
const { compute } = require('./audit-batch');
const { runVerify } = require('../lib/project');
const { VERIFY_CLOSE_MS } = require('../lib/timeouts');
const { parseCwd } = require('../lib/cli');
const { fmtK } = require('../lib/messages');

function yn(v) { return v ? 'oui' : 'non'; }

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

  const bl = d.backlog;
  let verifyLine = '';
  if (bl && bl.current && bl.current.verify) {
    const v = runVerify(d.root, bl.current.verify, VERIFY_CLOSE_MS);
    verifyLine = v.ok
      ? `\n- Verify (\`${bl.current.verify}\`) : OK`
      : v.timedOut
        ? `\n- Verify (\`${bl.current.verify}\`) : non terminée dans le délai (${Math.round(VERIFY_CLOSE_MS / 1000)} s) — relance-la à la main pour la preuve complète (ce n'est PAS un échec)`
        : `\n- Verify (\`${bl.current.verify}\`) : ÉCHEC — refus doux, corriger avant de marquer fait (clôture non bloquée automatiquement) :\n  ${v.tail}`;
  }
  const backlogBlock = bl ? `
## Plan de lots

- Avancement : ${bl.done}/${bl.total} faits${bl.current ? ` — en cours : #${bl.current.id} « ${bl.current.title} »` : ' — aucun lot en cours'}
- Périmètre conforme au lot du backlog : à confirmer (dévié → node ${PMZ_BASE}/scripts/backlog.js note --id N --note "…")${verifyLine}
- Après le commit : node ${PMZ_BASE}/scripts/backlog.js done --id ${bl.current ? bl.current.id : 'N'} (SHA du HEAD pris automatiquement ; le hook Stop le fait aussi tout seul)${bl.next ? `
- Lot suivant à reprendre dans le handoff : #${bl.next.id} « ${bl.next.title} »` : ''}
` : '';
  const out = `## Clôture du lot

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
${backlogBlock}${trailerBlock(bl && bl.current)}
## Économie de contexte

- lectures évitées : voir .vibe-agent/read-ledger.json
- relectures faites : voir .vibe-agent/context-ledger.json (repeated_reads)
- contexte redondant probable : voir alertes de palier (occupancy)
- session fraîche recommandée : ${d.needs_closure ? 'après clôture' : 'oui si le sujet change'}
- raison : ${d.needs_closure ? 'lot ouvert (modifs non commitées)' : 'lot propre'}

Décision :
- ${closable ? 'clôturable' : 'non clôturable (modifs non commitées ou hors git)'}
`;
  process.stdout.write(out);
}

try { main(); } catch (_) { process.stdout.write('## Clôture du lot\n\n(erreur d\'audit)\n'); }
process.exit(0);
