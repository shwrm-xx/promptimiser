# CLAUDE.md — règles projet

Ce fichier doit rester court : il est chargé à chaque session.

## Projet
À compléter par Claude avec lecture minimale.

<!-- pmz:rules:start -->
## Priorité 1 — économie de contexte
- Ne pas relire un fichier déjà lu s'il n'a pas changé.
- Préférer `git diff`, `git status`, `git grep`, lectures partielles et résumés locaux.
- Éviter les sessions longues.
- Un lot terminé doit produire un handoff court écrit dans `.vibe-agent/handoff.md`,
  puis une session fraîche (le handoff y est injecté automatiquement au démarrage).

## Priorité 2 — qualité de lot
- Coller à la demande littérale.
- Ne pas ajouter de feature bonus.
- Vérifier uniquement ce qui a changé.
- Mettre à jour `CHANGELOG.md`.
- Un lot = un commit.

## Définition de « fini »
- demande traitée ;
- preuve ciblée ;
- erreurs ou zones non vérifiées listées ;
- changelog à jour ;
- commit fait ;
- handoff court produit.
<!-- pmz:rules:end -->
