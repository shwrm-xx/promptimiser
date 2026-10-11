# AGENTS.md — Promptimizer

Instructions persistantes. Travailler par petits lots, contexte minimal.

<!-- pmz:rules:start -->
## Avant de modifier

Hiérarchie stricte :
1. `git status` / `git diff` / `git grep` — toujours en premier.
2. Lecture partielle (section ciblée).
3. Lecture complète — seulement si 1-2 insuffisants.

Ne jamais relire un fichier déjà lu s'il n'a pas changé. Ne pas élargir le périmètre sans
demande explicite.

## Pendant le travail

- Modifier le moins de fichiers possible ; respecter les conventions existantes.
- Ne pas ajouter de dépendance sans justification.
- Commandes **irréversibles** (`rm -rf`, `git reset --hard`, `git push --force`,
  `git clean -fd`, `DROP TABLE`…) → demander confirmation avant d'exécuter.

## Vérification

Vérifier uniquement ce qui a changé (UI : rendu/test ciblé ; API : endpoint/unitaire ;
contenu : cohérence + rendu). Annoncer ce qui n'a pas pu être vérifié.

## Fin de lot

1. Vérification ciblée.
2. `CHANGELOG.md` mis à jour (entrée datée, en français).
3. Commit court (français).
4. Handoff < 800 tokens : fait · reste/blocages · fichiers clés · session fraîche si pertinent.
   L'écrire dans `.vibe-agent/handoff.md` (écraser ; 1re ligne `<!-- pmz:handoff:manual -->`) —
   il sera repris au démarrage de la session suivante.

## Début de session

Si `.vibe-agent/handoff.md` existe, le lire en première action et le prendre comme point de
départ ; ne pas relire les fichiers qu'il liste sauf changement.

## Contexte élevé

Si la session est longue ou que beaucoup de fichiers ont été lus, signaler :
`[contexte élevé — finir ce lot, handoff court, session fraîche recommandée]`

## Définition de « fini »

demande littérale traitée · scope creep évité · vérification ciblée · non-vérifié listé ·
changelog à jour · commit fait · handoff court produit.

<!-- pmz:rules:end -->
