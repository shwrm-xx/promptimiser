# ARCHITECTURE — Promptimizer

Capture la couche **stable** et le non-greppable. Le code fait foi pour le détail volatil.

## Vue d'ensemble

PMZ = un package installé dans `~/.claude/` qui branche **6 hooks Claude Code** + une **skill
globale** + des **slash commands** + des **scripts** + des **templates** + un **delta Codex**.
Le dépôt en est la source (miroir plat → `~/.claude/`, cf. [CLAUDE.md](CLAUDE.md)).

```
Promptimizer
├─ Project Initializer      (session-start + bootstrap-project/lib/bootstrap.js + /init ;
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
| `user-prompt-submit.js` | UserPromptSubmit | `prompt`, `cwd`, `transcript_path` | `additionalContext` | auto-`git init`+scaffold si aucun `.git` et prompt de démarrage, détecte init/large (anti-spam 1×/session), nudge occupation ≥ 500k en 2 lignes (anti-spam 1×/palier, lot B5), vigie modèle réel vs préconisé du lot en cours (anti-spam 1×/session, lot #42) |
| `pre-tool-use.js` | PreToolUse `Bash` | `tool_input.command` | `permissionDecision` allow/ask/deny | sûreté commandes |
| `post-tool-use.js` | PostToolUse `Read\|Edit\|Write\|TodoWrite` | `tool_input.file_path`, `tool_input.todos` | `additionalContext` (rare, advisory) + effet de bord ledgers | auto-crée le ledger si absent, journalise lectures/édits, capture la todo-list (`todo-snapshot.json`, écrasé à chaque TodoWrite), signale une relecture complète redondante (lot B4) |
| `stop.js` | Stop | `stop_hook_active`, `transcript_path` | `systemMessage` | alerte coût (paliers fixes + flottant), **métrologie par tour** (tour coûteux + cache-busts, `lib/turnstats.js`), hygiène de lecture, rappel de clôture nommant les skills, incrémente le compteur de lot, agrège le coût réel du lot en cours (`cost_tokens`) et alerte à l'approche du budget ~300k avec proposition de redécoupage (lot #43), auto-clôt le lot backlog en cours (cas univoque : exactement un `in_progress`) et annonce le suivant, exécute la `verify` du lot à l'auto-clôture (timeout court `VERIFY_AUTOCLOSE_MS`, résultat visible, jamais bloquant) + rappel doux si le commit de clôture ne touche pas `CHANGELOG.md` (lot #44), écrit le handoff auto (écrasé à chaque tour) |
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
     (`/init`) sur un projet **mature** (au moins un commit) ; il est posé automatiquement,
     sans confirmation, uniquement sur un projet **neuf** (0 commit, voire aucun `.git` — PMZ fait
     alors `git init` lui-même) où il n'y a par construction rien à écraser.
   - Sur un projet **en cours** dont `CLAUDE.md`/`AGENTS.md` existent déjà, `/init`
     (`bootstrap-project.js --augment`) **ajoute en fin de fichier** la section « Règles
     Promptimizer » taguée (`pmz:rules:start/end`, `templates/pmz-rules.md`) : append-only,
     idempotent (les templates portent le même marqueur, donc un fichier issu du scaffold n'est
     jamais ré-augmenté), réversible en supprimant le bloc. Les hooks n'augmentent **jamais** —
     ce mode est réservé au flux `/init` explicite, derrière confirmation.
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
- **Vigie modèle réel vs préconisé** (`lib/modelwatch.js`, lot #42) : `user-prompt-submit.js`
  lit le `model` du dernier message assistant du transcript (même méthode fenêtrée que
  `occupancy.js: readLastOccupancy` — lecture seule, aucune dépendance ledger) et le compare
  au `model_hint` du lot backlog `in_progress`. Correspondance par **sous-chaîne** insensible
  à la casse (`modelsDiffer` : le hint est un mot-clé libre — « sonnet » — le modèle réel un id
  complet — « claude-sonnet-5 ») plutôt qu'une énum à resynchroniser à chaque nouveau modèle.
  Nudge `additionalContext` court, plafonné **1×/session** (clé `model_mismatch` dans
  `prompt_reminders`, même state que les autres rappels du hook — repart à zéro sur nouvelle
  `session_id`) : le modèle ne change normalement pas en cours de session, une seule alerte
  suffit à signaler un mauvais démarrage. Fail-open total (backlog absent, transcript
  illisible, aucun lot en cours ou sans `model_hint` → silence, jamais de blocage).
- **Coût réel par lot** (`backlog.js: addCost`, lot #43) : `stop.js` agrège chaque tour les
  **tokens de sortie** du tour (`turnstats.computeTurn().out`) sur le lot `in_progress`, dans
  le champ `cost_tokens` du lot lui-même — donc **agrégat trans-session** (porté par le lot,
  pas par l'état de session), figé de fait à la clôture et affiché par `backlog.js show`. La
  sortie est choisie plutôt que l'occupation car elle est **monotone, sommable et robuste à la
  compaction** (l'occupation est un instantané remis à zéro en session fraîche). Au-delà de
  `COST_WARN` (250k), `stop.js` émet un nudge `systemMessage` proposant un **redécoupage**
  (budget `COST_BUDGET` = ~300k/lot, aligné sur la règle de découpe de `scope.md`), message
  durci au-delà de 300k. Plafonné **1× par lot·session** (`cost_reminded_for_batch`, réarmé
  quand le working tree redevient propre — nouveau lot). Fail-open dédié : une erreur
  d'agrégation ne casse jamais la clôture. `cost_tokens` ne s'accumule que sur un lot
  `in_progress` (un lot à faire/clos ne consomme pas) ; `addCost` est un no-op sur `tokens ≤ 0`.
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
  un titre de session suggéré selon la nomenclature **« [XXX · #Y] PlanTitle · Lot #X · résumé »**
  (validée utilisateur 2026-07-13 ; `XXX` = trigramme du projet ; `#Y` = **ID backlog global** du
  lot, accolé au trigramme — le `#N` de `backlog.js show`, monotone sur tout le projet ; `PlanTitle`
  = nom de plan ≤ 3 mots = l'`epic` du lot borné à 3 mots ; `Lot #X` = **rang du lot dans son plan**
  (`lotRankInEpic`), accolé au nom de plan, remis à zéro à chaque plan — colle au modèle mental
  « lot 1..5 de CE plan », contre le `#Y` global jugé absurde par l'utilisateur qui voyait « #40 »
  sur un plan de 5 lots ; `résumé` = focus du lot, préfixe métier « Lot X — » redondant retiré).
  Un lot **sans epic** (pas de plan nommé) bascule sur **« [XXX · #Y] Session Libre · résumé »** —
  sans `Lot #X` (aucun plan où le ranger) mais l'`#Y` accompagne toujours le trigramme. Sans lot du
  tout (titre déduit du CHANGELOG/commit) : **« [XXX] Session Libre · résumé »** (pas d'`#Y` à
  afficher). Construit sur le lot
  backlog le plus pertinent (`lib/lot.js: suggestedTitle`) — priorité : lot **en cours** (travail qui continue) >
  lot **attribué à la session précédente** (`lotClosedBySession` : `closed_session_id === previousSessionId`,
  cf. plus bas — chemin **primaire**, ajouté v1.1.5) > dernier lot **clos** (repli sans attribution
  possible) > prochain lot à faire (dernier recours). L'attribution est le vrai signal « qu'a fait
  la session précédente » : chaque session clôt son propre lot, donc 3 sessions successives
  reçoivent 3 titres **distincts** (retour utilisateur japlan-app : 3 sessions nommées à
  l'identique « #34 » — fix 2026-07-13). En repli, le « dernier » lot clos est celui au plus grand
  **`id`** — **ni** `lot_number` (compteur global recyclé/`null`, figeait « Lot 7 » — fix 2026-07-12),
  **ni** `closed_at` : cet horodatage s'est révélé **non fiable** sur données réelles (dates à la
  journée, valeurs saisies à la main, clôtures dans le désordre — un vieux #34 au `closed_at`
  postérieur au vrai dernier #40 → titre figé). L'`id` backlog est monotone, jamais recyclé, jamais
  `null` (cf. `addLot`) : seul référentiel stable pour le repli. **Le N affiché est l'ID backlog du lot retenu** (`lib/backlog.js`, le
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
  `suggestedTitle` retombe sur **« Session Libre »** et lui **déduit** un résumé des infos disponibles plutôt que de rester nu : dernier
  résumé `CHANGELOG.md` (parenthèse finale du dernier titre `##` — convention de ce dépôt — ignorée
  si ce n'est qu'un marqueur `(lot N)` non descriptif), sinon sujet du dernier commit. Cette
  déduction ne s'applique **jamais** quand le plan contient un lot mais qu'il est écarté comme
  périmé (cas ci-dessus) : un titre existe alors dans le plan, il est volontairement tu — le
  remplacer par une supposition externe reviendrait à mentir de la même façon que ce que le fix
  visait à éliminer. Puis demande à l'assistant de **proposer** ce nom en clair **et de poser une
  question à choix IMMÉDIATE** (valider / autre nom / non) **en tout début de 1er tour, avant de
  traiter la demande** — retour utilisateur 2026-07-12 (v1.1.1) : un renommage proposé en fin de
  tour ou sans dialogue n'est jamais traité — puis de tenter le renommage réel
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
  `opus`) et **effort de raisonnement** (`effort_hint`, énum `low|medium|high|xhigh`, lot #41),
  commit de clôture, et `closed_session_id` (session qui a clos le lot — `null` si
  clôture manuelle via le CLI sans id, jamais deviné). Au plus un `in_progress` ; cap 20 lots
  ouverts ; `doneLot` idempotent. `model_hint` est **obligatoire à l'`add` CLI** (refus doux sans `--model`) ;
  `effort_hint` est optionnel mais refusé (doux) si `--effort` est fourni hors énum. Les deux sont
  **réaffichés** partout où un lot est rendu (`show`/`start`/`next`, `summaryLines` → handoff auto)
  sous forme combinée `[modèle : … · effort …]` (`lib/backlog.js: modelEffortTag`) — jamais perdu
  silencieusement. Écrit par l'assistant (CLI) ; **auto-clos par `stop.js`**
  quand le working tree redevient propre et qu'exactement un lot est `in_progress` (sinon ne
  touche à rien — réconciliation bête via `backlog.js reconcile`). Jamais de promotion
  automatique du suivant. Champ optionnel `verify` (cap 150c, `MAX_VERIFY`, lot #29) : commande
  shell de preuve de clôture, posée à l'`add --verify` ou éditée après coup (`backlog.js verify
  --id N --set "…"`) — exécuté par `lib/project.js:runVerify` (helper partagé, ne throw jamais :
  `{ok}` / `{ok:false, timedOut, tail}`). `/close-batch` (`scripts/close-batch.js`) l'appelle avec un
  timeout large (20 s) avant d'indiquer le `done` et affiche OK/ÉCHEC (refus doux, **jamais bloquant**
  — même en échec la checklist reste exit 0, la décision de clore reste humaine/assistant). À
  l'**auto-clôture** (lot #44), `stop.js` l'exécute aussi mais avec un timeout **court**
  (`VERIFY_AUTOCLOSE_MS` = 2500 ms, borné bien en deçà du watchdog Stop 4,5 s) : lancé **après** que
  `doneLot` a persisté (un dépassement de watchdog ne peut donc pas corrompre le backlog), résultat
  rendu visible par `messages.js:closureProofMessage` — une non-terminaison dans le délai court est
  affichée « non terminée » (relancer via `/close-batch`), **pas** « ÉCHEC ». Le même message porte
  un **garde-fou CHANGELOG** : rappel doux si le commit de clôture (HEAD, tree propre ⇒
  `changelogTouched` se réduit au dernier commit) ne touche pas `CHANGELOG.md`. try/catch dédié →
  fail-open : la clôture reste acquise même si la preuve échoue. Champ `closed_occupancy` (lot #29) :
  occupation contexte du tour figée par `stop.js` à l'auto-clôture (`turnstats.computeTurn().occ`,
  métrologie de coût par lot) — `null` sur une clôture manuelle via le CLI (pas de transcript à ce
  niveau). Champ `cost_tokens` (lot #43) : coût réel cumulé du lot = tokens de sortie sommés par
  `stop.js` sur tous les tours où il était `in_progress` (`addCost`) — agrégat trans-session porté
  par le lot, figé de fait à la clôture, affiché par `show` ; cf. puce « Coût réel par lot » plus
  haut. **Durabilité par défaut** (le backlog ne doit JAMAIS être perdu) : le
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
  un projet cible (ce n'est pas leur version à eux). `scripts/about.js` (commande `/about`)
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

### Statusline opt-in (lot #45)

Barre d'état Claude Code **opt-in** : `PMZ v<version> · <epic> · lot #<id> <titre> · <faits>/<total> · ctx <occupation>`.
`scripts/statusline.js` reçoit le JSON stdin de Claude Code (`transcript_path`, `workspace.current_dir`)
et n'émet qu'**une** ligne (fail-open total : toute erreur → ligne vide + exit 0 ; kill-switch
`PMZ_DISABLE`). Occupation lue en temps réel via `occupancy.readLastOccupancy` (indépendante de
l'état projet) ; epic/lot/progression via le backlog du projet déduit du cwd. Assemblage confié à
la fonction **pure** `messages.statusLineText` (testable sans disque/stdin, saute toute partie absente).

Câblage dans `merge-settings.js` (`--statusline` / `--statusline-remove`), exposé par la commande
`/statusline`. **Invariants** : (1) pose **uniquement sur demande explicite**, jamais dans l'install
par défaut ; (2) ne remplace **jamais** une `statusLine` tierce (détectée → préservée + note, PMZ non
posée) ; (3) `--statusline-remove` et la désinstallation (`--remove`) ne retirent que **notre** entrée
(tag `promptimizer/scripts/statusline.js`), jamais une tierce ; (4) `--check` rapporte
`statusline: none|pmz|third-party`. **Chemin stable** : le renderer pointé dans `settings.json` vit
sous `pmzDir()` = **miroir manuel** `~/.claude/promptimizer/scripts/`, HORS du dossier versionné du
plugin → survit aux updates. Conséquence : la statusline est une feature du **canal manuel** (comme
les hooks-dans-`settings.json` — le canal plugin ne touche jamais `settings.json`) ; `statusline.md`
est **exclu du build plugin** (il invoque `install/merge-settings.js`, absent du plugin).

### Canal plugin Claude Code (lot D2, alternatif à l'install manuelle)

Le format plugin impose `commands/`, `skills/`, `hooks/hooks.json` **à la racine du plugin**, sans
chemin personnalisable — incompatible avec le miroir plat source. Plutôt que de casser ce miroir
(canal manuel conservé), `install/build-plugin.js` en **dérive** un dossier plugin self-contained
dans `dist/marketplace/` (gitignoré) : copie de `promptimizer/` **moins `install/`**, skill
replacée sous `skills/promptimizer/`, chemins `~/.claude/promptimizer` réécrits en
`${CLAUDE_PLUGIN_ROOT}` dans commands + skill (substitués inline par Claude Code), version du
manifeste alignée sur `VERSION`, `marketplace.json` locale à **source string relative**
(`"./promptimizer"`). Zéro duplication committée — le plugin est un artefact de build.

- **Garde-fou `REQUIRED_COMMANDS`** (`build-plugin.js`, v1.1.4) : liste EXPLICITE des commandes
  que le plugin doit porter ; le build **échoue** (exit 1, message nommant la commande + marche
  à suivre) si l'une manque du dossier assemblé. À éditer consciemment quand on ajoute/retire une
  commande — une suppression accidentelle de la source la fait diverger et bloque le build avant
  tout redéploiement (anti-régression du cleanup `7533d72`, cf. CHANGELOG v1.1.3).
- **Câblage des hooks** : `hooks/hooks.json` statique (6 hooks, mêmes matchers/timeouts que
  `merge-settings.js`) remplace l'écriture dans `settings.json`. Commande =
  `sh "${CLAUDE_PLUGIN_ROOT}/bin/pmz-hook" "${CLAUDE_PLUGIN_ROOT}/hooks/x.js"`.
- **Wrapper `bin/pmz-hook`** : résout `node` **au runtime** (PATH puis emplacements usuels absents
  du PATH GUI macOS) — remplace le `resolveNodeBin()` de `merge-settings.js`, inutilisable pour un
  plugin distribué (chemin machine-spécifique). Invoqué via `sh` car le bit +x n'est pas préservé
  en `.zip`. Fail-open : `node` introuvable → exit 0 silencieux.
- **Diagnostic** = `claude plugin details pmz` (natif). `doctor.js` reste l'outil du
  canal manuel (exclu du plugin) mais est **conscient du canal plugin** (lot E3) : lancé depuis
  le dépôt sur un poste en plugin, il détecte le plugin (env `CLAUDE_PLUGIN_ROOT`,
  `enabledPlugins`, `installed_plugins.json`) et rend **vert** sans exiger le câblage manuel
  dans `settings.json` — sinon il concluait « rouge » sur une install saine (retour utilisateur
  2026-07-12). Aucun doctor CLI n'est embarqué dans le plugin (un `/pmz:doctor` serait un lot à
  part). Depuis v1.1.2, il détecte aussi la **dérive de version** ci-dessous : source (son
  propre arbre) EN AVANCE sur le plugin installé (`VERSION` du cache, repli
  `installed_plugins.json`) → avertissement + statut orange avec la marche à suivre. Seule
  cette direction alerte (cache en avance = simple checkout en retard, pas un défaut d'install).
- **Dérive silencieuse source ↔ installé** (post-mortem v1.1.1, 2026-07-13) : Claude Code
  **copie** le plugin dans `~/.claude/plugins/cache/<marketplace>/pmz/<version>/` — il n'exécute
  PAS `dist/marketplace` en place. Committer dans la source (voire rebuilder `dist/`) ne change
  **rien** au comportement des sessions tant que (1) `VERSION` n'est pas bumpée, (2) le build
  n'est pas relancé, (3) `claude plugin update pmz@pmz-local` n'est pas passé (+ redémarrage).
  Symptôme vécu : nomenclature v1.1.0 committée mais cache figé en 1.0.0 → titres à l'ancien
  format sur tous les projets. Tout lot touchant `hooks/`/`lib/` doit finir par ces 3 étapes.
- **Régression assumée** (cf. D1) : pas de takeover réversible d'un hook Stop tiers en plugin ;
  commandes namespacées `/pmz:*`.
- **Identifiant plugin = `pmz`, pas `promptimizer`** (lot E1) : le namespace des commandes est
  piloté directement par `plugin.json` `name` (constat empirique du spike D1, pas configurable
  séparément) — `name: "pmz"` donne `/pmz:about`, `/pmz:scope`, etc., et aligne le canal plugin
  sur les commandes déjà nommées `/pmz-*` du canal manuel. L'identité « Promptimizer » reste le
  nom du projet (description du manifeste, README, branding) ; seul l'identifiant technique
  change. Le dossier source `promptimizer/` (miroir plat) et le nom de dossier du plugin
  assemblé restent inchangés — seule la déclaration `name` et les commandes d'install/diagnostic
  qui la référencent (`marketplace.json`, `build-plugin.js`, `migrate-to-plugin.js`, doc) sont
  mis à jour.

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
  ferait tirer les hooks deux fois) = **hooks PMZ legacy présents dans `settings.json` ET plugin
  actif par ailleurs**. « Plugin actif » se lit sans dépendre de la commande `claude` (absente du
  PATH GUI macOS) : env `CLAUDE_PLUGIN_ROOT`, `enabledPlugins`, ou `plugins/installed_plugins.json`
  (lot E3 — remplace l'ancien `claude plugin list` best-effort). Statut `orange` + rappel de
  `migrate-to-plugin.js`.
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
- **Canal GitHub public (lot #38)** : documenté et outillé. Prérequis : dépôt **public**
  (`marketplace add owner/repo` lit sans authentification). `install/publish-plugin.js` assemble
  `dist/marketplace/` (via `build-plugin.js`) et le pousse **seul** sur la branche orpheline
  `plugin-release` (aucun historique partagé avec `main` ; push uniquement si `--push` explicite).
  Côté utilisateur : `claude plugin marketplace add shwrm-xx/promptimiser@plugin-release` puis
  `claude plugin install pmz@pmz-marketplace`. Même mécanique `extraKnownMarketplaces` (source
  `github`) pour éviter le `marketplace add` par poste.
- **Windows non testé réel dans ce lot** : pas de machine Windows disponible dans l'environnement
  d'exécution de ce tour ; les wrappers (`bin/pmz-hook`) et la résolution de chemins
  (`claude-dir.js`) restent donc vérifiés seulement par lecture de code + tests unitaires
  (bac à sable macOS), pas par exécution réelle sous Windows.

### Canal OpenCode (epic « PMZ OpenCode », lots OC1–OC4)

Troisième canal, pour [OpenCode](https://opencode.ai) (≥ 1.18) : la source vit dans
`opencode/` (frère de `codex/`), la **doctrine détaillée** (layout installé, table de mapping
hooks Claude Code → OpenCode, stratégie d'occupation relative à la fenêtre du modèle, gaps
assumés) dans [`opencode/NOTES.md`](opencode/NOTES.md) — source de vérité du portage, non
dupliquée ici. Ce qui est structurant :

- **Libs cœur partagées, vendorées par copie** : `install-opencode.js` copie
  `promptimizer/{lib,scripts,templates,VERSION}` vers `<config opencode>/pmz/` — source
  unique, aucun require inter-dossiers au runtime. `pmz/state/` est préservé aux réinstalls.
- **Plugin in-process** : loader ESM fin (`plugin/pmz.js`) → cœur CJS (`pmz/impl/`) via
  `createRequire`, compatible avec le runtime Bun embarqué d'OpenCode (prouvé au lot OC1).
  Mêmes invariants que les hooks Claude Code : fail-open absolu (`bridge.guard()`),
  kill-switch `PMZ_DISABLE=1` — sauf `tool.execute.before`, seul hook hors `bridge.guard()`
  car son deny volontaire (commande Bash catastrophique) EST un throw délibéré (lot OC2).
- **Sûreté Bash partagée** : `promptimizer/lib/bash-guard.js` (`classify`, pure) sert à la
  fois `pre-tool-use.js` (Claude Code) et `pmz/impl/index.js` (OpenCode, vendoré). Deny
  catastrophique bloqué par throw dans `tool.execute.before` ; tiers destructif resserré en
  `ask` via `permission.ask` **seulement si** OpenCode a déjà un contrôle de permission actif
  pour l'appel — sans ce contrôle (bash `"allow"` global), le tiers destructif n'a pas de
  filet actif (gap v1 assumé, voir NOTES).
- **Ledgers** (`tool.execute.after`) : réutilise `promptimizer/lib/{project,ledger,backlog}.js`
  tels quels, avec `root = input.directory` fourni par OpenCode (pas de dérivation git).
- **Pas de merge de settings** : l'installer ne pose que `plugin/pmz.js`, `command/pmz/` et
  `pmz/` — il ne touche jamais `opencode.json` ni un plugin/commande tiers.
- **État projet `.vibe-agent/` partagé** avec Claude Code (backlog/handoff cross-outil).
  Règle : pas deux sessions simultanées sur un même projet ; un `model_hint` non résoluble
  par un côté est ignoré silencieusement.
- **Tests** : `test/run-tests-opencode.js` (bac à sable auto), invoqué par `run-tests.js` —
  la cible réelle `~/.config/opencode` n'est jamais touchée par les tests.

### Namespace plugin `pmz` (lot E1)

Voir section « Canal plugin Claude Code » ci-dessus (§ Identifiant plugin = `pmz`).

### Titres de session : trigramme + focus du lot + numérotation partie (lot #35)

Refonte du format de titre suggéré (`lib/lot.js: suggestedTitle`), suite à un retour direct sur
la répétition du nom de projet, la double numérotation et le mélange de langue observés sur
plusieurs sessions réelles (capture fournie par l'utilisateur, 2026-07-12).

- **Trigramme de projet (`lib/trigram.js`, `.vibe-agent/trigram`)** remplace le nom complet du
  projet en préfixe (`[XXX]` au lieu de `promptimiser — …` / `japlan-app — …`) — répété sur
  chaque ligne de la liste de sessions, il n'apportait aucune information une fois le projet
  identifié par son panneau. Dérivé par défaut (3 premières lettres alpha du nom de dossier,
  ex. `japlan-app` → `JAP`) ; un projet **déjà initialisé** garde cette dérivation sans
  interruption (pas de prompt forcé rétroactif — décision utilisateur, 2026-07-12) ; à la
  création d'un **nouveau** projet, `/init` propose 3 trigrammes (`backlog.js trigram
  --suggest`) + saisie libre. Modifiable à la main : `backlog.js trigram --set XXX`.
- **Le focus du lot backlog prime, plus de double numérotation** : l'ancien format
  (`${epic} — Lot ${id} : ${titre}`) affichait DEUX numéros de sens différent — l'ID backlog
  (`Lot 32`) et la numérotation métier embarquée dans le titre du lot lui-même par convention de
  rédaction (`Lot D3 — …`). Le nouveau format (`titleForLot`) ne garde que `[XXX] ${titre du
  lot}` — le titre du lot (déjà rédigé par `/scope`, avec sa propre numérotation métier
  quand pertinent) est la seule source de vérité affichée ; l'ID backlog reste un identifiant
  interne (CLI `backlog.js show`/`start`/`done`), jamais dans le titre de session. Le champ
  `epic` (label de groupement/filtrage, `backlog.js show --epic`) n'apparaît plus non plus dans
  le titre — orthogonal au focus du lot, il resterait redondant avec la numérotation métier déjà
  embarquée dans le titre par convention.
- **Suffixe `(partie N)`** (`backlog.js: touchLot`, champ `lot.session_touches`) quand un même
  lot reste `in_progress` sur **plus d'une session** : incrémenté une fois par vrai démarrage de
  session (`suggestedTitle`, jamais au resume/compact) tant que le lot n'est pas clos, remis à
  zéro par `startLot` (un nouveau départ repart de « partie 1 », silencieuse). Le total `N` final
  n'est connu qu'à la clôture (pas de `/N` affichable à l'avance, décision utilisateur) — un lot
  clos n'affiche plus jamais de suffixe (le travail est fini, peu importe combien de sessions ça
  a pris). Approximatif par construction, même logique assumée que `lot-counter.json` : avance
  même si la session qui vient de se terminer n'a en fait pas touché ce lot précis.
- **Langue** : tout le texte généré par `suggestedTitle`/`titleForLot` est en français (aligné
  sur la convention du dépôt) — un titre manuellement tapé par l'utilisateur dans un autre
  langage reste hors de portée (pas de traduction automatique, PMZ ne génère que sa propre
  suggestion).

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
  inerte dès que `/init` n'est jamais lancé, alors que les mécanismes qui ne dépendent QUE du
  transcript (occupation, hygiène de lecture) tournaient déjà et avaient mesurablement changé les
  pratiques. Découpler « plomberie invisible » (ledger, auto-créée) de « scaffolding visible »
  (CLAUDE.md/AGENTS.md, toujours confirmé sur un projet mature) fait tourner la couche la plus
  utile sans toucher au consentement sur ce qui affecte réellement le repo de l'utilisateur.
- **Init d'un projet en cours par augmentation taguée, pas par templates** : sur un projet qui
  a déjà son `CLAUDE.md`, `copyIfAbsent` sautait tout — `/init` ne produisait rien de
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
  (fichier `.vibe-agent/epic`, écrit par `/scope` via `backlog.js epic --set`, + champ
  optionnel `epic` du lot backlog, cap 60c, lot #28) suffit pour le filtrage (`backlog.js show
  --epic`) et l'affichage `about.js` (lot en cours, sinon prochain, sinon label global). Le champ
  du lot prime sur le label global dans `about.js` — permet un backlog multi-epics sans
  hiérarchie. Depuis le lot #35, l'epic n'apparaît plus dans le titre de **session**
  (`suggestedTitle`/`titleForLot`, remplacé par le trigramme + le focus du lot, cf. section
  dédiée) — il reste utile pour le filtrage/l'affichage `about.js` seuls. Le multi-epics arbitré est un
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
