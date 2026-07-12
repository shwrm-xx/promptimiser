#!/usr/bin/env node
'use strict';
// Checklist de clôture (format spec). Pré-rempli via audit-batch quand détectable.
const { execSync } = require('child_process');
const { compute } = require('./audit-batch');
const { parseCwd } = require('../lib/cli');

function yn(v) { return v ? 'oui' : 'non'; }

// Exécute la commande verify du lot en cours (si posée) AVANT le `done` — preuve de
// clôture. Jamais bloquant : un échec ne fait qu'ajouter une ligne « à corriger » dans
// la checklist, la décision de marquer le lot fait reste à l'humain/l'assistant.
function runVerify(root, cmd) {
  try {
    execSync(cmd, { cwd: root, timeout: 20000, stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    const raw = String((e && e.stderr) || (e && e.stdout) || (e && e.message) || '').trim();
    return { ok: false, tail: raw.split(/\r?\n/).slice(-5).join('\n  ') };
  }
}

function main() {
  const d = compute(parseCwd());
  const changelog = yn(d.changelog_touched);
  const commit = yn(d.has_commit && !d.needs_closure);
  const closable = d.is_git_repo && !d.needs_closure;

  const bl = d.backlog;
  let verifyLine = '';
  if (bl && bl.current && bl.current.verify) {
    const v = runVerify(d.root, bl.current.verify);
    verifyLine = v.ok
      ? `\n- Verify (\`${bl.current.verify}\`) : OK`
      : `\n- Verify (\`${bl.current.verify}\`) : ÉCHEC — refus doux, corriger avant de marquer fait (clôture non bloquée automatiquement) :\n  ${v.tail}`;
  }
  const backlogBlock = bl ? `
## Plan de lots

- Avancement : ${bl.done}/${bl.total} faits${bl.current ? ` — en cours : #${bl.current.id} « ${bl.current.title} »` : ' — aucun lot en cours'}
- Périmètre conforme au lot du backlog : à confirmer (dévié → node ~/.claude/promptimizer/scripts/backlog.js note --id N --note "…")${verifyLine}
- Après le commit : node ~/.claude/promptimizer/scripts/backlog.js done --id ${bl.current ? bl.current.id : 'N'} (SHA du HEAD pris automatiquement ; le hook Stop le fait aussi tout seul)${bl.next ? `
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
${backlogBlock}
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
