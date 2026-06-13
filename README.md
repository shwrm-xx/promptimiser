# Vibe Session Governor (VSG)

Système local de gouvernance pour sessions de **vibecoding**, conçu pour **Claude Code
desktop** (macOS). Il s'installe une fois, s'active automatiquement sur tous les projets, et
poursuit trois objectifs :

1. **Économie de contexte** — alerte sur l'occupation réelle du contexte (tokens) par paliers,
   via un message visible **non bloquant** et **non réinjecté** dans le contexte du modèle.
2. **Clôture propre des lots** — rappelle vérification ciblée + `CHANGELOG` + commit + handoff.
3. **Initialisation prudente des projets** — propose de créer `CLAUDE.md` / `AGENTS.md` /
   `.vibe-agent/` / `CHANGELOG.md`, **uniquement après ta confirmation**, jamais d'écrasement.

Il fournit aussi un **delta Codex** (`AGENTS.md`) pour porter le même socle de règles.

## Installation

1. Double-clique sur `vibe-session-governor/install/install.command`.
   _(1re fois : si macOS bloque, clic droit → Ouvrir, ou retire la quarantaine —
   `xattr -dr com.apple.quarantine vibe-session-governor`.)_
   L'installeur copie le package dans `~/.claude/`, **sauvegarde** ton `settings.json`, fusionne
   les hooks **sans rien écraser**, et te **propose** de laisser VSG reprendre le rôle d'un
   éventuel hook `Stop` existant (réversible).
2. Vérifie avec `vibe-session-governor/install/vsg-doctor.command`.

Aucun `sudo` n'est demandé.

## Vérification

```
Vibe Session Governor — diagnostic

Claude settings : OK
Hooks globaux : OK
Skill globale : OK
Scripts exécutables : OK
Projet courant : initialisé / non initialisé

Statut : vert
```

## Comportement dans Claude Code

- **Au démarrage** d'un projet initialisé : court rappel des priorités.
- **Projet non initialisé** (repo git) : VSG **propose** l'initialisation ; rien n'est écrit sans
  ton accord.
- **Pendant la session** : confirmation demandée avant une commande destructive
  (`git reset --hard`, `rm -rf <dossier>`…) ; les commandes catastrophiques sont bloquées. Les
  lectures/éditions normales ne sont **pas** ralenties (respect de `acceptEdits`).
- **En fin de tour** : alerte de coût aux paliers de contexte ; rappel de clôture si un lot est
  ouvert sans commit.

## Slash commands (secours)

`/vsg-init` · `/budget` · `/check-context` · `/close-batch` · `/fresh-session`

## Désinstallation

Double-clique sur `vibe-session-governor/install/uninstall.command` (retire **uniquement** les
hooks VSG, propose de restaurer l'ancien hook, ne touche jamais à tes projets).

## Pour les contributeurs

Ce dépôt est la **source** du package. Voir [CLAUDE.md](CLAUDE.md) (règles) et
[ARCHITECTURE.md](ARCHITECTURE.md) (contrat technique). Spec d'origine dans [`mwn/`](mwn/).
