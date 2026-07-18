# PMZ pour OpenCode — doctrine du portage

Portage **complet** de Promptimizer vers [OpenCode](https://opencode.ai) (≥ 1.18), epic
« PMZ OpenCode » (lots OC1–OC4, cf. `.vibe-agent/backlog.json`). Pendant du delta `codex/`,
mais ici on porte **tout** : hooks, commandes, budget de contexte, clôture de lots.

## Principes (hérités du dépôt, non négociables)

- **Fail-open absolu** : le loader rend `{}` à la moindre erreur ; chaque handler est
  enveloppé dans `bridge.guard()` (erreur avalée + journalisée). Un hook ne casse JAMAIS
  une session. Kill-switch : `PMZ_DISABLE=1`.
- **Zéro dépendance externe** : Node/Bun stdlib uniquement. L'implémentation est en CJS
  (`pmz/impl/`), le loader en ESM (format canonique des plugins OpenCode) ; le pont se fait
  par `createRequire` — compatible Bun (runtime embarqué d'OpenCode) et Node ≥ 22.
- **Source unique** : les libs cœur (`backlog`, `handoff`, `ledger`, `bootstrap`…) vivent dans
  `promptimizer/lib` et sont **vendorées par copie** à l'install (jamais de symlink ni de
  require inter-dossiers au runtime).
- **Jamais toucher au vrai `~/.config/opencode`** sans demande explicite : les tests passent
  toujours par `--target <sandbox>` (+ `XDG_CONFIG_HOME`/`XDG_DATA_HOME` pour la preuve de vie).
- L'installer ne modifie **jamais** `opencode.json`, ni un plugin/commande tiers : il ne pose
  que `plugin/pmz.js`, `command/pmz/` et `pmz/`.

## Layout

| Source (dépôt)              | Installé (`<config opencode>`)          |
|-----------------------------|------------------------------------------|
| `opencode/plugin/pmz.js`    | `plugin/pmz.js` (loader fin)             |
| `opencode/plugin/impl/`     | `pmz/impl/` (cœur CJS)                   |
| `promptimizer/lib`,`scripts`,`templates`,`VERSION` | `pmz/lib`, `pmz/scripts`, `pmz/templates`, `pmz/VERSION` (vendorés) |
| `opencode/command/pmz/*.md` | `command/pmz/` (commandes `/pmz`, OC2+)  |
| —                           | `pmz/state/` (journal, anti-spam — **préservé** aux réinstalls, option `--keep-state` à la désinstall) |

L'état **projet** reste `.vibe-agent/` — **partagé** avec Claude Code (backlog et handoff
cross-outil = feature). Règle : jamais deux sessions simultanées (Claude Code + OpenCode)
sur le même projet. Un `model_hint` non résoluble par un côté (« sonnet » vs
« lmstudio/… ») est ignoré silencieusement par ce côté.

## Mapping des hooks (Claude Code → OpenCode)

| PMZ Claude Code | OpenCode | Lot |
|---|---|---|
| session-start (startup/clear) | `event: session.created` → injection différée au 1er `chat.message` + toast | OC3 |
| session-start (compact) | `event: session.compacted` → resync palier + réinjection minimale du lot | OC3 |
| user-prompt-submit | `"chat.message"` (mutation des parts ; nudges init/broad/occupation/model-mismatch) | OC3/OC4 |
| pre-tool-use (garde `rm`) | `"tool.execute.before"` (throw = deny) + `"permission.ask"` pour le tiers destructif | OC2 |
| post-tool-use (ledgers, todo) | `"tool.execute.after"` (read/edit/write/todowrite) | OC2 |
| stop (métrologie, auto-clôture, handoff) | `event: session.idle` (idempotence multi-idle à verrouiller) | OC3 |
| pre-compact | `"experimental.session.compacting"` (+ **filet** `session.compacted` : API experimental) | OC3 |
| renommage session (suggéré seulement) | `client.session.update({ title })` — automatisable | OC3 |
| occupation (transcript `.jsonl`) | event `message.updated` (tokens) + fallback `client.session.messages` à l'idle ; occ = input + cache.read + cache.write | OC3 |
| paliers fixes 150k/300k/500k/750k | paliers **relatifs** 50/70/85/95 % de la fenêtre utile (ctx − output réservé − `reserved` compaction), fenêtres lues dans `opencode.json` | OC3 |
| statusline | **GAP v1 assumé** (pas d'API statusline OpenCode) → toasts aux franchissements + `/pmz/budget` | — |
| merge-settings.json | **inutile** : dépôt de fichiers, rien à fusionner | — |

Point de vigilance pour OC2 : `bridge.guard()` avale les throws — le **deny volontaire**
de `tool.execute.before` devra passer par un chemin explicite hors garde (throw délibéré),
seul cas où un throw est un verdict et non une panne.

Repli documenté si une incompatibilité Bun/CJS apparaissait : shell-out `node` (v26 présent
sur la machine cible) avec le contrat stdin JSON → stdout JSON existant des hooks Claude Code.

## Lot OC1 (ce lot) — squelette instrumenté

Tous les hooks cibles sont branchés en **no-op journalisé** : chaque déclenchement écrit une
ligne JSON dans `pmz/state/plugin.log` (tronqué au-delà de 512 Ko), et `session.created`
affiche un toast « PMZ v<version> actif ». Aucune logique métier encore.

## Preuve de vie réelle (procédure sandbox)

Sans jamais toucher à la vraie config (`XDG_CONFIG_HOME`/`XDG_DATA_HOME` redirigés) :

```bash
SB=$(mktemp -d) && mkdir -p "$SB/config" "$SB/data" "$SB/proj"
node opencode/install/install-opencode.js --target "$SB/config/opencode"
cat > "$SB/config/opencode/opencode.json" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "model": "ollama/qwen3.5:9b",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": { "baseURL": "http://127.0.0.1:11434/v1" },
      "models": { "qwen3.5:9b": { "name": "Qwen 3.5 9B" } }
    }
  },
  "permission": { "edit": "allow", "bash": "allow" }
}
EOF
cd "$SB/proj"
XDG_CONFIG_HOME="$SB/config" XDG_DATA_HOME="$SB/data" \
  ~/.opencode/bin/opencode run "Réponds uniquement OK" </dev/null
cat "$SB/config/opencode/pmz/state/plugin.log"   # attendu : plugin.loaded, event…, chat.message
```

En mode `opencode run` le toast ne s'affiche pas (TUI seulement) : c'est le journal qui fait
foi. Pour voir le toast, lancer `opencode` (TUI) avec les mêmes variables d'environnement.

**Constats du run réel (OpenCode 1.18.3, 2026-07-18)** — preuve de vie passée :
`plugin.loaded` (v1.1.8, chargé par le runtime Bun → compat CJS/`createRequire` prouvée),
`session.created`, `chat.message`, `session.idle`, zéro erreur. Deux pièges consignés :
- `opencode run` **bloque indéfiniment si stdin reste ouvert** en usage scripté → toujours
  `</dev/null`.
- `chat.message` arrive avec `model: null` en 1.18.3 → la vigie model-mismatch (OC3/OC4)
  devra lire le modèle dans `chat.params` (input.model) ou `message.updated`, pas ici.

## Lot OC2 — sûreté Bash, ledgers, commandes socle

- **Détection rm/destructif** extraite en lib partagée `promptimizer/lib/bash-guard.js`
  (`classify(cmd) -> 'deny' | 'ask' | null`, pure, sans I/O) — requise par
  `promptimizer/hooks/pre-tool-use.js` (Claude Code) ET `opencode/plugin/impl/index.js`
  (OpenCode, via `pmz/lib/` vendoré à l'install). Un seul jeu de règles, deux exécuteurs.
- **`tool.execute.before`** (bash uniquement) : le tiers **catastrophique** (`deny`) throw un
  `Error` délibéré — SEUL canal de blocage synchrone qu'offre ce hook. Contrainte : ce hook
  n'est PAS enveloppé par `bridge.guard()` (qui avale les throws) ; sa propre logique interne
  reste défensive (try/catch), seul le throw de deny doit atteindre l'appelant. Le tiers
  **destructif** (`ask`) n'est PAS bloqué ici : pas de canal de confirmation synchrone
  disponible depuis `tool.execute.before` côté SDK OpenCode (`output` ne porte qu'`args`).
- **`permission.ask`** (`input: Permission`, `output: {status}`) : seul point où PMZ peut
  RESSERRER un statut déjà résolu par OpenCode — `allow -> ask` pour le tiers destructif,
  `-> deny` pour le tiers catastrophique (filet, en plus du throw de `tool.execute.before`).
  Ne dégrade jamais un statut déjà strict (`ask`/`deny` restent tels quels). Limite connue,
  non résolue par ce lot : `permission.ask` ne se déclenche que si OpenCode a déjà un contrôle
  de permission actif pour l'appel (config `permission.bash` de l'agent) — avec un bash
  `"allow"` global (cas par défaut constaté sur la machine cible), ce hook ne se déclenche
  jamais pour du bash, et le tiers `ask` n'a donc, en pratique, **aucun filet actif** tant que
  `tool.execute.before` reste le seul filet garanti (catastrophique uniquement). Assumé comme
  gap v1, au même titre que la statusline — à traiter si l'usage réel expose des commandes
  destructives non bloquées.
- **Ledgers** (`tool.execute.after`, tools `read`/`edit`/`write`/`todowrite`) : réutilise tel
  quel `promptimizer/lib/{project,ledger,backlog}.js` — `root = input.directory` fourni par
  OpenCode (pas de `git rev-parse` à refaire, contrairement à Claude Code qui doit dériver son
  `cwd`). Extraction du chemin de fichier **défensive** (`args.filePath || args.path ||
  args.file`) : les noms de champs exacts des tools `read`/`edit`/`write` d'OpenCode ne sont
  pas garantis par le SDK — fail-open pur si le champ attendu est absent (le ledger ne
  s'alimente pas, aucun throw).
- **Commandes `/pmz`** (`opencode/command/pmz/*.md`) : about, help, init, check-context —
  même contenu que `promptimizer/commands/*.md`, chemins réécrits vers
  `~/.config/opencode/pmz/scripts/*.js`. `help.js` généralisé (2 layouts candidats pour
  `CMD_DIR` : `commands/` frère de `scripts/` en Claude Code, `command/pmz/` frère de `pmz/`
  en OpenCode) — un seul script, portable sur les deux canaux.
- Tests : `test/run-tests-opencode.js` 34 → 64 assertions (matrice deny/ask/allow, ledgers
  read/edit/todowrite, fail-open sur payloads malformés, arbo + contenu des 4 commandes,
  `help.js` sous layout OpenCode).

## Hors périmètre / constats d'audit (2026-07-18)

- Statusline : gap v1 (voir mapping). Piste future : binaire externe abonné au flux SSE
  (`event.subscribe`), type ocstatusline.
- Constats sur la config réelle de la machine (à corriger par l'utilisateur, PMZ n'y touche
  pas) : `qwen3.6:latest` déclaré dans `opencode.json` mais seul `qwen3.6:27b` est installé ;
  plugin `opencode-local-provider` référencé mais absent de `~/.config/opencode/node_modules`.
