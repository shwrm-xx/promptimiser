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
| session-start (startup/clear) | `event: session.created` → injection différée au 1er `chat.message` + toast | OC3 ✅ |
| session-start (compact) | `event: session.compacted` → resync palier + réinjection minimale du lot | OC3 ✅ |
| user-prompt-submit | `"chat.message"` (flush injection différée OC3 ✅ ; nudges init/broad/model-mismatch OC4 ✅) | OC3/OC4 ✅ |
| pre-tool-use (garde `rm`) | `"tool.execute.before"` (throw = deny) + `"permission.ask"` pour le tiers destructif | OC2 |
| post-tool-use (ledgers, todo) | `"tool.execute.after"` (read/edit/write/todowrite) | OC2 |
| stop (métrologie, auto-clôture, handoff) | `event: session.idle` (idempotent : palier monotone + drapeau clôture par lot) | OC3 ✅ |
| pre-compact | `"experimental.session.compacting"` (+ **filet** `session.compacted` : API experimental) | OC3 ✅ |
| renommage session (suggéré → validation utilisateur) | `client.session.update({ title })` appliqué **directement**, 1×/session (pas de canal de confirmation à un plugin OpenCode) — jamais réécrit ensuite | OC3 ✅ |
| occupation (transcript `.jsonl`) | event `message.updated` (tokens) + fallback `client.session.messages` à l'idle ; occ = input + cache.read + cache.write | OC3 ✅ |
| paliers fixes 150k/300k/500k/750k | paliers **relatifs** 50/70/85/95 % de la fenêtre utile (`limit.context − limit.output`), fenêtres lues dans le catalogue `client.config.providers` (pas `opencode.json`) | OC3 ✅ |
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

## Lot OC3 — occupation relative, session.idle (Stop), injection différée, renommage

- **Occupation relative** (`opencode/plugin/impl/occupancy-oc.js`, module OC-natif — le
  transcript `.jsonl` de Claude Code n'existe pas côté OpenCode) : `recordFromMessage` capte
  l'occ du dernier message **assistant** sur l'event `message.updated` (silencieux, sans log :
  streaming très bavard) — occ = `tokens.input + tokens.cache.read + tokens.cache.write`. À
  l'idle, la fenêtre **utile** du modèle (`limit.context − limit.output`) est résolue via le
  catalogue `client.config.providers` (mis en cache 1×/vie du plugin) ; `evaluate` compare
  l'occ à la fenêtre en paliers **relatifs 50/70/85/95 %**, palier persisté MONOTONE par
  session (clé sha1, état hors-projet). Fenêtre inconnue (modèle local sans `limit.context`)
  → pas d'alerte relative (fail-open). Repli `client.session.messages` à l'idle si aucun
  `message.updated` n'a été capté (ex. plugin chargé en cours de session).
- **`session.idle` = équivalent Stop** (miroir de `hooks/stop.js`) : franchissement
  d'occupation → toast (`bridge.toast`, variant `warning` dès le palier 85 %) ; rappel de
  clôture + auto-clôture mécanique du lot sur tree propre (`incrementLot` + `doneLot` si UN
  seul `in_progress`) ; `writeAutoHandoff` réutilisé tel quel. Canal = **toast** au lieu de
  `systemMessage` (pas de statusline OpenCode). Idempotent multi-idle : le palier monotone et
  le drapeau `closure_reminded_for_batch` évitent tout doublon. **Preuve de clôture (verify)
  hors périmètre OC3** — elle vient avec la commande `/close-batch` (OC4).
- **Renommage de session** (`client.session.update`) : appliqué **directement**, 1×/session
  (drapeau `renamed` par session, clé sha1), au 1er idle. Choix assumé : contrairement à
  Claude Code où PMZ ne fait que **suggérer** un titre (l'utilisateur valide via question à
  choix), OpenCode n'offre aucun canal de confirmation interactif à un plugin — appliquer le
  titre PMZ directement est le seul port praticable. Garde-fou : jamais réécrit ensuite (un
  renommage ultérieur, utilisateur ou OpenCode, est préservé). `suggestedTitle` a un effet de
  bord (`touchLot` : compteur « (partie N) ») → appelé une seule fois, ici.
- **Injection différée** : OpenCode n'a pas d'équivalent au `additionalContext` de
  SessionStart. `session.created` met en file (fichier d'état par session) la gouvernance
  (`MSG_ACTIF`) + le handoff de la session précédente (ou le plan de lots à défaut) ;
  `session.compacted` met en file la réinjection minimale du lot en cours ET resync le palier
  (l'occ chute après compaction : `clearUsage` + `resyncBucket(0)`). Le flush se fait au 1er
  `chat.message` en **part texte synthétique** (`out.parts.push({ type:'text', synthetic:true })`).
  L'état de file est PAR session (la closure du plugin est partagée entre sessions du serveur).
- **Non vérifié ce lot** : l'efficacité **réelle** de l'injection `out.parts` et du renommage
  `client.session.update` en TUI live n'a pas été rejouée (seule la sandbox automatisée a
  tourné, avec client mocké). À confirmer si un doute surgit — la structure de la part
  (`TextPart` complet : id/sessionID/messageID/type/text) est conforme au SDK 1.18, et tout
  est enveloppé fail-open (une injection/renommage en échec ne casse jamais la session).
- Tests : `test/run-tests-opencode.js` 64 → 81 assertions (paliers relatifs 50/70/85/95 %,
  idle idempotent multi-idle, handoff écrit à l'idle, renommage 1×/session, fallback via
  `session.messages`, resync post-compaction, injection created→chat.message, fail-open
  catalogue indisponible).

## Lot OC4 — commandes `/pmz` restantes, model_hint local, vigie model-mismatch

- **Commandes `/pmz`** : `budget`, `scope`, `close-batch`, `fresh-session` portées dans
  `opencode/command/pmz/*.md` (8 commandes au total avec OC2). Contenu = miroir des
  `promptimizer/commands/*.md`, chemins réécrits (`~/.claude/promptimizer/{scripts,templates}`
  → `~/.config/opencode/pmz/{scripts,templates}`), frontmatter `allowed-tools` (Claude Code)
  retiré (les commandes OpenCode ne connaissent que `description`). Aucun script nouveau : ils
  s'appuient sur les libs déjà vendorées (`audit-context.js`, `backlog.js`, `close-batch.js`,
  template `handoff-template.md`). L'installer les copie déjà génériquement (`command/pmz/*.md`).
- **Nudges au `chat.message`** (`index.js: computeNudges`, miroir de `user-prompt-submit.js`) :
  init-avant-code (`project.isFullyInitialized` + `INIT_RE`), demande trop large (`isBroad` :
  regex + longueur/bullets), model-mismatch. Anti-spam 1×/session via `prompt_reminders`
  (`lib/state`). Le prompt utilisateur est lu dans `out.parts` (parts texte du message en cours),
  pas dans `input`. Nudges + injection différée fusionnés en **une** part synthétique.
- **Occupation NON re-nudgée ici** : côté Claude Code `user-prompt-submit.js` re-nudge à ≥ 500k ;
  côté OpenCode l'occupation passe déjà par le toast à `session.idle` (OC3) — pas de doublon.
- **Vigie model-mismatch, résolution LOCALE** : le modèle réel est lu dans l'occ record
  (`providerID/modelID` du dernier `message.updated`), **pas** `inp.model` (arrive `null` au
  `chat.message` en 1.18.3, cf. § OC1). Le `model_hint` (alias libre « sonnet »/« opus ») n'est
  comparé que s'il est **résoluble** par le catalogue `client.config.providers` du côté courant
  (`hintResolvable` : un modèle dont l'id contient l'alias). Hint absent du catalogue (ex.
  « sonnet » sur install 100 % locale) OU catalogue indisponible → **ignoré en silence** (jamais
  de faux nudge). `modelsDiffer` (`lib/modelwatch`, pure) fait la comparaison finale.
- **Décision assumée (écart scope)** : le nudge init côté OpenCode ne fait que **pointer vers
  `/pmz init`** — il ne rejoue PAS l'auto-`git init`+bootstrap de `user-prompt-submit.js` (Claude
  Code, cas « aucun `.git` »). Un plugin OpenCode tourne toujours dans un projet déjà ouvert ; la
  création de repo reste une action explicite (`/pmz init`), pas un effet de bord d'un prompt.
- **Non vérifié** : rendu réel des nudges en TUI live (comme OC3, sandbox à client mocké
  seulement). Fail-open partout : une erreur (backlog absent, catalogue KO) → aucun nudge.
- **VERSION** bumpée `1.1.8 → 1.2.0` (epic « PMZ OpenCode » complet : canal OpenCode à parité
  fonctionnelle avec Claude Code, aux gaps v1 près — statusline, filet `ask` sans permission
  active).
- Tests : `test/run-tests-opencode.js` 83 → 108 assertions (arbo + chemins réécrits des 4
  commandes, `help.js` sur 8 commandes, nudges broad/init + anti-spam, model-mismatch
  résoluble≠réel / réel==préconisé / non résoluble ignoré). Suite complète `run-tests.js` verte.

## Lot #54 (Autopilote PMZ II) — parité de clôture : coût réel par lot + preuve à l'idle

- **Coût réel par lot à l'idle** (`index.js: accountCost`, parité `hooks/stop.js` bloc a4) :
  à `session.idle`, les tokens de **SORTIE** du dernier message assistant sont agrégés sur le
  lot **in_progress** via `backlog.addCost`. Côté Claude Code, `turnstats` scanne l'offset
  ajouté au transcript `.jsonl` (pas de double-comptage par construction). OpenCode n'a pas de
  transcript scannable → **watermark par messageID** : `state.cost_watermark` retient l'id du
  dernier message déjà compté ; plusieurs `session.idle` successifs pour le **même** message
  final (fréquent) ne créditent qu'une fois. La source du coût est l'occ record
  (`occupancy-oc.js: recordFromMessage`, étendu avec `out` + `id`), écrasé à chaque
  `message.updated` → à l'idle il porte les tokens finaux + l'id du dernier message. Repli sur
  `client.session.messages` si aucun `message.updated` n'a été capté.
- **Ordre aligné** : le bloc coût s'exécute **AVANT** le bloc clôture (le lot doit être encore
  in_progress pour qu'`addCost` accumule — un lot clos ne consomme plus). `st` est muté par
  `accountCost` (watermark + `cost_reminded_for_batch`) mais **persisté une seule fois** par
  `closureAndHandoff`, après la logique de clôture (qui peut réarmer `cost_reminded` quand le
  tree redevient propre). Toasts émis **après** la persistance de l'état.
- **Toast budget 250k** (`COST_WARN_TOKENS`) : au franchissement, `lotCostMessage` en toast
  **warning**, plafonné 1×/lot·session (`cost_reminded_for_batch`, réarmé au tree propre).
- **Preuve à l'auto-clôture idle** (parité `hooks/stop.js` bloc b2) : quand le tree redevient
  propre et qu'**un seul** lot est in_progress, après `doneLot` (état déjà persisté), le
  `verify` du lot est rejoué (`project.runVerify`, délai court `VERIFY_AUTOCLOSE_MS` = 2500 ms)
  + garde-fou CHANGELOG (`project.changelogTouched`). `closureProofMessage` → toast :
  **échec/timeout du verify → warning distinct**, sinon rappel CHANGELOG en info. **Jamais
  bloquant** : le lot est marqué done quoi qu'il arrive (try/catch dédié, fail-open local).
- **Trade-off assumé** : `runVerify` est **synchrone** (`execSync`) — au pire 2,5 s de blocage
  du process serveur OpenCode, mais uniquement à l'auto-clôture (rare, 1×/lot) et seulement si
  le lot porte un `verify`. Aligné sur le délai court de Claude Code ; documenté ici comme
  connu.
- **Non vérifié** : rendu réel des toasts coût/preuve en TUI live (sandbox à client mocké
  seulement, comme OC3/OC4).
- **VERSION** bumpée `1.2.3 → 1.2.4`. Tests : `run-tests-opencode.js` 108 → 119 assertions
  (crédit + watermark double-idle + re-crédit message distinct, toast 250k + anti-spam, preuve
  verify échec→warning + garde-fou CHANGELOG + lot done non bloqué, fail-open sans message).

## Hors périmètre / constats d'audit (2026-07-18)

- Statusline : gap v1 (voir mapping). Piste future : binaire externe abonné au flux SSE
  (`event.subscribe`), type ocstatusline.
- Constats sur la config réelle de la machine (à corriger par l'utilisateur, PMZ n'y touche
  pas) : `qwen3.6:latest` déclaré dans `opencode.json` mais seul `qwen3.6:27b` est installé ;
  plugin `opencode-local-provider` référencé mais absent de `~/.config/opencode/node_modules`.
