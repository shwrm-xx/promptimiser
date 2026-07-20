---
description: Clôture le lot courant avec discipline (vérif + changelog + commit + handoff)
allowed-tools: Bash(node *), Bash(git *), Write
---

Clôture le lot courant avec discipline.

Point de départ : `node ~/.claude/promptimizer/scripts/close-batch.js`

Étapes :
1. Résumer la demande initiale.
2. Mapper chaque point demandé vers fait / non fait / non vérifié.
3. Vérifier seulement ce qui a changé. Verify lourde (suite de tests complète, build long) :
   la déléguer à un subagent isolé (outil Agent/Task) qui l'exécute et ne renvoie QUE le
   verdict (OK / ÉCHEC + dernières lignes) — zéro sortie de tests dans le contexte principal.
4. Mettre à jour `CHANGELOG.md` si ce n'est pas fait.
5. Proposer ou créer un commit français court.
5bis. Si un plan de lots existe (bloc « Plan de lots » de la checklist) : marquer le lot fait
   (`node ~/.claude/promptimizer/scripts/backlog.js done --id N` — le hook Stop le fait aussi
   tout seul au tour suivant) et reprendre le lot suivant dans le handoff, **avec son tag
   modèle/effort** (`[modèle : X · effort Y]`, déjà fourni par la checklist de clôture).
6. Produire un handoff de moins de 800 tokens et l'écrire dans `.vibe-agent/handoff.md`
   (écraser le contenu ; première ligne `<!-- pmz:handoff:manual -->`). Y inclure les
   lignes machine `pmz:skip: <chemin>` (fichiers à ne pas relire) et
   `pmz:summary: <chemin> — <résumé en une phrase>` (résumé servi à la place d'une
   relecture ; « — » = tiret cadratin obligatoire). Le champ « Prochaine action
   recommandée » doit nommer le lot suivant **et son modèle préconisé** — jamais l'un
   sans l'autre.
7. Recommander une session fraîche : le handoff y sera injecté automatiquement au démarrage.

Ne pas déclarer « fini » sans preuve.
