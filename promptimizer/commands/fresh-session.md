---
description: Prépare une nouvelle session en minimisant le contexte (handoff court)
allowed-tools: Bash(node *), Bash(git *), Write
---

Prépare une nouvelle session en minimisant le contexte.

1. Produis un handoff court (modèle : `~/.claude/promptimizer/templates/handoff-template.md`).
2. **Écris-le dans `.vibe-agent/handoff.md`** (écrase le contenu existant ; garde la
   première ligne `<!-- pmz:handoff:manual -->` du modèle — elle le protège de
   l'écrasement par le handoff auto de fin de tour).
3. Confirme à l'utilisateur qu'il peut démarrer une session fraîche directement :
   le handoff sera injecté automatiquement au démarrage (hook SessionStart).

Modèle du handoff :

<!-- pmz:handoff:manual -->
## Handoff session fraîche

Objectif du lot terminé :
- ...

Fichiers modifiés :
- ...

Décisions prises :
- ...

Vérifications faites :
- ...

Non vérifié :
- ...

Dette restante :
- ...

Prochaine action recommandée :
- ...

Contrainte budget :
- ne pas relire les fichiers suivants sauf changement :
