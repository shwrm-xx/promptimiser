---
description: État de la session avec priorité absolue à l'économie de contexte
allowed-tools: Bash(node *), Bash(git *)
---

Analyse l'état de la session avec priorité absolue à l'économie de contexte.

Ne relis pas de fichiers complets si `git status`, `git diff`, `git grep` ou les ledgers
`.vibe-agent/` suffisent. Tu peux exécuter :
`node ~/.claude/promptimizer/scripts/audit-context.js`

Produis :
1. statut budget contexte ;
2. fichiers à éviter de relire ;
3. action la moins coûteuse ;
4. risque de session trop longue ;
5. recommandation : continuer / vérifier / clôturer / session fraîche.
