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
   (reprends la ligne `backlog.js done …` telle qu'elle est écrite dans la checklist : elle porte
   déjà `--verify-verdict`, qui **persiste la preuve** de vérification sans relancer la suite de
   tests — le hook Stop clôt aussi tout seul au tour suivant) et reprendre le lot suivant dans le
   handoff, **avec son tag
   modèle/effort** (`[modèle : X · effort Y]`, déjà fourni par la checklist de clôture).
6bis. Rédiger la **fiche d'archive** du lot et l'écrire :
   `node ~/.claude/promptimizer/scripts/archive.js write --id N --stdin` (squelette pré-rempli
   fourni par la checklist ci-dessus : reprends-le tel quel et remplis les sections). Mêmes
   matériaux que le handoff, distillat différent : le handoff sert la **reprise** (prochaine
   action) et meurt au tour suivant ; la fiche sert la **mémoire** (décisions + pourquoi,
   non-vérifié, dette) et est versionnée, immuable. Interdits : diff, contenu de fichier,
   listing de code, sortie de tests — le sha et le CHANGELOG font foi pour le volatil.
6. Produire un handoff de moins de 800 tokens et l'écrire dans le fichier annoncé par la
   checklist (« Handoff à écrire dans : … ») — `.vibe-agent/handoff.md` hors vague, un
   `handoff-lot-<id>.md` propre à la session si elle tient un lot d'une vague parallèle (deux
   filles écriraient sinon le même fichier et s'écraseraient)
   (écraser le contenu ; première ligne `<!-- pmz:handoff:manual -->`). Y inclure les
   lignes machine `pmz:skip: <chemin>` (fichiers à ne pas relire) et
   `pmz:summary: <chemin> — <résumé en une phrase>` (résumé servi à la place d'une
   relecture ; « — » = tiret cadratin obligatoire). Le champ « Prochaine action
   recommandée » doit nommer le lot suivant **et son modèle préconisé** — jamais l'un
   sans l'autre.
6ter. Archiver le handoff manuel **avant** qu'il ne soit détruit — la commande exacte (avec le
   bon fichier) est donnée par la checklist :
   `node ~/.claude/promptimizer/scripts/archive.js raw --id N --file .vibe-agent/handoff.md`.
   Le handoff manuel a une vie unique — injecté au démarrage suivant, il est aussitôt
   rebasculé en auto puis écrasé par le premier Stop. Cette copie tier 2 (locale, non
   versionnée) garde son texte intégral ; la fiche du 6bis en garde le stable.
7. Suivre le verdict « session fraîche recommandée » du bloc « Économie de contexte » de la
   checklist (oui/non + raison chiffrée sur le palier d'occupation) — ne pas le contredire par
   un jugement à l'œil. Si oui : le recommander, le handoff y sera injecté automatiquement au
   démarrage.

Ne pas déclarer « fini » sans preuve.
