# AGENTS.md — socle Vibe Session Governor (Codex)

Instructions persistantes pour agents de code (Codex et compatibles). Même socle de règles que
côté Claude Code, sans les hooks (que Codex ne gère pas).

## Objectif
Travailler par petits lots avec consommation minimale de contexte.

## Avant de modifier
- Utiliser `git status`, `git diff`, `git grep` avant de lire de gros fichiers.
- Lire uniquement les fichiers nécessaires ; ne pas scanner tout le repo.
- Ne pas élargir le périmètre sans demande explicite.

## Pendant le travail
- Modifier le moins de fichiers possible ; respecter les conventions existantes.
- Ne pas ajouter de dépendance sans justification.
- Pas de commande destructive (`rm -rf`, `git reset --hard`, `git clean -fd`…) sans confirmation.

## Vérification
- Vérifier uniquement ce qui a changé (UI : rendu/test ciblé ; API : test endpoint/unitaire ;
  contenu : cohérence + rendu si applicable).

## Fin de lot
- Mettre à jour `CHANGELOG.md`, faire un commit court (français), produire un handoff court.

## Définition de « fini »
demande traitée · scope creep évité · preuve ciblée · non-vérifié listé · changelog à jour ·
commit fait · handoff court.
