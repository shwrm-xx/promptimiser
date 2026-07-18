---
description: Audite les risques de relecture inutile
---

Audite les risques de relecture inutile.

Utilise d'abord :
- `git status`
- `git diff --stat`
- `.vibe-agent/context-ledger.json`
- `.vibe-agent/read-ledger.json`
- `node ~/.config/opencode/pmz/scripts/audit-context.js`

Ne propose une lecture complète que si elle est nécessaire.

Le statut renvoyé par le script est chiffré en **tokens réels** (occupation + gaspillage),
avec repli annoncé sur le comptage de relectures si l'occupation token est absente. Reprends
ce chiffre tel quel, n'en invente pas.

Sortie courte :
- lectures évitables ;
- lectures justifiées ;
- prochaine action minimale ;
- alerte budget (statut token du script).
