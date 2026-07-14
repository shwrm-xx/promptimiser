# Bienvenue sur Promptimizer (PMZ)

PMZ est un système local qui s'installe une fois dans **Claude Code desktop** et qui, ensuite,
s'active automatiquement sur tous tes projets. Il t'aide à :

- **suivre le coût réel** de tes sessions (contexte, tours chers) sans rien t'imposer ;
- **clôturer proprement** un lot de travail (vérif → changelog → commit → handoff) ;
- **initialiser prudemment** un nouveau projet, seulement si tu le demandes.

Rien n'écrase jamais tes fichiers sans confirmation, et PMZ peut être mis en pause ou désinstallé
à tout moment (voir en bas de ce guide).

## 1. Ce qu'on t'a transmis

Tu as reçu soit :
- **le dépôt complet** (`git clone` ou dossier `promptimiser/`) → utilise ce guide tel quel ;
- **juste le dossier plugin** (`dist/marketplace/`, zip ou dépôt séparé) → passe directement à la
  section **1b**, tu n'as pas besoin du reste du dépôt.

### 1a. Installation manuelle (depuis le dépôt complet)

Prérequis : **Node.js** installé.

1. Lance l'installeur selon ton OS :
   - **macOS** — double-clic sur `promptimizer/install/install.command`
     _(si Gatekeeper bloque : clic droit → Ouvrir, ou `xattr -dr com.apple.quarantine promptimizer`)_
   - **Linux** — `bash promptimizer/install/install.sh`
   - **Windows** — `promptimizer/install/install.ps1` (PowerShell)
2. Vérifie avec `pmz-doctor.command` / `.sh` / `.ps1` — tu dois voir `Statut : vert`.

Aucun `sudo` n'est demandé. L'installeur copie PMZ dans `~/.claude/` et **sauvegarde** ton
`settings.json` existant avant de fusionner ses hooks (rien n'est écrasé).

### 1b. Installation en plugin Claude Code (recommandé)

Si tu as le dossier `dist/marketplace/` (ou son dépôt git) :

```
claude plugin marketplace add <chemin-ou-repo-vers-dist/marketplace>
claude plugin install pmz@pmz-local
```

Vérifie avec `claude plugin details pmz` : tu dois voir **6 hooks** et **7 commandes**
namespacées `/pmz:*` (ex. `/pmz:about`).

Si tu as le dépôt complet et préfères ce canal, génère d'abord le dossier plugin :

```
node promptimizer/install/build-plugin.js
claude plugin marketplace add dist/marketplace
claude plugin install pmz@pmz-local
```

Ce canal gère les mises à jour et le versioning nativement — c'est le canal recommandé pour
toute nouvelle installation.

## 2. Ce qui change dans Claude Code au quotidien

- **Au démarrage** d'un projet déjà initialisé : court rappel des priorités.
- **Projet non initialisé** : PMZ **propose** de créer `CLAUDE.md` / `CHANGELOG.md` /
  `.vibe-agent/` — rien n'est écrit sans ton accord.
- **Commande destructive** (`git reset --hard`, `rm -rf`…) : confirmation demandée ; les
  commandes catastrophiques sont bloquées. Les lectures/éditions normales ne sont pas ralenties.
- **Fin de tour** : alerte de coût si le contexte ou le dernier tour deviennent chers ; rappel de
  clôture si un lot est ouvert sans commit.
- **Grosse demande** : `/pmz:scope` la découpe en 2-5 lots persistants, avec une préconisation de
  modèle par lot — le plan survit aux sessions et aux compactions.

## 3. Commandes utiles

`/pmz:init` · `/pmz:scope` · `/budget` · `/check-context` · `/close-batch` · `/fresh-session` ·
`/pmz:about`

`/pmz:about` affiche la version installée et le lot en cours du projet. `/budget` et
`/check-context` chiffrent ton statut (vert/orange/rouge) en tokens réels.

## 4. Mettre en pause ou désinstaller

- **Pause sans désinstaller** : `export PMZ_DISABLE=1` dans l'environnement de lancement de
  Claude Code — chaque hook sort immédiatement. Retire la variable pour réactiver.
- **Couper juste les notes de relecture redondante** : `PMZ_NO_ADVISORY=1`.
- **Désinstaller** (canal manuel) : `promptimizer/install/uninstall.command` / `.sh` / `.ps1` —
  retire uniquement les hooks PMZ, ne touche jamais à tes projets.
- Les hooks se chargent au **démarrage** de Claude Code : redémarre l'app après toute
  (dés)installation ou mise à jour.

## 5. Pour aller plus loin

- [README.md](README.md) — détail complet des deux canaux d'installation et de diffusion.
- [ARCHITECTURE.md](ARCHITECTURE.md) — contrat technique des hooks, pour qui veut comprendre ou
  contribuer.

Une question, un comportement inattendu ? Remonte-le à la personne qui t'a transmis ce package.
