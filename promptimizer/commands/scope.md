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
   `opus` pour du raisonnement lourd/archi) **et un effort de raisonnement**
   (`low` | `medium` | `high` | `xhigh`) — les deux sont obligatoires, jamais omis.
   Si ce découpage porte une **feature/epic** identifiable, proposer aussi un **nom de plan
   court (≤ 3 mots, cap 60 caractères)** — c'est lui qui nomme le plan dans le titre de
   session (`[XXX · #Y] NomDePlan · Lot #X · résumé` — `#Y` = id backlog global, `Lot #X` = rang
   du lot dans le plan) ; sinon l'omettre (epic = label optionnel, la session s'affichera
   `[XXX · #Y] Session Libre · résumé`).
   **Penser la parallélisation d'office** : pour **chaque** lot, statuer explicitement —
   soit un **périmètre** proposé (globs de chemins que ce lot a le droit de modifier),
   soit « série » avec la raison en quelques mots (périmètre incertain, chevauchement
   inévitable avec un autre lot, ordre imposé…). Jamais de silence sur ce point ; le
   garde-fou anti-invention demeure : ne **jamais** deviner un périmètre incertain — au
   doute, « série » assumé et annoncé (le lot reste périmètre-vide, séquentiel classique).
   Si un ordre s'impose entre lots, poser un `depends_on` (id des lots qui doivent être
   clos avant).
2. Faire valider le découpage, les modèles préconisés, l'epic éventuel **et le périmètre/les
   dépendances proposés** par l'utilisateur en **UNE** question (pas dix).
3. Si un epic a été validé, l'enregistrer une fois pour la session/le titre :
   `node ~/.claude/promptimizer/scripts/backlog.js epic --set "Nom de l'epic"`
   (écrit `.vibe-agent/epic`, cap 60 caractères).
4. Persister chaque lot validé (un appel par lot), avec sa préconisation de modèle, son
   effort, si présent l'epic, et si validé son périmètre/ses dépendances :
   `node ~/.claude/promptimizer/scripts/backlog.js add --title "…" --scope "fait quand : …" --model sonnet --effort medium --verify "npm test" --epic "Nom de l'epic" --perimeter "src/a/**" --depends 12`
   (`--model` est **obligatoire** — l'ajout est refusé sans lui ; `--effort` doit valoir
   `low`/`medium`/`high`/`xhigh` sinon l'ajout est refusé ; `--epic` reste optionnel ;
   `--perimeter`/`--depends` répétables, optionnels, omis si aucun périmètre net).
   **`--verify` dès que le lot est vérifiable par une commande** (test, typecheck, build,
   lint…) : c'est la preuve rejouée à l'auto-clôture. Un lot posé sans elle sera « clos sans
   preuve » — à réserver aux lots réellement non vérifiables par commande (doc, choix visuel).
   Elle est éditable après coup : `backlog.js verify --set "…" --id <id>`.
4bis. **Si ≥ 2 lots viennent d'être persistés**, calculer le plan de vagues :
   `node ~/.claude/promptimizer/scripts/backlog.js parallelize --json` (ajouter `--epic "…"` si
   posé). Une **opportunité réelle** = au moins une vague contenant **≥ 2 lots** (une vague à 1
   lot n'apporte rien). Le verdict est **toujours restitué** — jamais de silence :
   - **Aucune opportunité** : **une seule ligne** qui dit pourquoi, tirée de la sortie du
     script (ex. « Parallélisation : aucune opportunité — lots posés en série / chaîne de
     dépendances / périmètres chevauchants »), puis passer à l'étape 5. Pas de question,
     pas de plan détaillé : le raisonnement est visible, le bruit s'arrête à cette ligne.
   - **Opportunité** : afficher le plan lisible (`parallelize` sans `--json` : vagues,
     branches suggérées, périmètres) puis poser **une** question à **3 choix** :
     - **Tout en parallèle** → afficher, pour chaque lot de la 1ʳᵉ vague, la commande de
       démarrage suggérée (`backlog.js start --id <id> --owner <session>`) ; rappeler que
       l'ouverture des sessions filles reste **manuelle** (PMZ ne lance rien tout seul).
     - **Partiellement** → proposer **le** sous-ensemble cohérent le plus utile (ex. les
       lots les plus indépendants de la 1ʳᵉ vague en parallèle, le reste en série), en
       respectant `depends_on` — jamais un panachage qui casse une dépendance ou marie
       deux périmètres chevauchants. Même restitution que « tout en parallèle », limitée
       au sous-ensemble retenu ; les lots écartés repassent en série.
     - **En série** → comportement classique, passer à l'étape 5.
5. Démarrer et traiter le lot voulu : `node ~/.claude/promptimizer/scripts/backlog.js start --id <id>`,
   afficher le plan (`show`, ou `show --epic "Nom de l'epic"` pour filtrer) et traiter
   **UNIQUEMENT** le(s) lot(s) démarré(s) (le premier lot en série ; la 1ʳᵉ vague si parallèle).

Le suivi est ensuite automatique : le hook Stop clôt le lot au commit et annonce le suivant,
le handoff porte l'avancement (x/y faits), le plan est réinjecté au démarrage suivant et
après compaction. `/close-batch` marque le lot fait si le hook ne l'a pas déjà fait.

La préconisation de modèle et l'effort sont **réaffichés** à chaque `show`/`start`/`next`
et dans le handoff auto (`[modèle : … · effort …]`) — pense à basculer de modèle/effort
avant d'attaquer un lot.
