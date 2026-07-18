---
description: Clôture le lot courant avec discipline (vérif + changelog + commit + handoff)
---

Clôture le lot courant avec discipline.

Point de départ : `node ~/.config/opencode/pmz/scripts/close-batch.js`

Étapes :
1. Résumer la demande initiale.
2. Mapper chaque point demandé vers fait / non fait / non vérifié.
3. Vérifier seulement ce qui a changé.
4. Mettre à jour `CHANGELOG.md` si ce n'est pas fait.
5. Proposer ou créer un commit français court.
5bis. Si un plan de lots existe (bloc « Plan de lots » de la checklist) : marquer le lot fait
   (`node ~/.config/opencode/pmz/scripts/backlog.js done --id N` — l'event `session.idle` le
   fait aussi tout seul au tour suivant sur tree propre) et reprendre le lot suivant dans le
   handoff.
6. Produire un handoff de moins de 800 tokens et l'écrire dans `.vibe-agent/handoff.md`
   (écraser le contenu ; première ligne `<!-- pmz:handoff:manual -->`).
7. Recommander une session fraîche : le handoff y sera injecté automatiquement au démarrage
   (au 1er message, via l'injection différée du plugin).

Ne pas déclarer « fini » sans preuve.
