# Promptimizer (PMZ)

Système local de gouvernance pour sessions de **vibecoding**, conçu pour **Claude Code
desktop** (macOS). Il s'installe une fois, s'active automatiquement sur tous les projets, et
poursuit trois objectifs :

1. **Économie de contexte** — alerte sur l'occupation réelle du contexte (tokens) par paliers,
   et sur le **coût du dernier tour** (tour à +50k tokens, invalidations de cache), via un
   message visible **non bloquant** et **non réinjecté** dans le contexte du modèle.
2. **Clôture propre des lots** — rappelle vérification ciblée + `CHANGELOG` + commit + handoff ;
   le handoff est écrit dans `.vibe-agent/handoff.md` (auto à chaque fin de tour, riche via
   `/fresh-session`) et **injecté automatiquement au démarrage de la session suivante**.
   Une grosse demande peut être **lotie** (`/pmz-scope`) en un plan de 2-5 lots persistant
   (`.vibe-agent/backlog.json`) : chaque lot est clos automatiquement au commit, le suivant
   est annoncé, et le plan survit aux sessions comme à la compaction.
3. **Initialisation prudente des projets** — propose de créer `CLAUDE.md` / `AGENTS.md` /
   `.vibe-agent/` / `CHANGELOG.md`, **uniquement après ta confirmation**, jamais d'écrasement.
   Sur un **projet en cours** qui a déjà ces fichiers, `/pmz-init` ajoute la section « Règles
   Promptimizer » taguée en fin de fichier (append-only, idempotent, réversible).

Il fournit aussi un **delta Codex** (`AGENTS.md`) pour porter le même socle de règles.

## Installation

1. Double-clique sur `promptimizer/install/install.command`.
   _(1re fois : si macOS bloque, clic droit → Ouvrir, ou retire la quarantaine —
   `xattr -dr com.apple.quarantine promptimizer`.)_
   L'installeur copie le package dans `~/.claude/`, **sauvegarde** ton `settings.json`, fusionne
   les hooks **sans rien écraser**, et te **propose** de laisser PMZ reprendre le rôle d'un
   éventuel hook `Stop` existant (réversible).
2. Vérifie avec `promptimizer/install/pmz-doctor.command`.

Aucun `sudo` n'est demandé.

## Vérification

```
Promptimizer — diagnostic

Claude settings : OK
Hooks globaux : OK
Skill globale : OK
Scripts exécutables : OK
Projet courant : initialisé / non initialisé

Statut : vert
```

## Comportement dans Claude Code

- **Au démarrage** d'un projet initialisé : court rappel des priorités.
- **Projet non initialisé** (repo git) : PMZ **propose** l'initialisation ; rien n'est écrit sans
  ton accord.
- **Pendant la session** : confirmation demandée avant une commande destructive
  (`git reset --hard`, `rm -rf <dossier>`…) ; les commandes catastrophiques sont bloquées. Les
  lectures/éditions normales ne sont **pas** ralenties (respect de `acceptEdits`).
- **En fin de tour** : alerte de coût aux paliers de contexte et sur le **coût du dernier tour**
  (tour à +50k tokens ; cache invalidé après une pause vs en plein tour) ; rappel de clôture si un
  lot est ouvert sans commit ; si un plan de lots existe, le lot en cours est **clos automatiquement
  au commit** et le suivant annoncé.
- **Pendant le tour** : une relecture **complète** d'un gros fichier (≥ 16 Ko) déjà lu et
  inchangé déclenche une note discrète (~60 tokens, plafonnée à 1×/fichier et 3×/session) —
  jamais de blocage, juste un rappel.
- **Occupation déjà haute** : au-delà de 500k tokens, un rappel court (2 lignes) est ajouté au
  prompt suivant (plafonné 1×/palier) ; à la **reprise** d'une session déjà chargée (≥ 300k),
  un message visible (zéro token ajouté au contexte) le signale sans attendre la fin du tour.
- **Plan de lots durable** : `.vibe-agent/backlog.json` est versionné par défaut (un
  `.vibe-agent/.gitignore` ignore l'état éphémère mais garde le plan), et stagé à chaque écriture —
  il ne se perd plus entre deux sessions.
- **Après un `/clear` ou une compaction** : le handoff (ou le lot en cours) est réinjecté —
  le plan ne se perd pas.

## Slash commands (secours)

`/pmz-init` · `/pmz-scope` · `/budget` · `/check-context` · `/close-batch` · `/fresh-session`

`/budget` et `/check-context` chiffrent leur statut vert/orange/rouge en **tokens réels**
(occupation courante du contexte + gaspillage de relecture), avec repli annoncé sur le comptage
de relectures quand l'occupation token n'est pas encore connue.

_Après une mise à jour du package, relance `install.command` puis redémarre Claude Code :
les matchers de hooks ne s'appliquent qu'à la réinstallation._

## Pause / désactivation

- **Mettre PMZ en pause** sans désinstaller : exporte `PMZ_DISABLE=1` dans l'environnement
  d'où tu lances Claude Code — chaque hook sort immédiatement (`exit 0`) en première ligne.
  Retire la variable pour réactiver.
- **Couper juste la note de relecture redondante** (le reste de PMZ continue de tourner) :
  `PMZ_NO_ADVISORY=1`.
- Les hooks sont chargés au **démarrage** de Claude Code : après (dés)installation, **redémarre**
  l'app pour appliquer les changements.

## Désinstallation

Double-clique sur `promptimizer/install/uninstall.command` (retire **uniquement** les
hooks PMZ, propose de restaurer l'ancien hook, ne touche jamais à tes projets).

## Pour les contributeurs

Ce dépôt est la **source** du package. Voir [CLAUDE.md](CLAUDE.md) (règles) et
[ARCHITECTURE.md](ARCHITECTURE.md) (contrat technique). Spec d'origine dans [`mwn/`](mwn/).
