---
description: Calcule un plan de vagues parallèles (périmètres disjoints + depends_on) sans rien lancer
allowed-tools: Bash(node *)
---

Propose un **plan de vagues parallèles** à partir des lots « à faire » du backlog — **sans rien
lancer** (aucune branche, aucun worktree, aucune session fille).

Une **vague** = un groupe de lots dont les **périmètres sont disjoints deux à deux** (le conflit
git y est structurellement impossible) et dont toutes les dépendances `depends_on` sont
satisfaites par une vague antérieure ou un lot déjà fait. Deux périmètres qui se **chevauchent**
ne partagent jamais une vague (l'un est repoussé plus loin).

Prérequis : les lots doivent porter un **périmètre** (`add --perimeter …` ou
`setPerimeter`) et, si un ordre s'impose, des **dépendances** (`add --depends …`). Un lot sans
périmètre est « non parallélisable » (à traiter en série) ; un lot dont une dépendance ne pourra
jamais aboutir (cycle, dépend d'un non parallélisable) est « bloqué ».

Étapes :
1. Calculer et afficher le plan :
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/backlog.js parallelize`
   (filtrer un epic : `parallelize --epic "Nom de l'epic"` ; sortie machine : `--json`).
2. Restituer le plan tel quel : pour chaque vague, les lots avec leur **branche suggérée** et
   leur **périmètre**, puis les lots non parallélisables / bloqués.
3. **NE RIEN LANCER.** La commande est une proposition : le lancement des sessions filles reste
   **manuel et validé** (cf. D3, palier 2). L'adoption peut être **partielle** : un sous-ensemble
   d'une vague est valide tant que les périmètres retenus restent disjoints et les `depends_on`
   satisfaits — les lots écartés repassent simplement en série. Après validation humaine, chaque
   lot retenu se démarre à la main :
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/backlog.js start --id <id> --owner <session>`.
4. En briefant chaque **session fille**, rappelle-lui que le périmètre exclusif vaut AUSSI pour
   ses **sous-agents** (Task/Agent) : le garde-fou d'écriture ne protège que la session
   propriétaire, pas les sous-agents qu'elle délègue — elle doit leur transmettre le périmètre.

N'invente aucune vague absente de la sortie du script : le plan fait foi.
