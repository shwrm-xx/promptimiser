<!-- pmz:rules:start -->
## Règles Promptimizer (PMZ)

- Économie de contexte d'abord : `git status`/`git diff`/`git grep` et lecture partielle
  avant tout Read complet ; ne jamais relire un fichier inchangé.
- Un lot = demande littérale, vérification ciblée de ce qui a changé, `CHANGELOG.md` à jour,
  un commit (français, court).
- Début de session : si `.vibe-agent/handoff.md` existe, le prendre comme point de départ.
- Lot terminé : handoff court écrit dans `.vibe-agent/handoff.md`, puis session fraîche.
<!-- pmz:rules:end -->
