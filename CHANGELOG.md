# Changelog

Toutes les évolutions notables de ce dépôt. Format inspiré de Keep a Changelog.

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
