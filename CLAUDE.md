# CLAUDE.md — dépôt `promptimiser` (source de Promptimizer)

Ce dépôt **n'est pas une app** : c'est la **source** du package **Promptimizer (PMZ)**,
un système Claude Code de gouvernance de sessions vibecoding. Réponds en français.

## Ce qu'est ce dépôt

L'arborescence reflète **en miroir plat** la cible d'installation `~/.claude/` :

| Source (ce dépôt)                  | Cible après install                       |
|------------------------------------|-------------------------------------------|
| `promptimizer/`           | `~/.claude/promptimizer/`        |
| `skills/promptimizer/`    | `~/.claude/skills/promptimizer/` |
| `promptimizer/commands/`  | `~/.claude/commands/`                     |

`promptimizer/install/install.command` résout sa propre position et déploie vers
`~/.claude/`. La spec d'origine est dans `mwn/` ; l'architecture vivante est dans
[ARCHITECTURE.md](ARCHITECTURE.md) (source de vérité pour le contrat des hooks).

## Règles de travail

- **Zéro dépendance externe** : tous les scripts Node n'utilisent que la stdlib (`fs`, `path`,
  `os`, `child_process`). Pas de `package.json` runtime, pas de `npm install`.
- **Fail-open absolu** : un hook ne doit JAMAIS casser une session. Erreur/timeout/JSON invalide
  → `exit 0` silencieux. Jamais d'`exit 2`. En cas de doute → `allow`.
- **Zéro secret** : aucune clé dans le dépôt.
- **macOS / `sh`** : les `.command` sont en `#!/bin/bash` ; les chemins sont toujours entre
  guillemets (espaces). Ne pas dépendre de `rg` (utiliser `git grep`/`grep`).
- **Préserver l'existant utilisateur** : la fusion de `~/.claude/settings.json` est
  append-only, taguée, idempotente et réversible (backup). Ne jamais écraser `permissions`,
  `statusLine`, `enabledPlugins`, ni un hook tiers.

## Discipline de dépôt

Un lot de retours = une entrée datée dans [CHANGELOG.md](CHANGELOG.md) + un commit (français :
résumé + puces). Tenir [README.md](README.md) et [ARCHITECTURE.md](ARCHITECTURE.md) à jour à
chaque lot. Vérifier les scripts en **bac à sable** (dossier temp) avant d'annoncer « fait » ;
ne jamais toucher au `~/.claude` réel sans demande explicite.

**Tests** : `node test/run-tests.js` (zéro-dépendance, bac à sable auto, exit 0 si tout passe) —
couvre fail-open, verdicts `pre-tool-use`, occupation, `merge-settings`, bootstrap. À lancer
avant tout commit touchant `lib/`, `hooks/` ou `install/`.
