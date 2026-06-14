#!/usr/bin/env node
'use strict';
// Checklist de clôture (format spec). Pré-rempli via audit-batch quand détectable.
const { compute } = require('./audit-batch');
const { parseCwd } = require('../lib/cli');

function yn(v) { return v ? 'oui' : 'non'; }

function main() {
  const d = compute(parseCwd());
  const changelog = yn(d.changelog_touched);
  const commit = yn(d.has_commit && !d.needs_closure);
  const closable = d.is_git_repo && !d.needs_closure;

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
