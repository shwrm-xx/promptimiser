---
description: État de la session avec priorité absolue à l'économie de contexte
allowed-tools: Bash(node *), Bash(git *)
---

Analyse l'état de la session avec priorité absolue à l'économie de contexte.

Ne relis pas de fichiers complets si `git status`, `git diff`, `git grep` ou les ledgers
`.vibe-agent/` suffisent. Tu peux exécuter :
`node ${CLAUDE_PLUGIN_ROOT}/scripts/audit-context.js`

Le statut est chiffré en **tokens réels** (occupation courante + gaspillage de relecture) ;
il retombe sur le comptage de relectures, annoncé explicitement, si aucune occupation token
n'est encore connue. Ne fabrique jamais de chiffre tokens toi-même : reprends celui du script.

Produis :
1. statut budget contexte (tel que chiffré par le script) ;
2. fichiers à éviter de relire ;
3. action la moins coûteuse ;
4. risque de session trop longue ;
5. recommandation : continuer / vérifier / clôturer / session fraîche.
