---
description: Découpe une grosse demande en 2-5 lots persistés (.vibe-agent/backlog.json)
allowed-tools: Bash(node *), Bash(git *)
---

Découpe la demande courante en un plan de lots persistant.

Étapes :
1. Reformuler la demande en **2 à 5 lots** : un titre court + un critère « fait quand : … »
   par lot. Un lot = une **unité livrable** (1 commit cohérent), pas une étape d'exécution
   (les étapes fines restent dans la todo-list, capturée automatiquement).
   Pour **chaque** lot, préconiser un **modèle** (ex. `sonnet` pour du mécanique/CRUD,
   `opus` pour du raisonnement lourd/archi) — obligatoire, jamais omis.
2. Faire valider le découpage **et les modèles préconisés** par l'utilisateur en **UNE**
   question (pas dix).
3. Persister chaque lot validé (un appel par lot), avec sa préconisation de modèle :
   `node ~/.claude/promptimizer/scripts/backlog.js add --title "…" --scope "fait quand : …" --model sonnet`
   (`--model` est **obligatoire** — l'ajout est refusé sans lui) puis démarrer le premier :
   `node ~/.claude/promptimizer/scripts/backlog.js start --id <id>`.
4. Afficher le plan (`node ~/.claude/promptimizer/scripts/backlog.js show`) et traiter
   **UNIQUEMENT le premier lot**.

Le suivi est ensuite automatique : le hook Stop clôt le lot au commit et annonce le suivant,
le handoff porte l'avancement (x/y faits), le plan est réinjecté au démarrage suivant et
après compaction. `/close-batch` marque le lot fait si le hook ne l'a pas déjà fait.

La préconisation de modèle est **réaffichée** à chaque `show`/`start` et dans le handoff
auto (`[modèle : …]`) — pense à basculer de modèle avant d'attaquer un lot.
