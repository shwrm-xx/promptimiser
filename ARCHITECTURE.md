# ARCHITECTURE — Promptimizer

Capture la couche **stable** et le non-greppable. Le code fait foi pour le détail volatil.

## Vue d'ensemble

PMZ = un package installé dans `~/.claude/` qui branche **6 hooks Claude Code** + une **skill
globale** + des **slash commands** + des **scripts** + des **templates** + un **delta Codex**.
Le dépôt en est la source (miroir plat → `~/.claude/`, cf. [CLAUDE.md](CLAUDE.md)).

```
Promptimizer
├─ Project Initializer      (session-start + bootstrap-project/lib/bootstrap.js + /pmz-init ;
│                             auto-scaffold sans confirmation sur un projet neuf, 0 commit)
├─ Context Budget Controller (occupancy.js : paliers fixes + flottant, hygiène de lecture)
└─ Batch Quality Controller  (stop + audit-batch + close-batch + ledgers + lib/lot.js)
```

## Contrat des hooks (source de vérité)

Hooks invoqués via `"<node-absolu>" ~/.claude/promptimizer/hooks/<x>.js`. Le chemin **absolu**
de `node` est figé à l'install (résolu vers un symlink stable, ex. `/opt/homebrew/bin/node`),
pour éviter `exit 127` quand Claude Code lance les hooks via `sh -c` avec un PATH épuré (apps
GUI macOS). Le `~` reste développé par le shell. Stdin = JSON ; sortie = JSON sur stdout, exit 0.
En **mode plugin** (lot D2), le câblage vient de `hooks/hooks.json` et `node` est résolu au runtime
par le wrapper `bin/pmz-hook` — voir « Canal plugin Claude Code » plus bas. Le contrat par hook
(events, stdin, sortie) ci-dessous est identique dans les deux canaux.

| Hook | Event / matcher | Lit (stdin) | Émet | Rôle |
|------|-----------------|-------------|------|------|
| `session-start.js` | SessionStart `startup\|resume\|clear\|compact` (injecte au `startup`/`clear` ; `compact` → réinjection minimale du lot en cours ≤ 300 chars ; `resume` → nudge occupation seul, voir ci-dessous) | `cwd`, `source`, `transcript_path` | `additionalContext` (startup/clear/compact) ou `systemMessage` (resume) | détecte projet, auto-scaffold si projet neuf (0 commit), sinon propose init, rappel court + titre de session suggéré + injecte le handoff de la session précédente puis le marque consommé ; sans handoff, le plan de lots sert de filet (2 lignes) ; au `resume`, si occupation ≥ 300k, `systemMessage` d'occupation (lot B5, zéro token injecté) |
| `user-prompt-submit.js` | UserPromptSubmit | `prompt`, `cwd`, `transcript_path` | `additionalContext` | auto-`git init`+scaffold si aucun `.git` et prompt de démarrage, détecte init/large (anti-spam 1×/session), nudge occupation ≥ 500k en 2 lignes (anti-spam 1×/palier, lot B5) |
| `pre-tool-use.js` | PreToolUse `Bash` | `tool_input.command` | `permissionDecision` allow/ask/deny | sûreté commandes |
| `post-tool-use.js` | PostToolUse `Read\|Edit\|Write\|TodoWrite` | `tool_input.file_path`, `tool_input.todos` | `additionalContext` (rare, advisory) + effet de bord ledgers | auto-crée le ledger si absent, journalise lectures/édits, capture la todo-list (`todo-snapshot.json`, écrasé à chaque TodoWrite), signale une relecture complète redondante (lot B4) |
| `stop.js` | Stop | `stop_hook_active`, `transcript_path` | `systemMessage` | alerte coût (paliers fixes + flottant), **métrologie par tour** (tour coûteux + cache-busts, `lib/turnstats.js`), hygiène de lecture, rappel de clôture nommant les skills, incrémente le compteur de lot, auto-clôt le lot backlog en cours (cas univoque : exactement un `in_progress`) et annonce le suivant, écrit le handoff auto (écrasé à chaque tour) |
| `pre-compact.js` | PreCompact `manual\|auto` | `cwd`, `trigger`, `transcript_path` | `systemMessage` (manual) ou — (auto : effet de bord handoff seul) | sauve le handoff auto (plan de lots + todos compris) AVANT compaction ; la réinjection minimale se fait au SessionStart(compact). Sur `manual` (/compact), ajoute un rappel **chiffré** visible : compacter ≈ réécriture de l'occupation en cache-write (×1,25) + résumé lossy, vs clôture + handoff (~8k) — TTL prudent, aucun prix en dur (lot T1). `auto` reste silencieux (compaction subie) |

### Invariants NON négociables
1. **Fail-open** : toute erreur/timeout/JSON → `exit 0` ; jamais `exit 2` ; doute → `allow`.
   Préambule `process.on('uncaughtException'/'unhandledRejection', exit 0)` **avant tout
   `require`** (couvre l'échec d'un `require`) + watchdog `setTimeout(...).unref()`. Délais
   centralisés dans `lib/timeouts.js` (watchdog < timeout settings, marge 500 ms).
2. **Kill-switch** : `PMZ_DISABLE=1` → `exit 0` en 1re ligne de chaque hook.
3. **Pas d'écriture auto hors repo (git existant ou auto-initialisé)** ; **jamais d'écrasement**
   d'un fichier déjà présent (`copyIfAbsent`). Deux niveaux distincts :
   - le **ledger** (`.vibe-agent/`) est de la plomberie interne invisible : auto-créé dès qu'un
     repo git existe (`ensureLedger`), **sans confirmation** ;
   - le **socle visible** (`CLAUDE.md`/`AGENTS.md`/`CHANGELOG.md`) reste derrière confirmation
     (`/pmz-init`) sur un projet **mature** (au moins un commit) ; il est posé automatiquement,
     sans confirmation, uniquement sur un projet **neuf** (0 commit, voire aucun `.git` — PMZ fait
     alors `git init` lui-même) où il n'y a par construction rien à écraser.
   - Sur un projet **en cours** dont `CLAUDE.md`/`AGENTS.md` existent déjà, `/pmz-init`
     (`bootstrap-project.js --augment`) **ajoute en fin de fichier** la section « Règles
     Promptimizer » taguée (`pmz:rules:start/end`, `templates/pmz-rules.md`) : append-only,
     idempotent (les templates portent le même marqueur, donc un fichier issu du scaffold n'est
     jamais ré-augmenté), réversible en supprimant le bloc. Les hooks n'augmentent **jamais** —
     ce mode est réservé au flux `/pmz-init` explicite, derrière confirmation.
4. **PreToolUse étroit** : `deny`/`ask` sur denylist destructive ancrée + whitelist large ;
   aucun `ask` sur Read/Edit (respect `acceptEdits`).
5. **systemMessage** = canal des rappels : visible utilisateur, **non réinjecté** dans le contexte
   du modèle, **non bloquant** (technique reprise de `context-guard.py`).

## Flux de données

- **Occupation contexte** (`lib/occupancy.js`) : lit la dernière ligne `usage` du transcript
  (`input + cache_read + cache_creation`) par **fenêtre croissante depuis la fin** (512 KB → 2 MB
  → 8 MB max, pour ne pas rater une ligne `usage` repoussée par de gros `tool_result`), compare
  aux paliers `[150k, 300k, 500k, 750k]` puis, au-delà, à un **palier flottant** tous les
  `+250k` (`FLOATING_STEP`) — une session marathon ne redevient jamais silencieuse. Anti-spam par
  session dans `~/.claude/promptimizer/state/<sha1(sid)>` : palier persisté **monotone
  croissant** (une seule alerte par palier ; pas de redescente intra-session — un vrai reset =
  nouvelle `session_id`). Aucune dépendance aux ledgers projet. → Méthode reprise de l'ancien
  `context-guard.py`.
- **Nudges haute occupation avant/à la reprise du tour** (`user-prompt-submit.js` /
  `session-start.js`, lot B5) : distincts de l'alerte de fin de tour (`stop.js`) ci-dessus,
  volontairement **découplés** de son fichier d'état palier (`occupancy.evaluate`/
  `resyncBucket`) pour ne pas interférer avec sa cadence propre. `user-prompt-submit.js`
  relit l'occupation (`readLastOccupancy` + `bucketIndex`, lecture seule) et, si ≥ 500k,
  injecte un `additionalContext` de 2 lignes plafonné **1×/palier** via une clé `occ_<bucket>`
  dans `prompt_reminders` (même state que les rappels `broad`/`init_before_code`). `session-start.js`
  fait de même au `source=resume` si ≥ 300k, mais en `systemMessage` (zéro token injecté,
  pas d'anti-spam nécessaire) — comble le silence d'une session reprise déjà chargée, qui
  restait muette jusqu'au premier `Stop`.
- **Métrologie par tour** (`lib/turnstats.js`, appelée par `stop.js`) : mesure le coût du
  **dernier tour** en ne scannant QUE `[offset, EOF]` du transcript — l'offset (octets) et la
  dernière occupation sont mémorisés au Stop précédent dans `<sha1(sid)>-turns.json` (FIFO 40
  tours). `computeTurn` en tire `delta` d'occupation, tokens de sortie, nombre d'appels, ratio de
  cache et les **cache-busts** (cache_read effondré sous 50 % d'une occ ≥ 100k) : `first:true` =
  1er appel du tour (pause/TTL de cache expiré, normal, signalé 1×/session via `<sha1>-ttl`) vs
  `first:false` = bust **en plein tour** (anormal : fichier lu par le cache modifié en session).
  Alertes `systemMessage` : tour coûteux (`delta ≥ 50k`, anti-spam 3 tours) et busts. Un offset
  supérieur à la taille du fichier (transcript tronqué/remplacé) → `baselineReset` (`delta=null`,
  aucune alerte parasite) ; un `delta < -100k` (compaction) → `occupancy.resyncBucket` réécrit le
  palier persisté pour réarmer les alertes. Miroir compact `context-ledger.json.occupancy`
  (`{last, at, delta_last_turn, session}`, last-writer-wins assumé — la mesure fine reste hors-projet).
- **Hygiène de lecture** (`lib/occupancy.js: evaluateReadMix`) : même principe (lit le transcript
  brut, fenêtre fixe 1,5 Mo, aucune dépendance au ledger), tally les blocs `tool_use` récents pour
  détecter une majorité de `Read` sans `offset`/`limit` face aux recherches (`Grep`/`Glob`/`grep`
  en Bash). Une seule note par session (fichier d'état sha1 dédié, suffixe `-hygiene`).
- **Ledgers projet** (`.vibe-agent/{read,context}-ledger.json`) : auto-créés par
  `ensureLedger` (tout hook qui touche au projet) puis maintenus par `post-tool-use.js`
  (atomique `tmp`+`rename`, cap FIFO). Servent l'advisory `/check-context`. Granularité
  **per-fichier**, distincte de l'occupation globale. `post-tool-use.js` capture aussi le
  `statSync` (octets/mtime) de chaque `Read` : coût estimé ≈ `bytes / 4` tokens. Une relecture
  **complète** (`!partial`) d'un fichier **inchangé** (mtime identique à la dernière lecture)
  incrémente `estimated_context_waste` (total) et `waste_by_file[path]` (ventilé) — une lecture
  partielle ou un fichier modifié entre-temps est un coût justifié, pas du gaspillage.
  `audit-context.js` en tire la ligne « Gaspillage ≈ Xk sur N fichiers » + liste triée par coût.
- **Statut d'économie chiffré en tokens** (`audit-context.js`, servant `/budget` et
  `/check-context`) : le verdict vert/orange/rouge est piloté par l'**occupation en tokens
  réels** — le miroir `context-ledger.json.occupancy.last` posé par le hook `Stop` (métrologie
  par tour) — combiné au gaspillage de relecture ci-dessus. Seuils alignés sur les paliers
  d'`occupancy.js` (orange à `BUCKETS[1]`=300k, rouge à `BUCKETS[2]`=500k, sans échelle inventée) ;
  un gaspillage ≥ un palier aggrave d'un cran. **Fallback annoncé** : sans occupation token connue
  (jamais passé par un `Stop` récent, hors-git), retombe sur le comptage de relectures et le dit
  explicitement — jamais de chiffre tokens fantôme.
- **Advisory intra-tour** (`lib/advisory.js`, appelé par `post-tool-use.js`) : sur un `Read`
  **COMPLET** (`!partial`) d'un fichier **≥ 16 Ko** déjà lu, **inchangé** (mtime identique —
  signal `waste` renvoyé par `ledger.recordRead`) et **hors `files_modified`** (garde-fou en
  plus du mtime), émet un `additionalContext` d'une ligne (~60 tokens) signalant la relecture
  probablement redondante. PostToolUse reste strictement informatif : jamais de
  `permissionDecision`, le `Read` est déjà exécuté. Plafonné par un état **hors-projet**
  `<sha1(session_id)>-advisory` (même convention que `occupancy.js`/`turnstats.js`) : 1×/fichier
  ET 3×/session, remis à zéro à chaque nouvelle `session_id`. Opt-out `PMZ_NO_ADVISORY=1` (ne
  consomme pas le plafond — l'advisory reste disponible si l'opt-out est levé dans la session).
- **État de clôture** (`.vibe-agent/session-state.json`) : keyé par `session_id` ; flag
  anti-spam du rappel de clôture par lot. À la fermeture d'un lot (working tree qui redevient
  propre), `stop.js` incrémente aussi le **compteur de lot** (`.vibe-agent/lot-counter.json`,
  `lib/lot.js`) — amorcé depuis le plus grand `(lot N)` déjà présent dans `CHANGELOG.md` s'il en
  existe. `backlog.js: doneLot` fait de même par défaut (chemin de clôture **manuelle**, ex.
  `/close-batch`) : sans ça, le compteur restait figé sur ce chemin et le même « Lot N »
  revenait indéfiniment d'une session à l'autre (fix 2026-07-11). `session-start.js` en déduit
  un titre de session suggéré (« Epic — Lot N », epic =
  `.vibe-agent/epic` ou nom du dossier), **suffixé** du titre du lot backlog le plus pertinent
  (`lib/lot.js: suggestedTitle`, 40c) — priorité : lot **en cours** (travail qui continue) >
  dernier lot **clos** (ce qui vient d'être fait, cas le plus fréquent juste après une clôture —
  sans ce fallback le titre reste nu et ne dit rien de l'avancée réelle) > prochain lot à faire
  (dernier recours). Parmi les lots clos, le « dernier » est celui au `closed_at` le plus récent,
  puis au plus grand `id` — **jamais** trié par `lot_number` : ce compteur global peut être `null`
  ou recyclé sur d'anciennes clôtures, et son plus grand *cohérent* figeait alors la sélection sur
  un vieux lot (retour utilisateur : renommage bloqué sur « Lot 7 » — fix 2026-07-12). **Le N affiché est l'ID backlog du lot retenu** (`lib/backlog.js`, le
  référentiel que l'utilisateur voit dans `backlog.js show`), **jamais** `lot-counter.json` —
  ce compteur avance à chaque transition working-tree sale → propre, y compris sur un commit de
  bookkeeping de clôture qui n'ajoute aucun lot, et dérivait donc du numéro backlog au fil du
  projet (retour utilisateur : titre « Lot 14 » alors que le backlog affichait déjà #17 — fix
  2026-07-11). `lot-counter.json`/`getLotCounter` restent le seul recours quand le plan n'a
  **aucun** lot exploitable (backlog absent/vide, ou lot écarté comme périmé — cas ci-dessous) :
  il n'existe alors aucun autre référentiel pour numéroter. Le dernier lot clos n'est retenu que s'il ne peut pas être attribué à une
  session **plus ancienne** que la précédente (`lot.closed_session_id`, posé par `stop.js` à la
  clôture, comparé à `lib/state.js: previousSessionId` — le `session_id` brut lu dans
  `session-state.json` **avant** que `session-start.js` ne l'écrase avec celui de la session
  courante) : sans ça, une session qui n'a rien clos (ex. un simple état des lieux) hériterait à
  tort du titre du lot fermé par une session antérieure. Sans trace de session (clôture
  manuelle/ancienne, champ absent), on l'affiche quand même — mieux qu'un titre nu, et rien ne
  prouve que c'est faux. Si le plan de lots n'a **lui-même aucun titre à offrir** (backlog absent
  ou `lots: []` — retour utilisateur : un titre nu ne sert à rien pour retracer l'avancée),
  `suggestedTitle` **déduit** un intitulé des infos disponibles plutôt que de retomber nu : dernier
  résumé `CHANGELOG.md` (parenthèse finale du dernier titre `##` — convention de ce dépôt — ignorée
  si ce n'est qu'un marqueur `(lot N)` non descriptif), sinon sujet du dernier commit. Cette
  déduction ne s'applique **jamais** quand le plan contient un lot mais qu'il est écarté comme
  périmé (cas ci-dessus) : un titre existe alors dans le plan, il est volontairement tu — le
  remplacer par une supposition externe reviendrait à mentir de la même façon que ce que le fix
  visait à éliminer. Puis demande à l'assistant de **proposer** ce nom en clair
  (valeur ajoutée : l'utilisateur l'accepte ou en donne un autre) puis de tenter le renommage réel
  et d'accuser explicitement le résultat — un hook ne peut pas appeler un outil MCP lui-même, ce
  n'est donc qu'une instruction, pas une garantie. Le dialogue d'autorisation du tool de renommage
  (`mcp__ccd_session_mgmt__set_session_title`, fourni par Claude Code Desktop, hors de ce dépôt)
  est un `ask` **câblé côté serveur** : ni `permissions.allow`, ni `bypassPermissions`, ni un hook
  PreToolUse « allow » ne le suppriment. PMZ ne peut donc pas l'auto-approuver — il le transforme
  en simple validation du nom proposé.
- **Rappel SessionStart slim vs plein** (`lib/messages.js`, `MSG_ACTIF` / `MSG_ACTIF_SLIM`) : quand
  le CLAUDE.md du projet porte déjà le bloc `pmz:rules` (`project.js: carriesRules`, fail-open), les
  règles d'économie sont **déjà dans le contexte** — le rappel injecté ne les répète plus (variante
  slim) et se limite au protocole de clôture (OK/Non + `/close-batch`), absent de `pmz-rules.md`.
  Sinon, rappel plein. But : ne pas dupliquer à chaque SessionStart ce que le CLAUDE.md charge déjà.
- **Plan de lots** (`.vibe-agent/backlog.json`, `lib/backlog.js` + CLI `scripts/backlog.js`) :
  le lot comme **objet persistant trans-session** — id, titre, « fait quand », statut
  (`todo|in_progress|done|dropped`), **préconisation de modèle** (`model_hint`, ex. `sonnet`/
  `opus`), commit de clôture, et `closed_session_id` (session qui a clos le lot — `null` si
  clôture manuelle via le CLI sans id, jamais deviné). Au plus un `in_progress` ; cap 20 lots
  ouverts ; `doneLot` idempotent. `model_hint` est **obligatoire à l'`add` CLI** (refus doux sans `--model`) et
  **réaffiché** partout où un lot est rendu (`show`/`start`/`next`, `summaryLines` → handoff auto)
  sous forme `[modèle : …]` — jamais perdu silencieusement. Écrit par l'assistant (CLI) ; **auto-clos par `stop.js`**
  quand le working tree redevient propre et qu'exactement un lot est `in_progress` (sinon ne
  touche à rien — réconciliation bête via `backlog.js reconcile`). Jamais de promotion
  automatique du suivant. Champ optionnel `verify` (cap 150c, `MAX_VERIFY`, lot #29) : commande
  shell de preuve de clôture, posée à l'`add --verify` ou éditée après coup (`backlog.js verify
  --id N --set "…"`) — `/close-batch` (`scripts/close-batch.js`) l'exécute avant d'indiquer le
  `done` et affiche OK/ÉCHEC (refus doux, **jamais bloquant** — même en échec la checklist reste
  exit 0, la décision de clore reste humaine/assistant). Champ `closed_occupancy` (lot #29) :
  occupation contexte du tour figée par `stop.js` à l'auto-clôture (`turnstats.computeTurn().occ`,
  métrologie de coût par lot) — `null` sur une clôture manuelle via le CLI (pas de transcript à ce
  niveau). **Durabilité par défaut** (le backlog ne doit JAMAIS être perdu) : le
  bootstrap pose un `.vibe-agent/.gitignore` **whitelist** (`*` puis `!.gitignore`, `!backlog.json`,
  `!rules.yaml`) — l'état éphémère (ledgers, handoff, session-state, snapshot) reste hors git, seul
  le plan durable est suivi ; et `saveBacklog` **stage** le fichier à chaque écriture (survit à un
  `git clean`, part au prochain commit dès sa création). Sa disparition passée venait de ce qu'il
  n'était pas suivi par git. À part : `.vibe-agent/todo-snapshot.json`, capture passive de la
  todo-list Claude Code (écrasée à chaque `TodoWrite`, sens unique outil→disque — granularité
  tâche ≠ lot, jamais de promotion todo→backlog).
- **Handoff de session** (`.vibe-agent/handoff.md`, `lib/handoff.js`) : UN fichier, **écrasé à
  chaque fin de tour** par `stop.js` (jamais cumulé — pas de bloat). Deux origines distinguées
  par marqueur en 1re ligne : `<!-- pmz:handoff:auto -->` (mécanique : epic/lot, branche,
  dernier commit, plan de lots x/y + lot en cours + suivants, dernières todos,
  working tree filtré, fichiers récemment lus à ne pas relire) et
  `<!-- pmz:handoff:manual -->` (riche, écrit par l'assistant via `/fresh-session` ou
  `/close-batch` — jamais écrasé par l'auto tant qu'il n'est pas consommé). Au SessionStart
  suivant (`startup`/`clear` uniquement, jamais `resume`/`compact`), le handoff est **injecté**
  (cap 6 000 caractères) puis **marqué consommé** (manuel → auto, l'auto reprend la main). Un
  fichier sans marqueur PMZ (notes utilisateur) n'est ni écrasé ni injecté. La détection de
  « lot ouvert » de `stop.js` utilise `gitStatusMeaningful` (porcelain **sans** `.vibe-agent/`) :
  le churn ledgers/handoff ne compte pas comme lot ouvert et ne bloque pas sa clôture.
- **`pmz:skip` du handoff → `avoid_reread_notes`** (`lib/handoff.js#parseSkipPaths`,
  `lib/ledger.js#seedAvoidReread`, lot T3) : un handoff manuel peut lister des chemins à ne pas
  relire via des lignes `pmz:skip: <chemin>` ; `withHandoff` (`session-start.js`) les sème dans
  `avoid_reread_notes` (read-ledger) au moment de l'injection — l'advisory anti-relecture est
  actif dès le tour 1, sans attendre une 1re relecture réelle pour l'alimenter. Champ réutilisé,
  pas dupliqué. Parse raté/vide = ignoré silencieusement (fail-open).

- **Version de PMZ** (`promptimizer/VERSION`, `lib/version.js`) : entier simple (pas de semver —
  un seul mainteneur, aucune distinction major/minor/patch utile) versionné avec le package,
  copié tel quel à l'install. Bumpé **manuellement** par le mainteneur (`bumpVersion()`) à chaque
  évolution notable, tracé dans `CHANGELOG.md` — jamais incrémenté par les hooks installés dans
  un projet cible (ce n'est pas leur version à eux). `scripts/about.js` (commande `/pmz-about`)
  l'affiche avec l'epic (`readEpic`) et l'état du backlog (`currentLot`/`nextLot`/`progress`) du
  projet courant — deux informations distinctes : la version est celle du **package**, l'epic/lot
  est celui du **projet**.

## Mapping source → cible & installation

**Installeur Node cross-platform — source de vérité unique** (`install/*.js`) : la logique
d'install/diagnostic/désinstall/packaging vit dans quatre cores Node stdlib
(`install.js`, `doctor.js`, `uninstall.js`, `package.js`). Les lanceurs `install.command` (macOS),
`install.sh` (Linux), `install.ps1` (Windows) — idem pour les trois autres — sont **fins** :
ils vérifient `node` puis délèguent au core. Un seul emplacement de logique évite la dérive
bash/PowerShell. La **quarantine** (`xattr`) est gardée à `process.platform === 'darwin'` ; le
**packaging** archive via `zip` (macOS/Linux) ou `Compress-Archive` (Windows). Les cores partagent
`install/lib-io.js` (lecture stdin synchrone) et sont **non-interactif-safe** (prompts/pause
court-circuités hors TTY ou avec `--no-pause`, défauts alignés sur l'ancien bash). Le core
`install.js` appelle `doctor.js` en fin de course et lance `git config core.hooksPath .githooks`
uniquement sur le **dépôt source** (présence de `.git` + `.githooks`).

**Versioning d'upgrade** : `install.js` lit `$DEST/promptimizer/VERSION` **avant** la purge/copie
(étape 3, sinon la version installée est écrasée avant d'être comparée) et la confronte à la
VERSION entrante (`lib/version.js`) — annonce « première installation », « mise à jour vN → vM »,
« réinstallation (vN) » ou « downgrade vN → vM ». Fail-open : version illisible/absente → traité
comme première installation, jamais de crash. `package.js` nomme l'archive
`Promptimizer-vN-YYYYMMDD.zip` ; `doctor.js` affiche la version installée (relit
`VERSION` depuis son propre dossier via `lib/version.js`, donc toujours celle du package
effectivement installé, jamais celle du dépôt source).

**Contrat d'autonomie du package installé** : une fois copié sous `$DEST/promptimizer`
(`~/.claude/promptimizer` ou `$CLAUDE_CONFIG_DIR/promptimizer`), le package ne doit **jamais**
avoir besoin du dépôt source pour fonctionner — ni pour tourner (hooks, doctor, désinstall), ni
pour se réinstaller depuis une archive `.zip` téléchargée sur une autre machine sans Git. Tous
les chemins internes se résolvent via `__dirname`/`path.resolve` relatifs au fichier exécuté,
jamais via un chemin absolu figé vers le dépôt qui a servi à packager. Vérifié par
`test/run-tests.js` (section « autonomie du package ») : `package.js` produit une archive,
décompressée **hors dépôt** (`os.tmpdir()`), installée vers un `$HOME`/`CLAUDE_CONFIG_DIR`
fictif, puis `doctor.js` doit rendre un statut vert **sans dépôt source ni `.git` présents** ; un
grep de garde vérifie qu'aucun fichier sous `$DEST/promptimizer` ne contient le chemin absolu du
dépôt source.

**Dossier de config Claude — source de vérité unique** (`lib/claude-dir.js`) : Claude Code
honore `CLAUDE_CONFIG_DIR` pour relocaliser `~/.claude` ; PMZ le respecte **partout** (les cores
d'install via `claude-dir.js`, runtime JS aussi). Un seul point de calcul évite qu'install et
hooks divergent (install au bon endroit mais hooks aveugles sur un `~/.claude` inexistant). Repli
sur `~/.claude` si la variable est absente **ou vide** (JS `trim()`). `PMZ_STATE_DIR` reste un
override prioritaire pour les tests (appliqué par les **appelants** `occupancy.js`/
`merge-settings.js`, pas par `claude-dir.js` — sinon un test posant `PMZ_STATE_DIR` globalement
fausserait les assertions sur le repli manuel). **Découplage `pmzDir()` / `stateDir()`** (lot D2) :
`pmzDir()` (racine du code) renvoie `CLAUDE_PLUGIN_ROOT` en mode plugin, sinon `~/.claude/promptimizer` ;
`stateDir()` (état persistant) vise `CLAUDE_PLUGIN_DATA/state` en plugin — **jamais sous `pmzDir()`**,
qui est remplacé à chaque update du plugin, sinon l'état serait effacé. Repli manuel des deux :
`~/.claude/promptimizer[/state]` (inchangé).

`merge-settings.js` : parse strict (échec → **abort**), backup horodaté vérifié (suffixe `-N`
anti-collision, perms 0600), fusion **append-only par event** taguée (idempotente). La purge
reconnaît les tags **courant + hérités** (`PMZ_TAGS`) → un renommage du paquet ne laisse pas de
hooks orphelins (sinon double-firing). Préserve `permissions`/`statusLine`/`enabledPlugins` et
tout hook tiers. Prise de relais de `context-guard.py` (`--takeover`) : ses entrées `Stop`
retirées sont sérialisées dans le **sidecar** `state/taken-over.json` ; `--remove` **restaure
depuis ce sidecar** (le backup horodaté n'est qu'un filet de secours, pas la source de
restauration) et **signale** un sidecar corrompu au lieu de l'avaler. Écriture atomique, perms 0600.

### Canal plugin Claude Code (lot D2, alternatif à l'install manuelle)

Le format plugin impose `commands/`, `skills/`, `hooks/hooks.json` **à la racine du plugin**, sans
chemin personnalisable — incompatible avec le miroir plat source. Plutôt que de casser ce miroir
(canal manuel conservé), `install/build-plugin.js` en **dérive** un dossier plugin self-contained
dans `dist/marketplace/` (gitignoré) : copie de `promptimizer/` **moins `install/`**, skill
replacée sous `skills/promptimizer/`, chemins `~/.claude/promptimizer` réécrits en
`${CLAUDE_PLUGIN_ROOT}` dans commands + skill (substitués inline par Claude Code), version du
manifeste alignée sur `VERSION`, `marketplace.json` locale à **source string relative**
(`"./promptimizer"`). Zéro duplication committée — le plugin est un artefact de build.

- **Câblage des hooks** : `hooks/hooks.json` statique (6 hooks, mêmes matchers/timeouts que
  `merge-settings.js`) remplace l'écriture dans `settings.json`. Commande =
  `sh "${CLAUDE_PLUGIN_ROOT}/bin/pmz-hook" "${CLAUDE_PLUGIN_ROOT}/hooks/x.js"`.
- **Wrapper `bin/pmz-hook`** : résout `node` **au runtime** (PATH puis emplacements usuels absents
  du PATH GUI macOS) — remplace le `resolveNodeBin()` de `merge-settings.js`, inutilisable pour un
  plugin distribué (chemin machine-spécifique). Invoqué via `sh` car le bit +x n'est pas préservé
  en `.zip`. Fail-open : `node` introuvable → exit 0 silencieux.
- **Diagnostic** = `claude plugin details promptimizer` (natif). `doctor.js` reste l'outil du
  canal manuel (exclu du plugin).
- **Régression assumée** (cf. D1) : pas de takeover réversible d'un hook Stop tiers en plugin ;
  commandes namespacées `/promptimizer:*`.

### Migration manuel → plugin + versioning semver (lot D3)

- **`VERSION` en semver** (`x.y.z`), aligné sur `.claude-plugin/plugin.json` : `lib/version.js`
  expose `compareSemver`/`parseSemver` en plus de `readVersion`/`bumpVersion` (bump = patch par
  défaut, `major`/`minor` en paramètre). `install.js` compare via `compareSemver` (au lieu d'un
  `parseInt` d'entier) ; un format illisible (legacy pré-D3, ex. `"3"`) renvoie `null` → traité
  comme première installation, jamais un crash. `build-plugin.js` n'a plus besoin de convertir
  l'entier en `x.0.0` : `manifest.version = readVersion()` directement.
- **`install/migrate-to-plugin.js`** : outil de sortie du canal manuel, réutilise
  `merge-settings.js --remove` (retrait des hooks legacy + restauration du sidecar
  `context-guard.py` si applicable) puis affiche les commandes d'install du plugin. `--purge`
  supprime aussi les fichiers PMZ legacy (défaut : conservés, symétrique à `uninstall.js`).
- **`doctor.js` détecte la double installation** (plugin + canal manuel jamais retiré, qui
  ferait tirer les hooks deux fois) par deux voies indépendantes : (A) ce doctor tourne sous
  `CLAUDE_PLUGIN_ROOT` et des hooks PMZ legacy traînent encore dans `settings.json` ; (B) ce
  doctor tourne en canal manuel et `claude plugin list` (best-effort, absence de la commande =
  non détecté) rapporte `promptimizer` déjà installé. Statut `orange` + rappel de
  `migrate-to-plugin.js` dans les deux cas.
- **Canal manuel gelé** : `install.command`/`.sh`/`.ps1` (et `uninstall.*`/`pmz-doctor.*`)
  restent fonctionnels mais ne reçoivent plus de nouvelles features — le plugin est le canal
  recommandé pour toute nouvelle install (cf. README).

### Diffusion tiers (lot D4)

- **Marketplace privée = dépôt git ou dossier local**, sans particularisation à une organisation
  donnée : `dist/marketplace/` (artefact de build, cf. lot D2) est partageable tel quel — partage
  de dossier, dépôt git privé, ou tout autre canal interne à l'organisation qui adopte PMZ.
- **`extraKnownMarketplaces`** (`settings.json`, user ou projet) documenté au README pour éviter
  un `marketplace add` manuel par poste : chaque organisation référence son propre dépôt (source
  `git`, `github`, ou chemin local) sans changement de code côté PMZ.
- **Public GitHub reste un objectif lointain** (pas fait) : même mécanique (`extraKnownMarketplaces`
  avec source `github`), simplement pas encore publié.
- **Windows non testé réel dans ce lot** : pas de machine Windows disponible dans l'environnement
  d'exécution de ce tour ; les wrappers (`bin/pmz-hook`) et la résolution de chemins
  (`claude-dir.js`) restent donc vérifiés seulement par lecture de code + tests unitaires
  (bac à sable macOS), pas par exécution réelle sous Windows.

## Décisions & pourquoi

- **Distribution : verdict plugin Claude Code = GO staged** (spike lot #30, 2026-07-12) : le
  packaging en plugin natif est faisable et validé sur machine réelle ; il supprime l'installeur
  bespoke + la fusion de `settings.json` au prix d'une régression niche (takeover d'un hook Stop
  tiers). Détail, preuves et chiffrage : [docs/decisions/D1-plugin-go-nogo.md](docs/decisions/D1-plugin-go-nogo.md).
- **Occupation-tokens plutôt que compteur de tours** (vs spec) : signal réel, déjà éprouvé par
  `context-guard.py` ; PMZ le reprend à son compte (système standalone unifié).
- **Stop non bloquant** : un Stop bloquant risque la boucle (cap 8) et gonfle le contexte ;
  `systemMessage` informe sans bloquer.
- **PreToolUse limité à `Bash`** : `acceptEdits` montre que l'utilisateur veut peu de
  confirmations ; on ne gêne pas Read/Edit.
- **Zéro dépendance / `node` et `git` en chemin absolu** : `node` nu échouait (`exit 127`) sous le
  PATH épuré des apps GUI macOS ; `node` est figé à l'install (symlink stable de préférence) et
  `git` est résolu en chemin absolu au runtime (`lib/env.js resolveTool`). Si malgré tout un outil
  est introuvable, le hook dégrade en fail-open (la session continue sans PMZ).
- **Ledger auto-créé sans confirmation, socle visible non (sauf projet neuf)** : un audit d'usage
  réel (projet assistHealth, un mois) a montré que toute la couche ledgers/clôture assistée reste
  inerte dès que `/pmz-init` n'est jamais lancé, alors que les mécanismes qui ne dépendent QUE du
  transcript (occupation, hygiène de lecture) tournaient déjà et avaient mesurablement changé les
  pratiques. Découpler « plomberie invisible » (ledger, auto-créée) de « scaffolding visible »
  (CLAUDE.md/AGENTS.md, toujours confirmé sur un projet mature) fait tourner la couche la plus
  utile sans toucher au consentement sur ce qui affecte réellement le repo de l'utilisateur.
- **Init d'un projet en cours par augmentation taguée, pas par templates** : sur un projet qui
  a déjà son `CLAUDE.md`, `copyIfAbsent` sautait tout — `/pmz-init` ne produisait rien de
  visible et les règles PMZ n'entraient jamais dans les fichiers existants (vécu comme
  « pmz-init ne marche pas »). Fusionner intelligemment serait fragile ; on applique la même
  philosophie que `merge-settings` : bloc append-only, tagué, idempotent, réversible.
- **Handoff : un seul fichier écrasé, pas d'historique** : des fichiers par session
  s'accumuleraient (bloat) et poseraient la question du nettoyage ; le handoff n'a de valeur
  que pour la session suivante — l'état antérieur est déjà dans git/CHANGELOG. Le hook Stop ne
  pouvant pas générer un handoff riche (pas d'accès au modèle), l'auto mécanique garantit un
  plancher toujours présent, et le manuel de `/fresh-session` l'enrichit quand l'utilisateur
  clôture proprement.
- **Rappels qui nomment la commande exacte** (`/close-batch`, `/fresh-session`) plutôt qu'une
  prose générique : le même audit a montré que les skills PMZ n'étaient invoqués que quelques
  fois sur 76 sessions malgré des rappels de coût réguliers — l'écart entre « le mécanisme
  passif tourne » et « le mécanisme actif est suivi » vient en partie du fait qu'il fallait
  deviner la commande.
- **Clôture proposée en fenêtre à choix (OK/Non), jamais auto-exécutée** : quand le LLM estime
  un lot fini, il doit poser la question via l'outil de question à choix cliquable (pas du texte
  de chat), et attendre le OK avant de dérouler `/close-batch` (commit inclus). C'est une
  instruction comportementale (`MSG_ACTIF`, `MSG_CLOTURE` dans `lib/messages.js`, et
  `templates/CLAUDE.md`) — les hooks restent fail-open et ne peuvent pas ouvrir de dialogue
  bloquant, donc ils ne font que *rappeler* de poser la question, jamais la poser eux-mêmes ni
  committer. Alternative écartée : auto-exécution complète (commit compris) sans attendre de
  validation — rejetée parce qu'elle casse le principe « fait = prouvé » (personne ne vérifie le
  jugement du LLM sur « j'ai fini ») et la règle « ne jamais committer sans demande explicite ».
- **Maille User Story : non** (audit pilotage 2026-07-12) : une maille n'existe que si elle
  change une décision opérationnelle — quelle session, quel modèle, quel commit, quel ordre ;
  la US n'en change aucune quand l'exécutant est Claude. `title` + `scope` « fait quand : … »
  est la US compressée (le critère d'acceptation sans la cérémonie) ; la granularité sous-lot
  reste les todos volatiles (`todo-snapshot.json`). Pas de hiérarchie epic→feature→lot : une
  « feature » = un epic court (2-5 lots).
- **Epic = label, pas conteneur** : pas de table `epics[]` ni de cycle de vie d'epic — un label
  (fichier `.vibe-agent/epic`, écrit par `/pmz-scope` via `backlog.js epic --set`, + champ
  optionnel `epic` du lot backlog, cap 60c, lot #28) suffit pour le titre de session et le
  filtrage (`backlog.js show --epic`). Le champ du lot prime sur le label global dans
  `titleForBacklogLot`/`suggestedTitle` et dans `about.js` (lot en cours, sinon prochain, sinon
  label global) — permet un backlog multi-epics sans hiérarchie. Le multi-epics arbitré est un
  problème que l'historique réel du backlog (exécution strictement séquentielle) n'a jamais
  rencontré ; une table d'epics avec statuts et arbitrages serait le début du Jira que
  `backlog.js` refuse par principe.
- **Distribution cible = plugin Claude Code** (epic D, lots #30-#33) : les hooks portés par le
  `hooks/hooks.json` du plugin suppriment le merge de `settings.json` pour les nouveaux
  installés (le mécanisme le plus risqué de PMZ), versioning/update natifs via `plugin.json`,
  marketplace = dépôt git (privé, à un tiers — entreprise/équipe/communauté — via
  `extraKnownMarketplaces` ; **public GitHub = objectif lointain**, même mécanique). L'installeur Node (#22) reste le canal legacy et devient l'outil
  de migration (`merge-settings.js --remove` + purge, doctor détecte la double install). Le bloc
  projet `pmz:rules` dans CLAUDE.md/AGENTS.md est conservé tel quel (pas de pivot
  `.claude/rules/` : même couche de cache, deux véhicules = divergence garantie avec Codex).
- **Adoption avant features** (audit pilotage 2026-07-12) : l'audit d'usage réel ci-dessus
  (skills invoqués quelques fois sur 76 sessions) fait de l'adoption le risque n°1 — aucune
  nouvelle commande sans preuve d'usage des 7 existantes ; enrichir l'existant (messages,
  champs, hooks déjà branchés) plutôt qu'élargir la surface.
