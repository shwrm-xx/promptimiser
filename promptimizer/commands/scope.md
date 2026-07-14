---
description: Découpe une grosse demande en 2-5 lots persistés (.vibe-agent/backlog.json)
allowed-tools: Bash(node *), Bash(git *)
---

Découpe la demande courante en un plan de lots persistant.

Rappel de découpe : **1 lot = 1 session sous ~300k tokens, 1 commit, un critère « fait
quand : … » vérifiable** — au-delà, redécouper plutôt que grossir un lot.

Étapes :
1. Reformuler la demande en **2 à 5 lots** : un titre court + un critère « fait quand : … »
   par lot. Un lot = une **unité livrable** (1 commit cohérent), pas une étape d'exécution
   (les étapes fines restent dans la todo-list, capturée automatiquement).
   Pour **chaque** lot, préconiser un **modèle** (ex. `sonnet` pour du mécanique/CRUD,
   `opus` pour du raisonnement lourd/archi) — obligatoire, jamais omis.
   Si ce découpage porte une **feature/epic** identifiable, proposer aussi un **nom de plan
   court (≤ 3 mots, cap 60 caractères)** — c'est lui qui nomme le plan dans le titre de
   session (`[XXX · #Y] NomDePlan · Lot #X · résumé` — `#Y` = id backlog global, `Lot #X` = rang
   du lot dans le plan) ; sinon l'omettre (epic = label optionnel, la session s'affichera
   `[XXX · #Y] Session Libre · résumé`).
2. Faire valider le découpage, les modèles préconisés **et l'epic éventuel** par
   l'utilisateur en **UNE** question (pas dix).
3. Si un epic a été validé, l'enregistrer une fois pour la session/le titre :
   `node ~/.claude/promptimizer/scripts/backlog.js epic --set "Nom de l'epic"`
   (écrit `.vibe-agent/epic`, cap 60 caractères).
4. Persister chaque lot validé (un appel par lot), avec sa préconisation de modèle et,
   si présent, l'epic :
   `node ~/.claude/promptimizer/scripts/backlog.js add --title "…" --scope "fait quand : …" --model sonnet --epic "Nom de l'epic"`
   (`--model` est **obligatoire** — l'ajout est refusé sans lui ; `--epic` reste optionnel)
   puis démarrer le premier :
   `node ~/.claude/promptimizer/scripts/backlog.js start --id <id>`.
5. Afficher le plan (`node ~/.claude/promptimizer/scripts/backlog.js show`, ou
   `show --epic "Nom de l'epic"` pour filtrer) et traiter **UNIQUEMENT le premier lot**.

Le suivi est ensuite automatique : le hook Stop clôt le lot au commit et annonce le suivant,
le handoff porte l'avancement (x/y faits), le plan est réinjecté au démarrage suivant et
après compaction. `/close-batch` marque le lot fait si le hook ne l'a pas déjà fait.

La préconisation de modèle est **réaffichée** à chaque `show`/`start` et dans le handoff
auto (`[modèle : …]`) — pense à basculer de modèle avant d'attaquer un lot.
