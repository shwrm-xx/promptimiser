#!/usr/bin/env node
'use strict';
// État de clôture d'un lot, basé sur git. Exporte compute() pour stop.js et close-batch.js.
const {
  gitRoot, gitStatusMeaningful, changelogTouched, hasAnyCommit, lastCommitEpoch,
} = require('../lib/project');
const { loadBacklog, currentLot, nextLot, progress } = require('../lib/backlog');
const { parseCwd } = require('../lib/cli');

// Résumé null-safe du plan de lots pour la checklist de clôture. null si pas de plan.
function backlogSummary(root) {
  try {
    const b = loadBacklog(root);
    if (!b.lots.length) return null;
    const cur = currentLot(b);
    const nxt = nextLot(b);
    const p = progress(b);
    return {
      done: p.done,
      total: p.total,
      current: cur ? { id: cur.id, title: cur.title, verify: cur.verify || null } : null,
      next: nxt ? { id: nxt.id, title: nxt.title } : null,
    };
  } catch (_) {
    return null;
  }
}

function compute(cwd) {
  const root = gitRoot(cwd);
  if (!root) {
    return {
      is_git_repo: false, root: null, modified_files: [],
      changelog_touched: false, has_commit: false, last_commit_epoch: null,
      needs_closure: false, backlog: null,
    };
  }
  // Même définition de « lot ouvert » que stop.js : le churn .vibe-agent/ (ledgers,
  // handoff réécrits chaque tour) ne doit pas rendre un lot « non clôturable ».
  const modified = gitStatusMeaningful(root);
  return {
    is_git_repo: true,
    root,
    modified_files: modified,
    changelog_touched: changelogTouched(root),
    has_commit: hasAnyCommit(root),
    last_commit_epoch: lastCommitEpoch(root),
    needs_closure: modified.length > 0,
    backlog: backlogSummary(root),
  };
}

function toMarkdown(d) {
  const lines = [];
  lines.push('## Audit du lot');
  lines.push('');
  if (!d.is_git_repo) { lines.push('Pas un dépôt git — rien à auditer.'); return lines.join('\n') + '\n'; }
  lines.push(`- Fichiers modifiés non commités : ${d.modified_files.length}`);
  d.modified_files.slice(0, 20).forEach((f) => lines.push(`  - ${f}`));
  lines.push(`- CHANGELOG touché : ${d.changelog_touched ? 'oui' : 'non'}`);
  lines.push(`- Commit existant : ${d.has_commit ? 'oui' : 'non'}`);
  lines.push(`- Clôture nécessaire : ${d.needs_closure ? 'oui' : 'non'}`);
  if (d.backlog) {
    lines.push(`- Plan de lots : ${d.backlog.done}/${d.backlog.total} faits`
      + (d.backlog.current ? ` — en cours : #${d.backlog.current.id} « ${d.backlog.current.title} »` : ''));
  }
  return lines.join('\n') + '\n';
}

function main() {
  const d = compute(parseCwd());
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(d, null, 2) + '\n');
  } else {
    process.stdout.write(toMarkdown(d));
  }
}

if (require.main === module) {
  try { main(); } catch (_) { process.stdout.write('{}\n'); }
  process.exit(0);
}

module.exports = { compute, toMarkdown };
