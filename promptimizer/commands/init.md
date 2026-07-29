---
description: Initialise le socle Promptimizer du projet (après confirmation)
allowed-tools: Bash(node *), Bash(git *)
---

Initialise le socle Promptimizer pour le projet courant — y compris un **projet en cours**
qui a déjà son `CLAUDE.md`/`AGENTS.md`.

1. Vérifie l'état : `node ${CLAUDE_PLUGIN_ROOT}/scripts/detect-project.js`
2. Si ce n'est pas un repo git, propose `git init` à l'utilisateur (ne le fais qu'après accord).
3. Crée et complète le socle (jamais d'écrasement, repo git uniquement, jamais le code
   applicatif) : `node ${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap-project.js --augment`
   - fichiers **absents** : créés depuis les templates (`created`) ;
   - `CLAUDE.md`/`AGENTS.md` **déjà présents** : la section « Règles Promptimizer » taguée
     (`<!-- pmz:rules:start/end -->`) est ajoutée en fin de fichier (`augmented`) —
     append-only, idempotent, réversible en supprimant le bloc.
4. Affiche les fichiers créés (`created`), augmentés (`augmented`) et ignorés (`skipped`).
5. Finalise `CLAUDE.md` et `AGENTS.md` avec **lecture minimale** (déduire la stack des seuls
   manifestes), sans les rallonger inutilement.
6. **Uniquement si le socle vient d'être CRÉÉ** (nouveau projet — pas `augmented`, un projet
   déjà initialisé garde son trigramme dérivé automatiquement, sans interruption) : proposer le
   trigramme du projet en **une** question à choix (défaut + 2 alternatives, saisie libre
   possible) —
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/backlog.js trigram --suggest` liste 3 propositions.
   Une fois validé : `node ${CLAUDE_PLUGIN_ROOT}/scripts/backlog.js trigram --set XXX`
   (écrit `.vibe-agent/trigram`, préfixe désormais les titres de session : `[XXX] …`).
7. Propose ensuite un premier lot court.

Ne crée ni ne modifie rien sans confirmation explicite de l'utilisateur.
