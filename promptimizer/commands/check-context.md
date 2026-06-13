---
description: Audite les risques de relecture inutile
allowed-tools: Bash(node *), Bash(git *)
---

Audite les risques de relecture inutile.

Utilise d'abord :
- `git status`
- `git diff --stat`
- `.vibe-agent/context-ledger.json`
- `.vibe-agent/read-ledger.json`
- `node ~/.claude/promptimizer/scripts/audit-context.js`

Ne propose une lecture complète que si elle est nécessaire.

Sortie courte :
- lectures évitables ;
- lectures justifiées ;
- prochaine action minimale ;
- alerte budget.
