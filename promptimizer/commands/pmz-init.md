---
description: Initialise le socle Promptimizer du projet (après confirmation)
allowed-tools: Bash(node *), Bash(git *)
---

Initialise le socle Promptimizer pour le projet courant — y compris un **projet en cours**
qui a déjà son `CLAUDE.md`/`AGENTS.md`.

1. Vérifie l'état : `node ~/.claude/promptimizer/scripts/detect-project.js`
2. Si ce n'est pas un repo git, propose `git init` à l'utilisateur (ne le fais qu'après accord).
3. Crée et complète le socle (jamais d'écrasement, repo git uniquement, jamais le code
   applicatif) : `node ~/.claude/promptimizer/scripts/bootstrap-project.js --augment`
   - fichiers **absents** : créés depuis les templates (`created`) ;
   - `CLAUDE.md`/`AGENTS.md` **déjà présents** : la section « Règles Promptimizer » taguée
     (`<!-- pmz:rules:start/end -->`) est ajoutée en fin de fichier (`augmented`) —
     append-only, idempotent, réversible en supprimant le bloc.
4. Affiche les fichiers créés (`created`), augmentés (`augmented`) et ignorés (`skipped`).
5. Finalise `CLAUDE.md` et `AGENTS.md` avec **lecture minimale** (déduire la stack des seuls
   manifestes), sans les rallonger inutilement.
6. Propose ensuite un premier lot court.

Ne crée ni ne modifie rien sans confirmation explicite de l'utilisateur.
