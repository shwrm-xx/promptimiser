---
description: Initialise le socle Vibe Session Governor du projet (après confirmation)
allowed-tools: Bash(node *), Bash(git *)
---

Initialise le socle Vibe Session Governor pour le projet courant.

1. Vérifie l'état : `node ~/.claude/vibe-session-governor/scripts/detect-project.js`
2. Si ce n'est pas un repo git, propose `git init` à l'utilisateur (ne le fais qu'après accord).
3. Crée le socle prudent (jamais d'écrasement, repo git uniquement, jamais le code applicatif) :
   `node ~/.claude/vibe-session-governor/scripts/bootstrap-project.js`
4. Affiche les fichiers créés / ignorés.
5. Finalise `CLAUDE.md` et `AGENTS.md` avec **lecture minimale** (déduire la stack des seuls
   manifestes), sans les rallonger inutilement.
6. Propose ensuite un premier lot court.

Ne crée rien sans confirmation explicite de l'utilisateur.
