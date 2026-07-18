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
   Une grosse demande peut être **lotie** (`/scope`) en un plan de 2-5 lots persistant
   (`.vibe-agent/backlog.json`), **chaque lot portant une préconisation de modèle**
   (`sonnet`/`opus`, réaffichée à chaque `show`/`start` et dans le handoff) : chaque lot est
   clos automatiquement au commit, le suivant est annoncé, et le plan survit aux sessions
   comme à la compaction.
3. **Initialisation prudente des projets** — propose de créer `CLAUDE.md` / `AGENTS.md` /
   `.vibe-agent/` / `CHANGELOG.md`, **uniquement après ta confirmation**, jamais d'écrasement.
   Sur un **projet en cours** qui a déjà ces fichiers, `/init` ajoute la section « Règles
   Promptimizer » taguée en fin de fichier (append-only, idempotent, réversible).

Il fournit aussi un **delta Codex** (`AGENTS.md`) pour porter le même socle de règles.

## Installation

1. Lance l'installeur selon ton OS (prérequis : **Node.js**) :
   - **macOS** — double-clic `promptimizer/install/install.command`
   - **Linux** — `bash promptimizer/install/install.sh`
   - **Windows** — `promptimizer/install/install.ps1` (PowerShell)

   _(macOS 1re fois : si Gatekeeper bloque, clic droit → Ouvrir, ou retire la quarantaine —
   `xattr -dr com.apple.quarantine promptimizer`. Ce premier lancement active aussi un hook
   git local — `.githooks/post-merge` — qui lève automatiquement la quarantaine sur les
   `.command` du dépôt après chaque `git pull` : le popup ne revient plus.)_
   Toute la logique vit dans `install.js` (stdlib Node, cross-platform) ; les lanceurs
   `.command`/`.sh`/`.ps1` ne font que trouver `node` et l'appeler. L'installeur copie le
   package dans `~/.claude/` (ou `$CLAUDE_CONFIG_DIR`), **sauvegarde** ton `settings.json`,
   fusionne les hooks **sans rien écraser**, et te **propose** de laisser PMZ reprendre le rôle
   d'un éventuel hook `Stop` existant (réversible).
2. Vérifie avec `pmz-doctor.command` / `pmz-doctor.sh` / `pmz-doctor.ps1`.

Aucun `sudo` n'est demandé.

### Installation en plugin Claude Code (alternatif)

PMZ peut aussi s'installer comme **plugin Claude Code natif** (updates/versioning gérés par
Claude Code). Le dossier plugin est **assemblé** depuis la source :

```
node promptimizer/install/build-plugin.js
claude plugin marketplace add dist/marketplace
claude plugin install pmz@pmz-local
```

Vérification : `claude plugin details pmz` (doit afficher **6 hooks** et les
**8 commandes** ; commandes namespacées `/pmz:*`, ex. `/pmz:about`, `/pmz:scope`). Le nom du
plugin (identifiant technique, pilote le namespace des commandes) est `pmz` ; l'identité
« Promptimizer » reste le nom du projet/produit (description, branding). **Distribution à un tiers**
(entreprise, équipe, communauté) : partager le dossier `dist/marketplace/` (ou un dépôt git
privé) et `marketplace add` en local — zéro réseau externe requis. Pour que chaque poste n'ait
pas à relancer `marketplace add` à la main, référencer la marketplace dans `settings.json`
(user ou projet) via `extraKnownMarketplaces` :

```json
{
  "extraKnownMarketplaces": {
    "pmz-interne": {
      "source": { "source": "git", "repo": "https://exemple-git-interne/pmz-marketplace.git" }
    }
  }
}
```

(`source` peut aussi être `"github"` ou un chemin local — cf. doc officielle marketplace Claude
Code.)

**Canal GitHub public.** Prérequis : le dépôt doit être **public** (la commande
`marketplace add owner/repo` de Claude Code lit le dépôt sans authentification). Côté mainteneur,
publier l'artefact de build sur la branche orpheline `plugin-release` :

```
node promptimizer/install/publish-plugin.js --push
```

(le script assemble `dist/marketplace/` via `build-plugin.js` puis pousse son contenu seul sur
`plugin-release` — la branche ne partage aucun historique avec `main`). Côté utilisateur final :

```
claude plugin marketplace add shwrm-xx/promptimiser@plugin-release
claude plugin install pmz@pmz-marketplace
```

Les deux canaux (manuel / plugin) sont détaillés dans [ARCHITECTURE.md](ARCHITECTURE.md) ; le
verdict de faisabilité dans [docs/decisions/D1-plugin-go-nogo.md](docs/decisions/D1-plugin-go-nogo.md).

**Migration depuis une install manuelle existante** : `node promptimizer/install/migrate-to-plugin.js`
retire les hooks PMZ legacy de `settings.json` (réutilise `merge-settings.js --remove`, restaure
un éventuel sidecar de prise de relais) pour éviter le double-firing, puis affiche les commandes
d'install du plugin (`--purge` supprime aussi les fichiers PMZ legacy, conservés par défaut).
`doctor.js` détecte et signale une double installation (plugin + canal manuel non retiré).

**Canal manuel : legacy, gelé.** Les lanceurs `install.command`/`.sh`/`.ps1` (et
`uninstall.*`/`pmz-doctor.*`) restent fonctionnels et maintenus a minima, mais le plugin est le
canal recommandé pour toute nouvelle installation — plus d'updates/versioning natifs, plus de
fusion de `settings.json`.

## Vérification

Le doctor reconnaît le **canal** utilisé. En **plugin** (hooks fournis par le plugin, pas par
`settings.json`) :

```
Promptimizer — diagnostic

Version installée : 1.0.0
Claude settings : OK
Canal : plugin
Hooks / skill / commandes : fournis par le plugin
Scripts exécutables : OK
Projet courant : initialisé / non initialisé

Statut : vert
```

En **canal manuel**, les lignes détaillent `Hooks globaux` / `Skill globale`. Un statut
`plugin + manuel (CONFLIT)` signale une double installation à résoudre (`migrate-to-plugin.js`).
Sous le plugin, la santé se lit aussi via `claude plugin details pmz` (le doctor CLI n'est pas
embarqué dans le plugin ; lance-le depuis le dépôt : `node promptimizer/install/doctor.js`).

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

`/init` · `/scope` · `/budget` · `/check-context` · `/close-batch` · `/fresh-session` ·
`/about` · `/help` · `/statusline`

`/about` affiche la version installée de PMZ (`promptimizer/VERSION`, historisée dans
`CHANGELOG.md` à chaque évolution) ainsi que l'epic et le lot en cours du projet courant.

`/help` liste toutes les commandes disponibles avec leur description, **dérivée des fichiers
`commands/` réellement installés** (jamais une liste codée en dur) : sur le canal plugin,
`statusline` n'y figure pas (exclue du build, cf. ci-dessous).

`/statusline` **(opt-in, canal manuel)** pose la barre d'état PMZ dans `settings.json` :
`PMZ v<version> · <epic> · lot #<id> <titre> · <faits>/<total> · ctx <occupation>` (occupation
temps réel). Posée **uniquement sur demande explicite** ; **jamais** si une `statusLine` tierce
existe (préservée) ; retrait propre via la même commande (`--statusline-remove`) et à la
désinstallation. Un redémarrage de session peut être nécessaire pour l'affichage.

`/budget` et `/check-context` chiffrent leur statut vert/orange/rouge en **tokens réels**
(occupation courante du contexte + gaspillage de relecture), avec repli annoncé sur le comptage
de relectures quand l'occupation token n'est pas encore connue.

_Après une mise à jour du package, relance l'installeur (`install.command`/`.sh`/`.ps1`) puis
redémarre Claude Code : les matchers de hooks ne s'appliquent qu'à la réinstallation._

## Pause / désactivation

- **Mettre PMZ en pause** sans désinstaller : exporte `PMZ_DISABLE=1` dans l'environnement
  d'où tu lances Claude Code — chaque hook sort immédiatement (`exit 0`) en première ligne.
  Retire la variable pour réactiver.
- **Couper juste la note de relecture redondante** (le reste de PMZ continue de tourner) :
  `PMZ_NO_ADVISORY=1`.
- Les hooks sont chargés au **démarrage** de Claude Code : après (dés)installation, **redémarre**
  l'app pour appliquer les changements.

## Désinstallation

Lance `promptimizer/install/uninstall.command` (macOS) / `uninstall.sh` (Linux) /
`uninstall.ps1` (Windows) — retire **uniquement** les hooks PMZ, propose de restaurer l'ancien
hook, ne touche jamais à tes projets.

## Déclinaison OpenCode (en cours — epic « PMZ OpenCode »)

PMZ se décline pour [OpenCode](https://opencode.ai) : plugin + commandes `/pmz`, libs cœur
partagées (backlog, handoff, ledgers), état projet `.vibe-agent/` **commun** aux deux outils.
Install : `node opencode/install/install-opencode.js` (cible `~/.config/opencode`, option
`--target` pour un bac à sable) ; diagnostic : `doctor-opencode.js` ; retrait :
`uninstall-opencode.js`. Doctrine, mapping des hooks et gaps assumés (statusline) :
[`opencode/NOTES.md`](opencode/NOTES.md). État : lot OC3 — sûreté Bash + ledgers (OC2) ;
occupation **relative à la fenêtre du modèle** (paliers 50/70/85/95 %, toasts aux
franchissements), équivalent Stop à `session.idle` (auto-clôture + handoff), injection
différée au (re)démarrage et renommage de session. Restent au lot OC4 : commandes
`budget`/`scope`/`close-batch`, `model_hint` locaux et bump de version.

## Pour les contributeurs

Ce dépôt est la **source** du package. Voir [CLAUDE.md](CLAUDE.md) (règles) et
[ARCHITECTURE.md](ARCHITECTURE.md) (contrat technique). Spec d'origine dans [`mwn/`](mwn/).
