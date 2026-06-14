# Changelog

Toutes les évolutions notables de ce dépôt. Format inspiré de Keep a Changelog.

## [0.4.4] — 2026-06-14

AGENTS.md enrichi — équivalent textuel des hooks PMZ pour Codex.

- `codex/AGENTS.md` réécrit (136 lignes) : 8 sections couvrant démarrage de session,
  économie de contexte, surveillance auto-déclarative des paliers (≈150k/300k/500k tokens),
  détection demande large, sûreté Bash, protocole de clôture complet, session fraîche,
  initialisation de projet, définition de « fini ».
- `promptimizer/templates/AGENTS.md` (template projet) mis à jour dans le même esprit,
  version condensée pour les dépôts applicatifs.

## [0.4.3] — 2026-06-14

Contournement Gatekeeper dans le zip d'export.

- `package.command` génère `debloquer.command` à la racine du zip : retire `com.apple.quarantine`
  sur tout le dossier en un double-clic (ou clic droit → Ouvrir si Gatekeeper bloque même lui).
- Ajout `LIRE-MOI.txt` à la racine : procédure en 3 étapes clairement numérotées.
- Zip compilé avec `-X` (sans attributs étendus) pour limiter la propagation de quarantine.

## [0.4.2] — 2026-06-14

Delta Codex exportable.

- **`codex/install-codex.command`** : installe `~/.codex/AGENTS.md` + wrapper `~/bin/pmz-codex`
  (optionnel), avec backup de l'existant et vérif PATH. Double-clic macOS.
- **`package.command`** mis à jour : inclut `codex/` dans le zip + mentionne les deux installeurs.

## [0.4.1] — 2026-06-14

Script d'export autonome.

- **`promptimizer/install/package.command`** : génère un `.zip` daté sur le Bureau
  contenant `promptimizer/` + `skills/promptimizer/` — prêt à transférer sur un autre Mac.
  L'archive est autonome (pas de Git requis) ; décompresser → double-clic `install.command`.

## [0.4.0] — 2026-06-14

Lot 5 de l'audit : items différés (robustesse fail-open, install, portabilité).

### Fail-open renforcé
- **Préambule** `process.on('uncaughtException'/'unhandledRejection', exit 0)` placé **avant tout
  `require`** dans les 5 hooks : même un `require` qui échoue (module corrompu/absent) sort en
  `exit 0` (la fenêtre du `require('guard')` n'était pas protégée). Couvert par un test (guard.js
  corrompu → exit 0).
- Watchdog `setTimeout(...).unref()` : filet de sécurité, plus facteur de latence.
- Délais **centralisés** dans `lib/timeouts.js` (source unique) — fin de la dérive possible entre
  le timeout `settings.json` (10/5 s) et le watchdog interne (9500/4500 ms, marge 500 ms).

### Install / désinstall
- `install.command` **purge les fichiers obsolètes** d'une version précédente avant copie
  (un `cp -R` fusionnait sans supprimer) — **préserve `state/`** (sidecar de prise de relais).
- `uninstall.command` : garde explicite si `node` est absent (plus de faux « retiré » silencieux).
- `xattr` (déquarantaine) étendu à la skill et aux commands, et gardé par `command -v xattr`.

### Portabilité
- Hooks câblés en **chemin absolu** dans `settings.json` (plus de dépendance à l'expansion du `~`).
- `git` résolu en **chemin absolu** (`resolveTool`) — même angle mort PATH que `node` sous les
  apps GUI macOS.

### Sûreté Bash (résidu Lot 2)
- `find -delete`, `xargs … rm`, `curl|wget … | sh` désormais **ancrés en position de commande** :
  un message de commit mentionnant ces motifs en prose ne déclenche plus de `ask`.

### Tests
- Harnais étendu à **107 assertions** (préambule fail-open sur module corrompu, cohérence des
  timeouts, non-régression prose `find`/`xargs`/`curl`).

## [0.3.0] — 2026-06-14

Lots 2-3-4 de l'audit : sûreté Bash, robustesse logique cœur, UX, fonctions mortes, tests.

### Sûreté commandes Bash (`pre-tool-use.js`)
- Détection `rm` récursive **robuste** (ordre des flags indifférent : `-rf`, `-fr`, `-r -f`,
  `--recursive --force`) ; catastrophique réservé aux cibles racine/home « nues » (`/`, `/*`,
  `~`, `$HOME`), le reste des `rm` récursifs passe en `ask`.
- Nouveaux `deny` : devices macOS (`> /dev/disk|rdisk|sd…`). Nouveaux `ask` : `curl|wget … | sh`,
  `find … -delete`, `xargs … rm`, écrasement de fichier système (`> /etc|usr|bin…`),
  `mv … /dev/null`.
- Faux positifs corrigés : `truncate` ancré en tête de commande (plus de friction sur
  `grep truncate`/`npm run truncate-x`) ; `git push --force-with-lease` (variante sûre) **autorisé**.

### Robustesse logique cœur
- `occupancy` : lecture du transcript par **fenêtre croissante** (512 KB → 2 MB → 8 MB) pour ne
  pas rater une ligne `usage` repoussée par de gros `tool_result` ; palier persisté **monotone
  croissant** (plus de réarmement d'alerte sur une ligne `usage` « maigre »).
- `ledger`/`state` : écriture atomique mutualisée dans **`lib/fsjson.js`** avec `tmp` **unique**
  (pid + horodatage) → plus de course entre `PostToolUse` concurrents.

### UX & fonctions mortes
- Rappel `SessionStart` (`MSG_ACTIF`) : **anti-spam 1×/session**, plus de réinjection au
  `resume`/`compact` (économie de contexte à la reprise).
- Alerte de palier : repère **relatif au plafond** (« prochain palier ~Xk ») au lieu de
  « palier N » brut.
- Compteur de tours **mort** retiré (`turn_count_estimate`, `fresh_session_recommended`) — le
  signal d'occupation par tokens le remplace.
- `MSG_LECTURE` (jamais émis) désormais **émis dans le rappel de clôture** avec la liste des
  relectures évitables du lot (issue du context-ledger).

### Maintenabilité & doc
- `parseCwd` dédupliqué (5 scripts → **`lib/cli.js`**) ; `writeAtomic`/`readJson` → `lib/fsjson.js`.
- **`test/run-tests.js`** : harnais zéro-dépendance (95 assertions) — fail-open, verdicts Bash,
  occupation, `merge-settings`, bootstrap. `test/run-tests.command` pour double-clic.
- `ARCHITECTURE.md` corrigé (restauration depuis le **sidecar**, pas le backup ; node absolu ;
  occupation par blocs/monotone) ; README documente le kill-switch `PMZ_DISABLE`.

## [0.2.0] — 2026-06-14

Lot 1 de l'audit multi-dimensions (43 pistes confirmées) : bug actif + correctifs critiques.

### Corrigé
- **Double-firing des hooks** : après un renommage du paquet, `merge-settings.js` ne purgeait
  que le tag courant et laissait les entrées orphelines de l'ancien nom (10 hooks au lieu de 5,
  5 pointant vers des fichiers supprimés). `stripVsg()` reconnaît désormais les tags hérités
  (`PMZ_TAGS` = courant + `vibe-session-governor/hooks/`).
- **`node` introuvable (exit 127)** : les hooks étaient câblés en `node` nu ; sous un PATH épuré
  (apps GUI macOS), node n'était pas trouvé et le garde fail-open ne s'exécutait jamais. Le chemin
  absolu est désormais figé à l'install, résolu vers un **symlink stable** (`/opt/homebrew/bin/node`)
  plutôt que le chemin versionné `process.execPath` (qui casserait à chaque `brew upgrade node`).
- **Collision de backup** : deux runs dans la même seconde écrasaient le backup précédent
  (suffixe `-1`, `-2`… désormais) ; le backup est chmodé `0600`.
- **Sidecar de prise de relais corrompu** : `--remove` avalait silencieusement l'échec et ne
  restaurait pas `context-guard.py` ; il **signale** désormais la corruption.
- **Wrapper Codex cassé** : `codex/codex-vsg` pointait vers les chemins `vibe-session-governor`
  périmés → renommé `pmz-codex`, chemins corrigés vers `~/.claude/promptimizer/`.
- **Résidus de nommage** : `.gitignore` (`*.pmz-backup-*`), `rules.yaml` (template + dogfood :
  `rg_search` → `git_grep`, `name: promptimizer`), message `pre-tool-use` (`(PMZ)` → `Promptimizer`).

## [0.1.0] — 2026-06-13

### Ajouté
- Socle du dépôt : `CLAUDE.md`, `README.md`, `ARCHITECTURE.md`, `.gitignore`, `git init`.
- Package **Promptimizer** (source en miroir plat de `~/.claude/`) :
  - `lib/` : socle Node zéro-dépendance (stdin, output, project, ledger, occupancy, state,
    messages, env).
  - `hooks/` : `session-start`, `user-prompt-submit`, `pre-tool-use`, `post-tool-use`, `stop`
    (fail-open absolu, kill-switch `PMZ_DISABLE`).
  - `scripts/` : `detect-project`, `bootstrap-project`, `audit-context`, `audit-batch`,
    `close-batch`.
  - `templates/` : socle projet (`CLAUDE.md`, `AGENTS.md`, `rules.yaml`, ledgers, handoff…).
  - `skills/promptimizer/SKILL.md` + slash commands (`pmz-init`, `budget`,
    `check-context`, `close-batch`, `fresh-session`).
  - `install/` : `merge-settings.js`, `install.command`, `uninstall.command`,
    `pmz-doctor.command` (backup, fusion idempotente réversible, sans `sudo`).
  - `codex/` : delta `AGENTS.md` + wrapper `pmz-codex` + notes.

### Ajustements vs spec (`mwn/`)
- Budget contexte via **occupation réelle par tokens** (paliers + `systemMessage`) au lieu du
  compteur de tours — PMZ reprend à son compte la méthode de `context-guard.py`.
- Hook `Stop` **non bloquant** ; l'installeur propose la **prise de relais réversible** de
  `context-guard.py`.
- `PreToolUse` centré `Bash` (respect du mode `acceptEdits`) ; bootstrap **après confirmation** ;
  recommandations `git grep`/`grep` au lieu de `rg`.
