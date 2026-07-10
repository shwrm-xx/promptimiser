---
description: Clôture le lot courant avec discipline (vérif + changelog + commit + handoff)
allowed-tools: Bash(node *), Bash(git *), Write
---

Clôture le lot courant avec discipline.

Point de départ : `node ~/.claude/promptimizer/scripts/close-batch.js`

Étapes :
1. Résumer la demande initiale.
2. Mapper chaque point demandé vers fait / non fait / non vérifié.
3. Vérifier seulement ce qui a changé.
4. Mettre à jour `CHANGELOG.md` si ce n'est pas fait.
5. Proposer ou créer un commit français court.
5bis. Si un plan de lots existe (bloc « Plan de lots » de la checklist) : marquer le lot fait
   (`node ~/.claude/promptimizer/scripts/backlog.js done --id N` — le hook Stop le fait aussi
   tout seul au tour suivant) et reprendre le lot suivant dans le handoff.
6. Produire un handoff de moins de 800 tokens et l'écrire dans `.vibe-agent/handoff.md`
   (écraser le contenu ; première ligne `<!-- pmz:handoff:manual -->`).
7. Recommander une session fraîche : le handoff y sera injecté automatiquement au démarrage.

Ne pas déclarer « fini » sans preuve.
