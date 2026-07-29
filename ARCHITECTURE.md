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
├─ Context Budget Controller (occupancy.js : paliers fixes + flottant, hygiène de lecture,
│                             borne d'occupation réglable par projet via rules.yaml/lib/rules.js)
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
| `session-start.js` | SessionStart `startup\|resume\|clear\|compact` (injecte au `startup`/`clear` ; `compact` → réinjection **enrichie** sous budget chiffré (`COMPACT_RESUME_CAP`, #72) : lot+verify + `pmz:skip` + résumés connus + todos ; `resume` → nudge occupation seul, voir ci-dessous) | `cwd`, `source`, `transcript_path` | `additionalContext` (startup/clear/compact) ou `systemMessage` (resume) | détecte projet, auto-scaffold si projet neuf (0 commit), sinon propose init, rappel court + titre de session suggéré + injecte le handoff de la session précédente puis le marque consommé ; sans handoff, le plan de lots sert de filet (2 lignes) ; au `resume`, si occupation ≥ 300k, `systemMessage` d'occupation (lot B5, zéro token injecté) |
| `user-prompt-submit.js` | UserPromptSubmit | `prompt`, `cwd`, `transcript_path` | `additionalContext` | auto-`git init`+scaffold si aucun `.git` et prompt de démarrage, détecte init/large (anti-spam 1×/session), nudge occupation ≥ 500k en 2 lignes (anti-spam 1×/palier, lot B5), vigie modèle réel vs préconisé du lot en cours (anti-spam 1×/session, lot #42) |
| `pre-tool-use.js` | PreToolUse `Bash` (+ `Edit`/`Write`/`MultiEdit` en vague) | `tool_input.command` / `.file_path` | `permissionDecision` allow/ask/deny **ou** `updatedInput` (réécriture RTK, sans `permissionDecision`) | sûreté commandes + périmètre fleet-fille + **bridge RTK optionnel** (default OFF, lot #81) |
| `post-tool-use.js` | PostToolUse `Read\|Edit\|Write\|TodoWrite\|Bash` | `tool_input.file_path`, `tool_input.todos`, `tool_input.command` + `tool_response` (Bash) | `additionalContext` (rare, advisory) **ou** `updatedToolOutput` (réduction sortie Bash, lot #84) + effet de bord ledgers | auto-crée le ledger si absent, journalise lectures/édits, capture la todo-list (`todo-snapshot.json`, écrasé à chaque TodoWrite), signale une relecture complète redondante (lot B4), **réduit une sortie Bash volumineuse** hors RTK (lot #84) |
| `stop.js` | Stop | `stop_hook_active`, `transcript_path` | `systemMessage` | alerte coût (paliers fixes + flottant), **métrologie par tour** (tour coûteux + cache-busts, `lib/turnstats.js`), **détecteur de dérive de session** (coût↑ + hitRate↓ sur 6 tours → prescrit la clôture, lot #62), **vigie des tours en boucle** (commande Bash qui échoue ≥ 3 fois d'affilée → nudge « change d'approche », anti-spam par commande, `lib/loopwatch.js`, lot #69), **vigie de dette git non commitée** (diff significatif qui grossit sur ≥ 3 tours sans commit → nudge « commit/clôture », anti-spam par palier, `lib/gitdebt.js`, lot #73), **vigie de gouvernance du CLAUDE.md** (absent ou hypertrophié > 10 Ko → nudge créer / dégraisser, 1×/session, `lib/claudemd.js`, lot #74), **notification OS opt-in** sur zone rouge et clôture de lot (`PMZ_NOTIFY=1`, `lib/notify.js`, lot #75), **borne d'occupation réglable par projet** (`budget.red_zone_tokens`/`red_zone_ratio` de `rules.yaml` via `lib/rules.js` — au franchissement, clôture prescrite y compris **en milieu de lot**, lot #112), hygiène de lecture, **nudge subagent** à haute occupation + lectures (lot #52), **palier de gaspillage auto-surfacé** avec top-3 coupables (`waste_bucket` persisté, lot #52), rappel de clôture nommant les skills **et embarquant un brouillon d'entrée CHANGELOG pré-mâché** (en-tête daté + lot/epic/titre, scope sans son préfixe « fait quand : », fichiers modifiés plafonnés à 6, verify — `closureWithDraftMessage`, soudé au rappel pour rester atomique sous l'arbitre, lot #68), incrémente le compteur de lot, agrège le coût réel du lot en cours (`cost_tokens`) — **coût des tours délégués à un sous-agent inclus** (`lib/subagentcost.js`, lot #119) et imputé **nominativement** au lot de la session (`costLotFor`, fin du vol de coût en vague) — et alerte à l'approche du budget ~300k avec proposition de redécoupage (lot #43), auto-clôt le lot backlog en cours (cas univoque : exactement un `in_progress`) et annonce le suivant, exécute la `verify` du lot à l'auto-clôture (timeout court `VERIFY_AUTOCLOSE_MS`, résultat visible, verdict calculé **avant** `doneLot` depuis le lot #111 — un `timeout` empêche la clôture, un `failed` non) + rappel doux si le commit de clôture ne touche pas `CHANGELOG.md` (lot #44), **plafonne les nudges du tour par sévérité** (`lib/arbiter.js`, ≤ 3, lot #57), écrit le handoff auto (écrasé à chaque tour) |
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
   du modèle, **non bloquant** (technique reprise de `context-guard.py`). Les nudges de ce canal
   portent un **glyphe de sévérité** (`lib/severity.js` : ℹ info / ⚠ warn / ⛔ alert) posé par les
   fabriques de `lib/messages.js` — les messages `additionalContext` (instructions injectées) n'en
   portent PAS (cf. « Grammaire de sévérité » dans Décisions).

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
- **Fenêtre de modèle & seuil zone-rouge relatif** (`lib/occupancy.js: MODEL_WINDOWS`,
  `windowForModel`, `redZoneThreshold`, `isRedZone`, lot #70) : les paliers `BUCKETS` ci-dessus
  sont **absolus**, pensés pour une fenêtre ~1M (Sonnet/Opus/Fable) — ils sur-estiment la marge
  réelle sur un modèle à fenêtre plus étroite (Haiku, 200k) et sous-estiment sur une fenêtre
  large. `windowForModel(model)` résout la fenêtre par sous-chaîne (même méthode que
  `modelwatch.js: modelsDiffer`), repli `DEFAULT_WINDOW` (200k) si modèle inconnu/absent.
  `redZoneThreshold(model)` = fenêtre × `RED_ZONE_RATIO` (0,85) — marge avant l'auto-compact du
  modèle. Lib pure, **aucun branchement hooks** dans ce lot (prescription au fil de la session :
  lot #71).
- **Prescription zone-rouge en fin de tour** (`lib/occupancy.js: evaluateRedZone` /
  `resyncRedZone`, `messages.js: redZonePrescriptionMessage`, câblés dans `stop.js`, lot #71) :
  au franchissement du seuil zone-rouge (#70) — relatif à la fenêtre du modèle réel lu au
  transcript (`modelwatch.readLastModel`, repli fenêtre prudente si absent) — `stop.js` pousse
  la prescription la **plus grave** (`SEV.ALERT` ⛔ : clôture + handoff + session fraîche AVANT
  de subir l'auto-compact lossy). Même politique d'anti-spam que le palier d'occupation :
  **1× par épisode** (fichier d'état dédié `redzone`, clé `session_id`), flag **jamais**
  redescendu sur une ligne `usage` maigre ; réarmé **uniquement** sur une vraie compaction
  (`turn.alerts.resync` de turnstats, delta < −100k) — `resyncRedZone` est appelé dans la même
  branche que `resyncBucket`. Fail-open dédié. Étant `ALERT`, la prescription prime et survit
  toujours au plafond de l'arbitre de tour (#57) ; à l'inverse, sur un modèle à fenêtre étroite
  (ou modèle non détecté → repli 200k) elle **peut évincer** un nudge `WARN` concurrent du même
  tour — c'est voulu (le signal grave passe avant le bruit). Canal OpenCode inchangé : son
  `occupancy-oc.js` calcule déjà l'occupation **relative à la fenêtre** nativement (buckets en
  %), hors périmètre #70/#71.
- **Borne d'occupation réglable par projet** (`lib/rules.js` + `lib/occupancy.js:
  configuredRedZone`/`resolveRedZone`, `messages.js: redZonePrescriptionMessage`, câblé dans
  `stop.js`, lot #112) : le seuil #70 ne mesure qu'une chose — l'imminence de l'auto-compact. Sur
  une fenêtre de 1M il tombe à 850k, un chiffre qu'une session atteint rarement : la borne ne
  mordait **quasiment jamais** alors que le coût de cache devient dissuasif bien avant. D'où un
  seuil lu par projet dans `.vibe-agent/rules.yaml`, bloc `budget:` — `red_zone_tokens` (absolu,
  prioritaire) ou `red_zone_ratio` (fraction de la fenêtre du modèle). **Décision** : le seuil vit
  dans `rules.yaml` et non en variable d'env / JSON séparé, parce que c'est déjà la surface de
  règles du projet — au prix d'un **lecteur de scalaires** (`lib/rules.js`), le zéro-dépendance
  interdisant une lib YAML. Ce lecteur n'est **pas** un parseur YAML et n'a pas vocation à le
  devenir : paires `clé: valeur` d'un bloc de premier niveau, un seul niveau d'indentation, rien
  d'autre (listes, sous-blocs, multi-lignes, ancres → ignorés en silence) ; `readNumber` traite une
  valeur hors bornes comme **absente** plutôt que de la raboter (`red_zone_ratio: 35` est une faute
  de frappe, pas une demande de 3500 %). Conséquences assumées : (a) rien de configuré, valeur
  aberrante, `rules.yaml` illisible ou hors repo → **régime #70 strictement inchangé**, donc zéro
  régression pour un projet existant (les clés sont livrées **commentées** dans le template) ;
  (b) `source` (`'config'` | `'window'`) accompagne le seuil jusqu'au message, qui change d'en-tête
  — annoncer « l'auto-compact approche » à 400k sur 1M serait faux, et une alerte fausse finit par
  être ignorée ; (c) le lot **en cours** est joint à la prescription, qui propose alors la clôture
  **en milieu de lot** (commit intermédiaire + `/fresh-session`, le lot reste ouvert) au lieu
  d'arbitrer « lot fini → … sinon → … » ; (d) `stop.js` résout la racine git **avant** la branche
  (a1) — un appel `gitRoot` déplacé, pas ajouté ; (e) **un seul épisode pour les deux régimes**
  (même fichier d'état `redzone`) : une borne basse consomme l'unique prescription de la session, et
  la zone haute reste couverte par les paliers absolus `BUCKETS` (500k/750k) + la dérive de session.
- **Réinjection post-compact enrichie** (`session-start.js` branche `src === 'compact'` +
  `messages.compactResumeMessage(lot, prog, { todos, skips, decisions })`, lot #72) : après une
  compaction le contexte survit mais a perdu le **plan** ET la **mémoire des relectures déjà
  faites**. On restitue donc, sous un **budget explicite chiffré** (`COMPACT_RESUME_CAP` = 1200
  chars), des blocs par priorité **décroissante** : identité du lot + `verify` (direction +
  preuve de clôture) → `pmz:skip` (ne pas relire, cœur de l'économie de contexte) → résumés
  connus (décisions, servis au lieu de relire) → todos. Le budget **empile bloc par bloc et
  s'arrête avant dépassement** — le 1er bloc (identité du lot) passe toujours, les blocs
  secondaires sont rognés **en bloc**, jamais coupés au milieu d'un chemin. Sources : `skips` =
  `ledger.avoidRereadNotes(root, 5)` (liste canonique « ne pas relire », tail = plus récent) ;
  `decisions` = `ledger.topSummaries(root, 3)` (`pmz:summary` connus). Silence total sans lot en
  cours (comme avant). Remplace la réinjection minimale ≤ 300 chars.
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
- **Détecteur de dérive de session** (`lib/turnstats.js: evaluateDrift`, lot #62) : au-delà du tour
  isolé, cherche une **tendance** sur les 6 derniers tours *exploitables* (delta ET hitRate connus —
  les tours baseline/compaction sont écartés). Chaque tour persiste désormais son hitRate (`h`) dans
  `turns.json`. On compare la moitié récente (3 tours) à l'ancienne (3 tours) : **dérive** = le delta
  d'occupation moyen grimpe (récent ≥ 1,3× l'ancien **et** ≥ 15k) **ET** le hitRate moyen chute
  (≥ 8 points). Les deux conditions sont requises : un tour ponctuellement cher (déjà couvert par
  « tour coûteux ») ou une seule pause de cache ne déclenchent pas. `systemMessage` **WARN** qui
  **prescrit la clôture** (`/close-batch` puis `/fresh-session`). Anti-spam dédié (`<sha1>-drift`,
  `{lastDriftTurn}`) : au plus 1 nudge par fenêtre de 6 tours. Fail-open (aucun état → `null`).
  Appelé par `stop.js` **après** `computeTurn` (lit l'historique qu'il vient d'écrire), indépendant
  du projet (transcript + état seuls → marche hors repo).
- **Moteur de mesure de session** (`lib/metrics.js` + `scripts/metrics.js`, lot #110) : le seul
  composant **hors bande** de la famille. `occupancy.js` et `turnstats.js` sont des capteurs temps
  réel appelés dans des hooks — queue du transcript, plafond de lecture, état incrémental ; le
  moteur fait l'inverse : **balayage complet** d'un ou N transcripts (`forEachLine`, blocs de 1 Mo,
  synchrone, O(1) mémoire) pour produire des statistiques agrégées. Aucun hook ne l'appelle et
  aucun ne doit l'appeler (coût de lecture) ; il est invoqué à la main ou par une commande.
  Cinq indicateurs, avec ce que chacun décide :
  **préfixe** = plus petite taille de prompt de la session (socle système + outils + CLAUDE.md +
  skills + injections de hook — le plancher payé avant toute conversation) ;
  **occupation** = médiane / p90 / max des tailles de prompt (`input + cache_creation + cache_read`
  sur les entrées `type:"assistant"` non-sidechain) ; **accrétion** = pente de la régression de
  `prompt(t)` sur l'index de tour, en tokens/tour ; **décomposition du cache-read** en 4 postes
  (`préfixe×T`, `output×k`, `tool_results/3,6×k`, `(texte user + attachements)/3,6×k`, avec
  `k = (T−1)/2` relectures moyennes d'un token émis) ; **loi d'échelle** = exposant de la régression
  log-log du coût sur le nombre de tours. Le dernier est celui qui commande la doctrine : mesuré
  **> 1** (≈ 1,2 sur le coût, ≈ 1,5 sur le cache-read), il dit que scinder une session en deux
  coûte moins cher que la laisser courir — d'où la prescription de session fraîche.
  La décomposition embarque son propre **contrôle de validité** (`ratio = somme / cache-read réel`,
  viser ≈ 1,0) : au-delà de 1,15 le CLI **avertit et déclasse les parts en plafonds**, parce que le
  modèle suppose que tout ce qui est émis reste relu — deux faits le violent, la compaction et le
  raisonnement étendu (`output_tokens` compte le thinking, qui n'est PAS rejoué). Un chiffre de
  décomposition ne doit jamais être lu sans son ratio. Le coût cache-write est un **plancher**
  (tarif 5 min ; le TTL 1 h, non exposé de façon fiable par les transcripts, facturerait ×2) ;
  les 3 autres postes de coût sont exacts. Localisation des transcripts par
  `projectSlug(cwd)` = chemin absolu dont tout caractère non alphanumérique devient `-`
  (`<claudeDir>/projects/<slug>/<sessionId>.jsonl`, donc sensible à `CLAUDE_CONFIG_DIR`).
  Fail-open sans exception : fichier absent / vide / sans usage / illisible → `{ok:false, reason}`,
  le CLI sort **toujours** en code 0 et exprime l'échec **en valeur** dans le JSON.
- **Diagnostic enrichi de `/pmz:budget`** (`lib/metrics.js` + `lib/prefix-breakdown.js`, appelés
  depuis `scripts/audit-context.js`, lot #113) : troisième consommateur **hors bande** du moteur de
  mesure, mais sur la **session courante seule** (`analyzeSession` sur son transcript, jamais
  `analyzeWindow`) — coût borné à un balayage, acceptable pour une commande sur demande, jamais pour
  un hook. Deux ajouts : **coût marginal d'un token de sortie écrit maintenant**
  (`metrics.marginalOutputCost`) = son émission (tarif output) + sa relecture projetée à chaque tour
  restant (tarif cache-read × tours restants), ces tours restants dérivés de l'accrétion mesurée et
  de la borne de zone rouge du projet (`occupancy.resolveRedZone`, lot #112) ; fail-open **en
  valeur** vers un coût plancher (`source:'floor'`, émission seule) sans accrétion positive ou sans
  borne connue — jamais de projection inventée. Ratio marginal/nominal ≥ `MARGINAL_ALERT_RATIO` (2,
  exporté) → alerte : la relecture future coûte déjà plus cher que l'émission immédiate, signal
  distinct de la zone rouge (qui parle d'imminence d'auto-compact, pas de coût). Et **ventilation du
  préfixe** (`lib/prefix-breakdown.js`) en 3 postes mesurables — CLAUDE.md (global + projet, taille
  sur disque) et skills (nom + ligne `description` seule, ce qui charge par défaut) — plus un
  **reste** groupé (système + outils natifs + MCP) = préfixe mesuré − les deux premiers, clampé à 0.
  MCP n'est **pas isolable** : Claude Code ne journalise ni le system prompt ni les schémas d'outils
  envoyés à l'API dans le transcript local — seule la taille totale du premier tour est observable.
  Décision actée avec Marwan (lot #113) : un reste groupé honnête plutôt qu'un chiffre MCP fabriqué.
- **Tableau de bord HTML** (`scripts/dashboard.js` + `templates/dashboard.html`, lot #114) : second
  consommateur **hors bande** de `lib/metrics.js`, à côté de `scripts/metrics.js` (CLI texte/JSON).
  Il n'ajoute **aucun calcul** — il appelle `analyzeWindow()` et met en forme. Frontière : le moteur
  mesure, le script rend et recommande (3 recos classées par argent récupérable ; celle du découpage
  ne sort que si `k > 1`, sinon elle serait une reco inventée). Rendu par substitution de jetons
  `{{TITLE}}`/`{{SUBTITLE}}`/`{{BODY}}`/`{{FOOTER}}` — même mécanique que `templates/us-template.md`
  dans `lib/backlog.js`, mais avec une **fonction** de remplacement et jamais une chaîne : les
  valeurs contiennent des « $ » que `String.replace` interpréterait comme des références.
  Trois contraintes portées par le rendu, pas par le moteur : **autonomie** (aucune requête réseau
  possible — ni CDN, police distante, script, `url()`, image ; favicon `data:,` pour neutraliser
  jusqu'à `/favicon.ico` : ouvrir une mesure locale ne doit pas pouvoir faire sortir une donnée de
  session du poste) ; **thémabilité** (toute couleur est un jeton `--pmz-*` consommé via `var()`,
  résolu sur 3 canaux — `:root`, `prefers-color-scheme: dark`, `:root[data-theme=…]` — sans script) ;
  **honnêteté du chiffre** (les deux réserves du moteur remontent dans la page : ratio de contrôle
  toujours adjacent à la décomposition, parts déclassées en « plafonds » au-delà de 1,15, coût
  d'écriture de cache annoncé comme un plancher). Un gabarit de secours est embarqué dans le script :
  si `templates/dashboard.html` manque (install partielle), la page sort quand même — réduite, mais
  sans réseau et thémable. Enregistrement de la commande **automatique dans les deux canaux**
  (`install.js` copie tout `commands/*.md`, `build-plugin.js` fait un `cpSync` récursif ;
  `REQUIRED_COMMANDS` n'est qu'un garde-fou d'absence, non exhaustif) — aucun fichier d'install à
  toucher pour ajouter une commande, et `scripts/help.js` la découvre de lui-même.
- **Vigie de dette git non commitée** (`lib/gitdebt.js: evaluate`, lot #73) : signal de **tendance**
  distinct du rappel de clôture one-shot (#68, qui part au 1er tour sale puis se tait). Nudge **WARN**
  (`gitDebtMessage`) quand un **diff significatif grossit sur ≥ 3 tours SANS commit** — travail non
  versionné exposé à la perte (compaction, `/clear`, incident) + futur commit monstre illisible.
  Niveau de dette scalaire = **lignes du `git diff HEAD`** (hors `.vibe-agent`, binaires écartés)
  **+ un forfait de 40/fichier** touché : les fichiers **untracked** sont invisibles à `numstat` mais
  bien réels, le forfait les capture (`churn=0, files=8` déclenche quand même). Seuil `DEBT_LEVEL_MIN`
  200, fenêtre 3 tours, condition « **grossit** » (niveau > tour précédent) requise — une dette figée
  déjà signalée par la clôture ne re-nudge pas. Anti-spam par **palier** (`nudgedLevel × 1,5` : ne
  renudge qu'à +50 %) ; **reset** au commit (HEAD change) ou quand le tree (meaningful) redevient
  propre. Vit dans la branche `if (root)` de `stop.js` (réutilise le `git status` déjà calculé via
  `dirtyFiles`) — la dette git n'a de sens que dans un repo. Fail-open total (état `<sha1>-gitdebt.json`).
- **Vigie des tours en boucle** (`lib/loopwatch.js: evaluateLoop`, lot #69) : détecte une commande
  **Bash relancée en rafale alors qu'elle échoue** — signe que le modèle « insiste » au lieu de
  changer d'approche, chaque relance repayant contexte + tool_result d'erreur. Scan fenêtré du tail
  (1,5 Mo, même méthode que `scanTailForReadMix`) : les `tool_use` Bash donnent `id → commande`
  (normalisée en espaces), les `tool_result` font vivre une **série d'échecs PAR commande**
  (`is_error` incrémente, succès remet à zéro ; les autres commandes ne s'interposent pas — les
  diagnostics intercalés entre deux relances font partie de la même boucle). Nudge **WARN**
  (`loopingCommandMessage`) seulement si la série atteint `LOOP_MIN_FAILS` (3) **et** que la boucle
  est **encore ouverte** (dernier résultat = échec ; résolue toute seule → silence). Anti-spam
  **par commande** (état `<sha1>-loops.json`, clé sha1 de la commande) et non par session : une 2e
  commande qui part en boucle mérite son nudge, la même ne re-nudge jamais (la fenêtre revoit les
  mêmes échecs à chaque Stop). Fail-open total, indépendant du projet (transcript + état seuls).
- **Vigie de gouvernance du CLAUDE.md** (`lib/claudemd.js: evaluate`, lot #74) : le CLAUDE.md
  projet est rechargé dans le contexte à **chaque session**, les deux extrêmes coûtent. **Absent**
  → nudge **INFO** (`claudeMdMessage`) « propose /init » (chaque session repart sans règles) ;
  **hypertrophié** (> `CLAUDEMD_MAX_BYTES`, 10 Ko ≈ 2,5k tokens) → nudge **WARN** chiffré (Ko +
  tokens ≈ octets/4) « dégraisser : garder le stable/non-greppable, déporter vers la doc du dépôt ».
  Distinct de `MSG_NON_INIT` (session-start, projet jamais initialisé) : couvre le repo déjà vivant.
  Anti-spam **1×/session** (marqueur `<sha1>-claudemd`) posé **seulement quand un nudge part** — un
  CLAUDE.md sain ne consomme rien, un fichier qui enfle en cours de session reste signalé. Vit dans
  la branche `if (root)` de `stop.js` (b0bis). Fail-open total (toute erreur → `null`).
- **Notifications OS opt-in** (`lib/notify.js: send`, lot #75) : relaie les **2 événements
  graves** de `stop.js` en dehors du terminal — **zone rouge** (franchissement du seuil #71) et
  **clôture de lot** (auto-clôture #43/#59) — via une notification native (`osascript` mac,
  `notify-send` linux, toast PowerShell win32 sans dépendance). **Opt-in strict** (`PMZ_NOTIFY=1`,
  sinon aucun spawn) : le `systemMessage` reste le seul canal par défaut. Aucun anti-spam propre —
  s'appuie sur celui déjà en place à la source (zone rouge 1×/épisode, clôture = événement
  one-shot). `spawn` injectable (`opts.spawn`, défaut `child_process.spawn`, détaché + `unref`)
  pour permettre aux tests de stuber le lanceur sans jamais déclencher de vraie notification.
  Fail-open total (plateforme non gérée, outil absent, `spawn` qui lève → `false`, jamais
  d'exception vers `stop.js`). **Vigies de vague** (lot #80) : deux événements supplémentaires,
  câblés par `runPipeline` (cf. `pmz:reintegrate`) — `notifyLotReady` (un lot fille prêt à merger)
  et `notifyWaveClosed` (vague entièrement réintégrée), mêmes garanties opt-in/fail-open.
- **Hygiène de lecture** (`lib/occupancy.js: evaluateReadMix`) : même principe (lit le transcript
  brut, fenêtre fixe 1,5 Mo, aucune dépendance au ledger), tally les blocs `tool_use` récents pour
  détecter une majorité de `Read` sans `offset`/`limit` face aux recherches (`Grep`/`Glob`/`grep`
  en Bash). Une seule note par session (fichier d'état sha1 dédié, suffixe `-hygiene`).
- **Nudge subagent** (`lib/occupancy.js: evaluateSubagentNudge`, lot #52) : à **haute occupation**
  (≥ `BUCKETS[1]`=300k) **ET** avec des lectures récentes dans la fenêtre (`scanTailForReadMix`,
  ≥ 3 `Read`), `stop.js` émet un `systemMessage` invitant à **déporter l'exploration vers un
  subagent** (le gros des lectures reste hors du contexte principal, seul le résultat synthétique
  y revient). Anti-spam **dédié** (fichier d'état sha1 suffixe `-subagent`) **indépendant de
  l'hygiène** : le nudge part même si `evaluateReadMix` a déjà consommé son état à basse
  occupation (scénario type : hygiène signalée à 80k, puis occupation qui grimpe à 320k → le
  nudge subagent part quand même). 1×/session, transcript + état seuls (marche hors projet).
- **Vigie modèle réel vs préconisé** (`lib/modelwatch.js`, lot #42) : `user-prompt-submit.js`
  lit le `model` du dernier message assistant du transcript (même méthode fenêtrée que
  `occupancy.js: readLastOccupancy` — lecture seule, aucune dépendance ledger) et le compare
  au `model_hint` du lot backlog `in_progress`. Correspondance par **sous-chaîne** insensible
  à la casse (`modelsDiffer` : le hint est un mot-clé libre — « sonnet » — le modèle réel un id
  complet — « claude-sonnet-5 ») plutôt qu'une énum à resynchroniser à chaque nouveau modèle.
  Nudge `additionalContext` court (suggère `/model`, lot #55), plafonné **1×/session** (clé
  `model_mismatch` dans `prompt_reminders`, même state que les autres rappels du hook — repart à
  zéro sur nouvelle `session_id`) : le modèle ne change normalement pas en cours de session, une
  seule alerte suffit à signaler un mauvais démarrage. **Silence si le hint désigne un runtime
  tiers** (`modelwatch.js: hintResolvableClaude` — allow-list `claude`/`opus`/`sonnet`/`haiku`/
  `fable` ; un hint « ollama/… », « gpt-4o »… présumé non-Claude) : CC ne peut pas s'y basculer,
  donc ni vigie ni `/model` (lot #55). Fail-open total (backlog absent, transcript illisible,
  aucun lot en cours ou sans `model_hint` → silence, jamais de blocage).
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
- **Coût des tours DÉLÉGUÉS** (`lib/subagentcost.js`, lot #119) : un sous-agent (outil Agent/Task)
  n'écrit pas dans le transcript de la session — Claude Code lui ouvre son propre fichier sous
  `<transcript sans .jsonl>/subagents/agent-<id>.jsonl` (vérifié sur transcripts réels : aucun
  `uuid` d'usage du sous-agent dans le transcript parent, aucune ligne `isSidechain` côté parent).
  `stop.js` ne scannant que le transcript de session, ce coût était **structurellement invisible** :
  un lot mené en sous-agents sortait à `cost_tokens` ≈ 0. `computeSubagentCost(transcriptPath, sid)`
  scanne ces fichiers avec la **même** méthode que `turnstats` (offset persisté **par fichier** dans
  `<sha1(sid)>-subagents.json` ; `parseUsage`/`scanRange` sont réutilisés, pas dupliqués) et rend le
  delta de sortie apparu depuis le Stop précédent — corpus **disjoint** du transcript parent, donc
  aucun double comptage. Rattrapage **à chaque Stop** (pas de hook `SubagentStop` : un sous-agent en
  tâche de fond peut finir hors tour, et il y a toujours un Stop après). Deux bornes de prudence :
  fichier **rétréci** → offset recalé **sans rien compter** (une sur-imputation est plus grave qu'un
  trou) ; au plus `MAX_FILES_PER_TURN` fichiers par Stop (les plus récents d'abord), les autres
  gardant leur offset. La part déléguée est **ventilée** dans `cost_subagent_tokens` (comprise dans
  `cost_tokens`, jamais en plus) et restituée par le trailer `PMZ-Cost` de `/close-batch`.
- **À QUI imputer le coût — `backlog.js: costLotFor(b, sid)`** (lot #119) : `currentLot` répond
  « quel lot **afficher** ? » et son erreur se voit ; l'imputation, elle, **fausse une mesure** en
  silence. En vague, N lots sont `in_progress` en même temps et `currentLot` renvoyait le **premier
  du tableau** : toutes les sessions créditaient le même lot (coût volé, et `estimateCost` empoisonné
  pour les lots suivants). `costLotFor` est **pur** : un seul lot en cours → lui (y compris si son
  `session_owner` est celui d'une session antérieure — l'agrégat est explicitement trans-session) ;
  plusieurs → **celui dont `session_owner === sid`**, et **rien** si aucun ne correspond (un trou de
  mesure est visible et réparable, une imputation au hasard non). `stop.js` complète par un repli sur
  le **registre de vague** (`fleet.lotForSession`) quand le `session_owner` du backlog est périmé,
  le lot n'étant retenu que s'il est réellement `in_progress` au backlog.
- **Estimation prédictive du coût d'un lot** (`backlog.js: estimateCost(b, lot)`, lot #63) :
  avant même qu'un lot n'ait consommé le moindre token, moyenne des `cost_tokens` des lots
  **clos** comparables — famille décroissante (1) `model_hint`+`effort_hint` (2) `model_hint`
  seul (3) `epic` — `null` dès qu'aucune famille n'a de lot clos avec `cost_tokens > 0` (pas de
  chiffre fabriqué à partir de zéro échantillon). Affiché en texte par `scripts/backlog.js`
  à la suite du message `add` (au `/scope`) **et** `start` (au démarrage réel du lot).
- **`depends_on` en SÉRIE — `nextLot` / `blockedByOf`** (lot #97) : `depends_on` n'était exploité
  que par le canal **parallèle** (`planWaves`, `planReintegration`) ; le flux série renvoyait le
  premier `todo` **dans l'ordre du tableau**, donc pouvait proposer un lot avant sa dépendance — et
  l'auto-clôture propageait cette proposition aveugle. `nextLot(b)` renvoie désormais le premier
  `todo` **débloqué** ; `blockedByOf(b, lot)` (pur) donne les dépendances encore **ouvertes**.
  Sémantique alignée sur `planWaves` : une dépendance ne bloque que si elle pointe un lot
  **présent** au statut `todo`/`in_progress` — `done`, `dropped` ou id inconnu = **satisfaite**
  (sans cette tolérance, un `depends_on` vers un lot abandonné gèlerait le plan pour toujours).
  Deux invariants : (1) le marqueur n'est **jamais persisté** (aucune annotation de l'objet lot —
  un `saveBacklog` l'écrirait dans `backlog.json`), il se calcule à la volée, ce qui le rend sûr
  pour les consommateurs chauds (`statusline` à chaque refresh) ; (2) **jamais `null` tant qu'il
  reste des `todo`** — sur cycle, on renvoie quand même le premier avec son marqueur, sinon
  la carte de clôture annoncerait « Plan de lots terminé » à tort. La **forme de retour reste un lot
  nu** : les 8 consommateurs de `nextLot` gardent leur contrat et affichent le marqueur là où il y
  a la place (`stop`, `session-start`, CLI `next`, `about`, `audit-batch`, `⚠` en statusline).
- **Parallélisation gouvernée — schéma backlog v2** (lot #76, épic « Vagues parallèles », 1ʳᵉ
  brique de la décision [D3](docs/decisions/D3-parallelisation-gouvernee.md)) : chaque lot porte
  trois champs **inertes tant qu'aucune vague n'est active** — `perimeter` (globs de chemins que
  le lot a le droit de modifier), `depends_on` (ids de lots, ordre de réintégration) et
  `session_owner` (session qui tient le lot en cours). `startLot(root, id, sessionOwner)` a deux
  régimes : **classique** (owner absent ou lot sans périmètre) = au plus un `in_progress`, les
  autres rétrogradent (comportement historique **strictement** préservé) ; **fleet** (owner + lot
  avec périmètre) = les lots en cours d'une **autre** session et de **périmètre disjoint**
  coexistent, seuls les conflictuels rétrogradent. La disjonction de périmètres vit dans
  `lib/perimeter.js` (normalisation + `disjoint`, matching **conservateur** au niveau des préfixes
  statiques ; l'appartenance d'un fichier à un périmètre = lot #78). `reconcile` préserve une
  vague valide (coexistence 2 à 2) mais répare tout multi-`in_progress` invalide.
  **Zone partagée additive** (`perimeter.SHARED_SEGMENTS` / `isShared`, lot #119) : les globs dont le
  premier segment est `test`/`tests`/`__tests__`/`spec` sont **retirés du test de disjonction**. Sans
  cette exception, `test/**` — présent dans presque tous les périmètres, par construction (un lot
  livre ses tests) — rendait **toute** paire de lots non disjointe et sérialisait la vague entière :
  un lot par vague, la parallélisation annulée en silence. Deux garde-fous : un périmètre réduit à la
  **seule** zone partagée redevient vide donc **non disjoint** (pas de coexistence sur « chacun ses
  tests »), et `memberVerdict` est **inchangé** (une fille garde le droit d'écrire dans son
  `test/**`). Compromis assumé et **annoncé** par `/pmz:parallelize` : le conflit de merge y est
  attendu, et c'est la réintégration en pipeline qui l'annule en nommant le lot coupable.
- **Registre de vague — `fleet.json`** (lot #77, épic « Vagues parallèles », 2ᵉ brique de
  [D3](docs/decisions/D3-parallelisation-gouvernee.md)) : `.vibe-agent/fleet.json` est l'état
  **partagé** d'une vague — le handoff commun (pas de duplication du handoff par session). Géré
  par `lib/fleet.js` (JSON plat via `lib/fsjson`, zéro dépendance). Une entrée par lot en vol :
  `{ id, session_owner, branch, worktree, perimeter, state, ext_requests }` où `state ∈ in_flight |
  ready | reintegrated` et `ext_requests` = demandes d'extension de périmètre tracées (lot #78,
  cf. « Garde de périmètre ») ; plus, au niveau vague, `wave_id` et la **tête de la branche d'intégration**
  (`integration_branch` + `integration_head`, dont l'avance est le futur déclencheur de rebase).
  **Inerte par défaut** : sans fichier, `loadFleet().active === false` et les sessions restent
  autonomes (mono-session inchangé). **Fail-open absolu** : fichier absent / JSON corrompu / lot
  sans `session_owner` → vague désactivée, jamais d'exception (un fleet cassé rend la session
  autonome, il ne la gêne jamais). Mutations **par lot** (`upsertLot`/`setLotState`/`removeLot`/
  `setIntegrationHead`) en lecture-modification-écriture atomique (temp+rename) pour réduire les
  fenêtres de course ; la perte-de-MàJ résiduelle est assumée au palier 2 (lancement manuel).
  `session-start.js` injecte les lignes **courtes** de `fleetLines(root, sessionId)` (périmètre
  exclusif + **consigne sous-agents** — le garde-fou d'écriture ne couvre que la session
  propriétaire, pas ses sous-agents Task/Agent qui écrivent sous un autre `session_id`, donc elle
  doit leur transmettre le périmètre (lot #87) — + branche + tête d'intégration + nb de lots
  sœurs, `< 10` lignes) — et **uniquement**
  si la session tient un lot en vol ; sinon silence total. Deux points d'ancrage : au
  **startup/clear** (via `withFleet`, en plus de MSG_ACTIF/handoff) **et après compaction** (bloc
  **prioritaire** de `compactResumeMessage`, placé en 2ᵉ position pour survivre au rognage du cap —
  c'est là que la garantie de périmètre compte le plus, le contexte compacté ayant perdu la
  contrainte « ne modifie que X »). Le hook installé v1.3.0 **ignore** ces champs : sans impact tant qu'aucune vague n'est
  posée, mais la 1ʳᵉ vague réelle exigera un redéploiement du plugin.
  **Écriture outillée du registre** (lot #99, FIA-21 ; `leave` au lot #100) : `backlog.js fleet join|ready|leave|show`
  enveloppe `upsertLot`/`setLotState`/`loadFleet`. Avant, s'inscrire dans la vague ou passer un
  lot « prêt » se faisait **à la main dans le JSON** : une faute de frappe et `loadFleet`
  (fail-open, contrat hooks) désactivait TOUTE la vague **en silence** — garde de périmètre et
  injection éteintes sans un mot. Comme c'est une **commande** et non un hook, les refus sont
  explicites (`--id` absent, `--state` hors `STATES`, propriétaire introuvable, fleet illisible)
  tout en gardant la convention `exit 0`. `--session` retombe sur l'id persisté dans
  `session-state.json` (l'assistant n'a aucun autre moyen de connaître le sien) — repli **fiable
  seulement après le 1er SessionStart**, avant quoi le fichier porte encore l'id de la session
  *précédente* : le lot #100 rend donc ce repli **visible** (mention « session DÉDUITE » dans la
  sortie) et le **refuse** quand l'id déduit tient déjà un autre lot en vol, symptôme direct de
  l'id périmé (avec `--session` explicite, aucune de ces deux gardes ne s'applique). `fleet leave
  --id` (lot #100) est la réciproque de `join` : retire l'entrée du registre **et** son
  `handoff-lot-<id>.md`, sans toucher au backlog — quitter la vague ne fait que rendre la session
  autonome (plus de garde de périmètre, plus d'injection), le lot reste au plan. `fleet show`
  **distingue** « absent » de « JSON corrompu » — que `loadFleet` confond — en lisant le fichier
  **avant** tout `loadFleet` (`readJson` met un JSON invalide en quarantaine dès la 1ʳᵉ lecture) :
  le fail-open des hooks reste muet, le diagnostic passe par la commande.
  **Purge de fin de vague** (lot #99, FIA-20) : `lotForSession` ignore les lots `reintegrated` —
  sans ce filtre l'ex-fille restait **bridée** par la garde de périmètre et recevait une injection
  périmée « tu tiens le lot #X (état : reintegrated) ». Et à la clôture, `runPipeline` **range** :
  `fleet.clearWave` (vidage en UNE écriture — une boucle `removeLot` ferait N fenêtres de course)
  + `handoff.purgeLotHandoffs`. `clearWave` ne crée jamais un `fleet.json` absent. La composition
  de la vague n'est pas perdue : un **snapshot pris avant le vidage** part dans le rapport de
  réintégration (ci-dessous).
  **Purge d'une vague ABANDONNÉE** (lot #101, dette #100) : `purgeLotHandoffs` n'était appelé que
  par `closeWave` (réintégration réussie) ou `fleet leave` — une vague redevenue inerte par un
  autre chemin (`clearWave` direct, reset manuel) laissait ses `handoff-lot-*.md` orphelins pour
  toujours. `handoff.purgeOrphanLotHandoffs(root)` détecte ce cas (fleet inactif + fichiers de lot
  encore présents) et purge alors tout ; no-op si la vague est encore en vol. Câblé au
  `SessionStart` (`startup`/`clear`, projet initialisé) : rangement muet, jamais dans le message
  injecté — un simple point de passage garanti suffit, pas besoin d'un job dédié.
  **`fleet.waveHandoffLines(root)`** (lot #91) : pointeur d'**une** ligne pour la session
  **orchestratrice** (pas d'inscription dans la vague, contrairement à `fleetLines` ci-dessus) —
  wave_id + décompte de lots + renvoi vers `/pmz:parallelize`, jamais le plan complet (celui-ci
  se recalcule depuis le backlog, cf. « Plan de vagues » plus bas). Intégré par
  `handoff.writeAutoHandoff` juste après la branche (survit à la troncature 6000c). `[]` si
  vague inactive.
- **Garde de périmètre — PreToolUse mode fleet-fille** (lot #78, 3ᵉ brique de
  [D3](docs/decisions/D3-parallelisation-gouvernee.md)) : `pre-tool-use.js` s'étend à
  `Edit`/`Write`/`MultiEdit` **pour le seul test d'appartenance au périmètre**, et **uniquement**
  quand une vague est active ET que la session courante y tient un lot (« session fille »). Hors
  vague, session non inscrite, ou lot sans périmètre déclaré : **zéro friction** (le chemin Bash
  et le mode `acceptEdits` restent inchangés). Le verdict s'appuie sur `fleet.lotForSession` +
  `perimeter.memberVerdict(globs, filePath, root)`, à trois issues **conservatrices** :
  `inside`/`unknown` → `allow` ; `outside` (chemin résolu CERTAINEMENT hors de tous les globs) →
  **`deny`**. On ne refuse donc que sur **certitude** : périmètre vide, chemin hors root (`../`)
  ou non résoluble → `unknown` → `allow` (deny sur certitude seule ; doute/erreur → allow, contrat
  fail-open). Le matching reste au **préfixe statique** des globs (granularité « dossier »,
  cf. `perimeter.js`), volontairement élargi → jamais de faux `deny`. **Coût** : pour ne pas
  forker `git` à chaque écriture hors vague, `fleet.findFleetRoot(cwd)` court-circuite en
  remontant l'arbo (pur `fs`) — sans `.vibe-agent/fleet.json`, retour immédiat, aucun subprocess.
  `MultiEdit` est gardé au même titre qu'`Edit`/`Write` (même champ `file_path`) pour fermer le
  contournement trivial ; `NotebookEdit` (champ distinct, rare ici) reste hors périmètre du lot.
  **Demande d'extension tracée** : sur un `deny`, le hook appelle `fleet.requestExtension(root,
  id, relPath)`, qui note le chemin hors-zone (POSIX relatif, dédupliqué, capé) dans un champ
  `ext_requests` de l'entrée du lot — trace **passive** pour l'orchestrateur (jamais un droit
  d'écriture : l'écriture reste refusée). L'appel est **best-effort** (try/catch, jamais
  bloquant), idempotent (même chemin déjà tracé → pas de réécriture), et no-op hors fleet actif.
  **Remontée à l'orchestrateur** (lot #87) : `fleet.pendingExtensions(root)` agrège ces demandes
  par lot (`{ id, title, paths }`, lots sans demande écartés) et `/reintegrate` (proposition, texte
  + `--json.extensions`) les **affiche pour arbitrage avant merge** — la friction cesse d'être une
  simple trace dans le fichier, elle devient visible là où l'orchestrateur décide d'élargir ou non.
- **Bridge RTK — réécriture de commande sûre** (lot #81, 1re brique de l'epic « Bridge RTK ») :
  `pre-tool-use.js` peut faire transiter une commande Bash **jugée sûre** par un moteur de
  compression externe (RTK) via une **réécriture d'input** (`updatedInput`, **sans**
  `permissionDecision` — la commande réécrite suit ensuite le flux d'autorisation normal ; contrat
  confirmé côté Claude Code : `updatedInput` **remplace** l'objet `tool_input`, d'où le
  `Object.assign` qui préserve `description`/`timeout`/`run_in_background`). **Ordre non
  négociable** : la classification `bash-guard.classify` tranche d'ABORD sur la commande
  **originale** (deny/ask inchangés) ; seule une commande `allow` est proposée à la réécriture ;
  la commande réécrite est **re-classifiée défensivement** — un RTK produisant une commande
  dangereuse est **ignoré** (jamais d'exécution silencieuse d'une commande dangereuse via
  réécriture). **Default OFF** : le socle `lib/optimizer.js` (pur, fail-open) sort immédiatement
  tant que `PMZ_RTK_ENABLE=1` n'est pas posé — **zéro I/O, zéro latence** sur le chemin chaud par
  défaut. La détection est **volontairement minimale** (présence du binaire via `env.findTool`,
  aucun `rtk --version` sur le chemin chaud — version/compat/conflit reportés au doctor, lot #82).
  Contrat CLI `rtk rewrite "<cmd>"` : **exit 0 + stdout non vide ≠ original → réécrit** ; exit
  1/2/3, timeout (`RTK_REWRITE_MS`, 400 ms, `PMZ_RTK_REWRITE_TIMEOUT_MS`), binaire absent, stdout
  vide/identique → **commande originale** (fail-open). Pas de double préfixe : `rtk …` ou
  `RTK_DISABLED=1 …` déjà en tête → inchangé. Appel **sans shell** (argv, `execFileSync`).
- **`/pmz:rtk` — statut, activation persistée, conflits sur 3 canaux** (lot #82, 2ᵉ brique de
  l'epic « Bridge RTK ») : `lib/rtk-status.js` sépare la **détection** (RTK présent ? un hook
  autonome existe-t-il déjà ailleurs qu'à travers le bridge PMZ ?) de l'**activation** du bridge
  (lot #81). Cinq états : `absent` (binaire introuvable) / `présent-inactif` (binaire OK, bridge
  éteint) / `actif` (bridge allumé) / `conflit` (hook autonome détecté) / `incompatible` (binaire
  trouvé mais `rtk --version` échoue/timeout — `RTK_STATUS_MS`, 1 s, `PMZ_RTK_STATUS_TIMEOUT_MS`,
  **hors chemin chaud**). **Activation persistée** : `PMZ_RTK_ENABLE=1/0` en env reste un override
  ponctuel (tests, désactivation d'un seul appel) prioritaire ; en son absence, `optimizer.js` lit
  l'état persisté sous `PMZ_STATE_DIR/rtk-state.json` — nécessaire car un hook Bash est un process
  **jetable**, relancé à chaque appel outil, qui ne peut se souvenir d'un `enable` précédent que
  via un fichier (et cet état, sous `stateDir()`, **survit à un update du plugin**, cf.
  `claude-dir.js`). **Détection 3 canaux** (spec §9) : (1) réglages Claude Code — recherche
  **par contenu** (`/rtk/i` sur la commande, hors tags PMZ) dans `settings.json`, pas par nom de
  fichier attendu (un hook RTK autonome peut être vendoré sous un nom arbitraire — un hook
  Claude Code « invisible » en tant que tel reste détecté) ; (2) plugin OpenCode et (3)
  instructions Codex — **best-effort** sur des formats tiers non normalisés (fichiers candidats
  `opencode.json`/`AGENTS.md`/`~/.codex/instructions.md`), marqueur Codex **resserré**
  (`rtk` + mot-clé proche, ou balise `<!-- rtk`) pour éviter un faux positif sur un `AGENTS.md` de
  projet qui mentionnerait « rtk » en prose. **Conflit → neutralisation automatique** : dès que
  `status`/`enable`/`disable`/`migrate` constatent un conflit alors que le bridge était persisté
  actif, l'état est repassé à `false` immédiatement (self-healing, pas d'action manuelle requise
  pour le couper) ; la remédiation exacte (canal + preuve) est toujours affichée. `enable` refuse
  sur `conflit`/`absent`/`incompatible`. `migrate` ne touche **que** le canal Claude Code
  (sauvegarde horodatée de `settings.json` puis retrait ciblé des SEULES entrées en conflit,
  reste préservé intact) — OpenCode/Codex restent à traiter manuellement (formats tiers).
  Commande `/pmz:rtk [status|enable|disable|migrate]` → `scripts/rtk.js`.
- **Métrologie honnête des gains RTK** (lot #83, 3ᵉ brique de l'epic « Bridge RTK ») :
  `lib/rtk-metrics.js` rattache au lot clos une mesure du travail confié à RTK, **avec son niveau
  de preuve** — jamais une valeur inventée (contrainte cardinale du lot). Trois niveaux :
  (1) **`measured`** = chiffres issus de RTK lui-même (sorties brutes vs transmises → économie
  réelle + ratio). Couture **activée depuis le lot #117** : `rtk-metrics.rtkGainSnapshot()`
  interroge le contrat CLI **confirmé** `rtk gain -p -f json` (RTK 0.43.0 ; `-p` filtre au projet
  courant) — la prémisse « contrat RTK non défini » du lot #83 est **levée, documentée comme
  périmée**. `backlog.startLot` fige ce snapshot (`rtk_gain_start`, best-effort — binaire absent/en
  échec => champ omis, niveau `local` inchangé) ; `backlog.doneLot` **et** le bilan en direct de
  `close-batch.js` réinterrogent le contrat à la clôture et soustraient pour obtenir le `rtkStats`
  passé à `computeLotGain`. Fail-open à chaque étape : jamais d'exception, jamais de delta si RTK
  est indisponible à l'une des deux bornes (repli silencieux sur le niveau `local`).
  (2) **`local`** = ce qui est prouvable aujourd'hui sans RTK — un **compteur local monotone**
  (`PMZ_STATE_DIR/rtk-metrics.json`, survit aux updates) des commandes **effectivement réécrites**
  + le volume de commande **livré** (tokens estimés du texte transmis). **Aucun `tokens_saved`
  ici** : la compression opère sur la SORTIE terminale, invisible du hook — on ne prétend donc à
  aucune économie. (3) **rien** : aucune activité RTK sur le lot → aucun champ écrit, rien
  d'affiché. **Attribution par lot** = delta du compteur (spec §11 : `snapshot_clôture −
  snapshot_démarrage`) : `pre-tool-use.js` incrémente le compteur **uniquement** quand une
  réécriture est réellement livrée (rare, default OFF) ; `backlog.startLot` fige le snapshot de
  démarrage sur le lot (`integrations.command_optimizer.snapshot_start`, transitoire),
  `backlog.doneLot` calcule le delta et **fige le gain final** (le snapshot transitoire est retiré ;
  aucun champ si le delta est nul). Le champ **`integrations` est optionnel et rétro-compatible** :
  les lots legacy sans lui restent lus sans crash, et un lot clos sans activité RTK n'écrit rien
  (choix assumé, **divergent de la suggestion `evidence: unavailable` de la spec §11** : « rien »
  est préféré au bruit, RTK étant default OFF → la quasi-totalité des clôtures n'a pas d'activité).
  **Imprécision assumée** : en vague parallèle (plusieurs `in_progress`), le compteur global ne
  sait pas imputer une réécriture à un lot précis — d'où le nom `local` (preuve faible, étiquetée).
  **Bilan de clôture** (`scripts/close-batch.js`) : bloc « Gain RTK » calculé **en direct** depuis
  le snapshot de démarrage + le compteur courant (le lot n'est pas encore clos), via
  `rtk-metrics.gainLines` ; rien si aucune preuve. **Export** (`backlog.exportCsv/Markdown`) :
  4 colonnes dérivées ajoutées — `command_optimizer_provider`, `command_tokens_saved`
  (mesuré seulement), `command_saving_ratio` (mesuré seulement), `command_evidence` — vides pour
  un lot sans métrologie. **Tableau de bord** (lot #117, `scripts/dashboard.js`) : section « Gain
  RTK par lot » lue directement depuis `backlog.json` (indépendante de la fenêtre de transcripts
  des autres sections) — un lot clos sans preuve RTK est absent de la liste (jamais affiché à
  zéro), le niveau de preuve (`measured`/`local`) est toujours affiché à côté du chiffre.
- **Champ `us` : pointeur US vérifié** (lot #101, epic « US & Jira ») : un lot peut porter un
  **chemin** (relatif à la racine du dépôt, `MAX_US=200`) vers une User Story détaillée —
  persona/besoin/bénéfice, critères d'acceptation numérotés, hors-périmètre — jamais son
  **contenu** : même pattern « résumé court + fichier référencé » déjà imposé pour un
  scope/note qui déborde. Gabarit : `promptimizer/templates/us-template.md` (part tel quel
  dans le canal plugin). CLI : `add --us docs/us/US-42.md` avec **garde d'existence doublée**
  (refus explicite côté CLI *et* revalidation dans `addLot` — défense en profondeur) : un
  chemin introuvable est refusé, jamais avalé — un pointeur mort serait pire qu'aucune US.
  `show`/`export` réaffichent le pointeur tel quel (`[US : …]`, colonne `us`) ; vide, jamais
  inventé, pour un lot sans US. `/pmz:scope` **statue** sur l'US de chaque lot (chemin existant
  ou « pas d'US » assumé), jamais en silence — et n'invente jamais de chemin : US pas encore
  rédigée → l'écrire d'abord dans le dépôt, sinon omettre `--us`.
- **Commande `us` : gabarit généré + pointeur éditable** (lot #106, epic « Formalisation US ») :
  `add --us` (#101) était l'unique porte d'entrée du champ et **supposait l'US déjà rédigée** —
  un lot créé sans elle ne pouvait en recevoir une qu'en éditant `backlog.json` à la main, hors
  gardes. Trois régimes, sur le modèle exact de `verify` : sans flag → **lecture** du pointeur
  (le fichier US n'est jamais ouvert : coût de contexte nul) ; `--new` → pose
  `docs/us/US-<id>.md` depuis le gabarit **et** rattache le pointeur dans le même geste
  (`backlog.createUsFile`) ; `--set <chemin>` → rattache une US écrite ailleurs
  (`backlog.setUs`, **même garde d'existence** qu'`addLot`). Décisions :
  **chemin conventionnel sans slug de titre** (`usPathFor` → `docs/us/US-<id>.md`) — un titre
  bouge, le chemin resterait faux ; **refus doux si le fichier existe** — la commande *génère*,
  elle n'écrase jamais une US rédigée, et le refus propose `--set` comme issue ;
  **lot clos = lecture seule** (une US écrite après la clôture ne gouverne plus rien) ;
  **gabarit résolu depuis le code** (`lib/backlog.js` → `../templates/us-template.md`), jamais
  depuis le dépôt utilisateur — il part tel quel dans les deux canaux d'install. Le gabarit
  (`templates/us-template.md`) est **enrichi et sobre** : jetons `{{ID}}`/`{{TITRE}}`/`{{EPIC}}`
  substitués au rendu, sections Récit / Critères d'acceptation / Hors périmètre / Preuve de
  clôture / Notes, et une borne explicite (**< 60 lignes** — au-delà, ce n'est pas une US mal
  rédigée, c'est un lot à redécouper).
- **Validation de structure de l'US à la clôture** (lot #107, epic « Formalisation US ») : la
  commande `us` (lot #106) pose un pointeur mais ne garantit rien sur ce qui est écrit derrière —
  une US pouvait être rattachée puis vidée à la main sans que rien ne le remarque avant la
  clôture du lot. `lib/backlog.js#checkUsStructure` vérifie la présence des **titres** des 5
  sections obligatoires du gabarit (Récit, Critères d'acceptation, Hors périmètre, Preuve de
  clôture, Notes) dans le fichier pointé — jamais le **contenu** d'un critère (un « ... » resté
  en l'état reste un problème de rédaction humaine, hors de portée d'une garde syntaxique).
  `done` refuse en **refus doux** (message actionnable listant les sections manquantes, aucun
  fail-hard, aucun blocage de session) si le lot pointe vers une US incomplète ;
  `--allow-incomplete-us` débloque une clôture assumée malgré tout, sur le modèle exact
  d'`--allow-no-gate`. Un lot sans pointeur `us` n'est pas concerné (aucune régression sur le cas
  majoritaire) ; un fichier illisible est traité comme « pas de vérification possible », pas
  comme un refus (`checkUsStructure` retourne `null`, fail-silent).
- **Pointeur `us` dans la fiche d'archive** (lot #103, epic « US & Jira ») : fait remonter `us`
  (#101) jusqu'à la seule surface de clôture qui l'ignorait — deux lignes (en-tête + section
  « Liens ») dans `ficheSkeleton` (`lib/archive.js`, tier 1, lot #95), toujours **conditionnel** :
  un lot sans US ne produit aucune ligne. En corrigeant ce lot, un bug pré-existant a été trouvé
  et réparé : `audit-batch.js#backlogSummary().current` ne portait ni `epic` ni `us` du lot réel
  (projection partielle depuis le lot #95) — la fiche affichait `epic : —` pour *tout* lot en
  cours, jamais remarqué faute de test dédié sur ce champ.
- **Pointeur Jira retiré** (lot #105, epic « Formalisation US ») : `integrations.jira`, la
  commande `jira --id N [--set KEY]`, le trailer `PMZ-Jira` et la colonne d'export `jira_key`
  (posés lots #102-#103) ont été retirés — jamais de connectivité Jira réelle derrière, donc pas
  de valeur d'usage constatée pour un simple pointeur inerte, et son maintien coûtait de la doc
  et du code à relire sans contrepartie. Cf. décision « Frontière Jira : écarté » ci-dessous pour
  le pourquoi complet (inchangé) et « Maille User Story : non » pour le pointeur `us`, qui lui
  reste en place.
- **RTK visible dans le verbe PMZ** (lot #86, epic « Verbe & Vagues ») : avant ce lot, seul
  `/pmz:rtk` montrait l'état du bridge — invisible du reste du verbe. `lib/messages.js` expose
  deux primitives pures, réutilisant les 5 états de `rtk-status.computeStatus()` :
  `rtkStatusLine(status, cumulative)` (surface **explicite** — `/pmz:about`, `/pmz:budget` — 
  **toujours affichée**, y compris à l'état absent : l'utilisateur a demandé l'info) et
  `rtkStartupLine(status)` (injection **implicite** au démarrage de session — **silence total**
  à l'état absent, zéro bruit sur l'immense majorité des sessions qui n'ont pas RTK installé ;
  1 ligne pointant `/pmz:rtk` sur les 4 états notables). `scripts/about.js` et
  `scripts/audit-context.js` (support `/pmz:budget`) affichent désormais l'état + le compteur
  cumulé de commandes réécrites (`rtk-metrics.snapshot()`, jamais le « gain » d'un lot — cf. lot
  #83 — un simple cumul). `hooks/session-start.js` ajoute la ligne courte au même point que le
  rappel `MSG_ACTIF`/`MSG_ACTIF_SLIM` (1×/session, anti-spam). Best-effort strict partout : une
  panne RTK (binaire, fs) ne fait jamais échouer ces surfaces, elle fait juste disparaître la ligne.
- **Prescription RTK dans la consigne injectée** (lot #116) : sur les états `present-inactif`/
  `actif` (binaire confirmé fonctionnel), `rtkStartupLine` ajoute `RTK_PRESCRIPTION` — les 5
  équivalents `rtk` (grep/read/git/ls/find) à préférer aux commandes nues, texte repris tel quel
  de la sortie réelle de `rtk init` (mêmes commandes, mêmes chiffres de gain), pas une paraphrase
  inventée. Absent sur `conflict`/`incompatible` (binaire non fiable dans ces états).
- **Fallback natif de sortie volumineuse** (lot #84, épilogue de l'epic « Bridge RTK ») :
  `lib/output-fallback.js` + branche `Bash` de `post-tool-use.js`. Filet **générique** quand RTK est
  absent — pas un remplacement fonctionnel de RTK. C'est un hook **PostToolUse (sortie)**, distinct
  du bridge RTK qui, lui, réécrit l'**entrée** en PreToolUse. **Spike gate levé d'abord** (contrainte
  du lot) : le champ **`updatedToolOutput`** est confirmé côté doc Claude Code (« PostToolUse decision
  control ») — il **remplace** la sortie du tool, la valeur **doit matcher la shape du tool** (Bash =
  objet `{stdout,stderr,interrupted,isImage,noOutputExpected}`), et un objet **non conforme est
  ignoré** (sortie originale conservée) → fail-open natif de la plateforme. `reduceBashOutput` ne
  substitue donc **que `stdout`** en repartant de l'objet reçu (shape garantie), et ne touche
  **jamais** `stderr`/`interrupted` (§10 : ne jamais masquer une erreur, ne jamais fabriquer un
  succès). **Déclenchement** : RTK absent (garde `rtk-status.isBridgeEnabled`), sortie > seuil
  (`PMZ_OUTPUT_FALLBACK_LINES`, 300 lignes par défaut), gain réel. **Stratégies §10** : dédup des
  lignes consécutives, en-tête + fin conservés, lignes d'erreur préservées, **sortie complète stockée**
  sous `.vibe-agent/logs/<id>.log` (pas de repo git → pas de réduction, on refuse de perdre du texte),
  en-tête technique `[PMZ sortie réduite]` (commande / lignes brutes / transmises / erreurs / chemin
  du log). **Petite sortie intacte** (jamais de filtrage silencieux), **image/binaire jamais réduit**,
  désactivable `PMZ_OUTPUT_FALLBACK_DISABLE=1`.
  **Plafond de `.vibe-agent/logs/`** (`purgeLogs`, lot #101, dette #100) : le dossier (`*.log` +
  `reintegrate-*.md`, cf. rapport de réintégration ci-dessous) croissait sans purge. Même patron
  que `clearWave`/`purgeLotHandoffs` : tri par `mtime`, retire les plus anciens au-delà de
  `MAX_LOG_FILES` (200), best-effort. Câblé à **chaque écriture** (`writeFullLog` et
  `writeReintegrateReport`) — la purge est incrémentale, jamais un job séparé à penser à lancer.
- **Plan de vagues — `pmz:parallelize`** (lot #79, 4ᵉ brique de
  [D3](docs/decisions/D3-parallelisation-gouvernee.md)) : `backlog.planWaves(b)` (fonction
  **pure** : ne lit/écrit rien, ne lance rien) calcule un plan de vagues parallèles à partir des
  lots « à faire ». Une **vague** = un groupe de lots aux **périmètres disjoints deux à deux**
  (via `perimeter.disjoint`) dont toutes les `depends_on` sont satisfaites par une vague antérieure
  ou un lot déjà fait ; layering glouton (au moins un lot placé par tour → terminaison garantie).
  **Deux règles cardinales, fail-safe** : les périmètres qui se **chevauchent** ne partagent jamais
  une vague (l'un est repoussé plus loin — *refus des intersections*) ; au moindre doute, hors
  vague — lot sans périmètre → `unplannable`, lot dont une dépendance ne pourra jamais aboutir
  (cycle, dépend d'un `unplannable`) → `blocked`. Retour `{ waves, unplannable, blocked }`.
  `backlog.waveBranch(lot)` dérive un nom de branche suggéré (`pmz/lot-<id>-<slug>`, slug ASCII
  borné, accents dépliés) — présentatif, réutilisé au lot #80. La CLI `scripts/backlog.js
  parallelize` (option `--epic` pour filtrer, `--json` pour la machine, `launched:false`) **PROPOSE**
  le plan (vagues + branches + périmètres) et **ne lance RIEN** : ni branche, ni worktree, ni
  session fille. Le lancement reste **manuel et validé** (`start --id … --owner …`, cf. D3 palier 2).
- **`/pmz:scope` propose le périmètre/dépendances au découpage** (fix 2026-07-20, ferme le
  dernier écart de D3 — le découpage pressenti listait 6 briques toutes livrées aux lots #76-80,
  mais `/scope` lui-même n'avait jamais été mis à jour pour s'en servir) : à la décomposition,
  `commands/scope.md` propose désormais un périmètre par lot, durci au lot #85 en **réflexion
  systématique** : chaque lot reçoit soit un périmètre proposé, soit « série » motivé en
  quelques mots (jamais de silence, mais jamais non plus de périmètre deviné à l'aveugle — au
  doute, série assumé), le tout inclus dans l'unique question de validation déjà utilisée pour
  modèle/effort/epic. Une fois les lots persistés, si ≥ 2 lots, le **verdict parallélisation
  est toujours restitué** (lot #85) : sans opportunité réelle (aucune vague de
  `parallelize --json` à ≥ 2 lots), une seule ligne motivée tirée de la sortie du script ; avec
  opportunité, plan affiché et **une** question à **3 choix** — tout parallèle / partiellement
  (PMZ propose le sous-ensemble cohérent, `depends_on` et disjonction respectés, le reste
  repasse en série) / série. Le lancement des sessions filles reste **manuel** dans tous les
  cas — aucun changement à la doctrine D3 palier 2, seule la découverte et la visibilité du
  raisonnement deviennent automatiques.
- **Réintégration en pipeline — `pmz:reintegrate`** (lot #80, 5ᵉ/6ᵉ brique de
  [D3](docs/decisions/D3-parallelisation-gouvernee.md), principe **P3** « jamais de big-bang ») :
  `lib/reintegrate.js` sépare trois responsabilités. `planReintegration(fleet, backlog)` (**pur**)
  ordonne les lots `ready` du fleet en un **pipeline** respectant `depends_on` (tri topologique) ;
  un lot encore `in_flight` tient la vague ouverte (`notReady`), un lot `ready` dépendant d'un lot
  en vol ou pris dans un cycle est `blocked` (jamais mergé avant sa dépendance). `runPipeline(root)`
  **EXÉCUTE** : pour chaque étape, `git merge --no-ff` de la branche du lot dans la branche
  d'intégration → **gate `verify`** → si vert, avance `fleet.setIntegrationHead` (**signal de
  rebase** pour les lots en vol) + `setLotState(reintegrated)` + vigie « lot prêt » ; si rouge
  (conflit → `merge --abort`, ou gate → `reset --hard`), **annule et STOPPE** (le coupable est le lot
  de l'étape — attribution sans ambiguïté). `aggregateChangelog` (**pur**) bâtit l'entrée de
  changelog **agrégée** de la vague ; vigie « vague close » quand toute la vague est réintégrée.
  La CLI `scripts/backlog.js reintegrate` **PROPOSE** le pipeline par défaut (rien mergé, comme
  `parallelize`) ; `--execute` exécute réellement (`--into <branche>` force la branche
  d'intégration). Contrairement aux hooks (fail-open muet), c'est une **commande délibérée** : elle
  rapporte conflits et gates rouges. S'appuie sur `lib/fleet.js`, `backlog.planWaves`/`waveBranch`,
  `lib/gitdebt.js` (lecture de tête git).
- **Deux gates, pas un** (lot #97) : le gate par étape ne prouve pas la vague.
  1. **Aucun merge sans filet** — `noGateSteps(plan, gate)` liste les steps dont le lot n'a pas de
     `verify` ; le mode proposition les marque ⚠️ et `--execute` **REFUSE** (`reason: 'no-gate'`,
     structuré en `--json`, avant tout `checkout` — rien n'est mergé). L'humain tranche :
     `--gate "<cmd>"` (gate de **repli** exécutée pour ces steps) ou `--allow-no-gate` (merge assumé
     sans filet, et `aggregateChangelog` **ne revendique alors plus** « gate verify vert »).
     Sans ça, un merge non vérifié faisait rougir le gate du lot **suivant** — coupable faux, en
     cascade.
  2. **Gate FINAL de vague** — deux lots verts *séparément* peuvent être rouges *combinés*
     (interférence sémantique sans conflit git) : `finalize` n'émet la vigie « vague close » qu'après
     un gate exécuté sur la branche d'intégration **après le dernier merge** (D3 P3 : typecheck +
     tests + build). Commandes : `--final-gate "<cmd>"` dédié, sinon `waveGateCommands(fleet,
     backlog)` = **union dédoublonnée des `verify` de TOUTE la vague** (y compris les lots
     `reintegrated` aux runs précédents — sinon un pipeline multi-runs perdrait leurs gates), privée
     de la dernière commande déjà passée verte sur l'état final (**déduplication d'exécution** : un
     verify coûte jusqu'à 600 s). Rouge → `waveClosed: false` + `reason: 'final-gate-failed'`,
     **sans rollback** et sans retoucher les états fleet `reintegrated` : les merges restent faits,
     seul le signal de clôture est retenu (l'humain arbitre, D3 palier 2). Cas dégénéré (aucun
     `verify` dans la vague) : on **clôt en le disant** (`finalGate.reason = 'no-gate'`) plutôt que
     de bloquer.
- **Rapport de réintégration persisté** (lot #99, FIA-22) : le bloc changelog agrégé et surtout la
  **sortie des gates rouges** n'existaient que sur le stdout du `--execute` — une session qui
  crashe ou qui omet le collage les perdait **sans recours** (une ré-exécution renvoie
  `nothing-ready`, les lots étant déjà `reintegrated`, et rien ne sait régénérer le bloc ; le
  diagnostic du conflit/gate rouge n'était même pas affiché en mode humain, seulement en `--json`).
  Le CLI écrit donc `.vibe-agent/logs/reintegrate-<horodatage>-<pid>.md` **avant toute sortie**,
  donc sur **tous** les chemins de retour (conflit, gate rouge, succès) : plan exécuté, statut par
  lot, sortie **intégrale** des échecs, gate final, bloc changelog, snapshot de la vague pris avant
  la purge. Même motif de « tiroir brut » que `lib/output-fallback` : horodaté à la seconde (un
  rerun le même jour n'écrase rien), **jamais injecté** au SessionStart (aucun code SessionStart ne
  lit `.vibe-agent/logs`), référencé par **chemin** dans la sortie. Un simple **refus**
  (`nothing-ready`, `no-gate`) n'écrit rien : aucun diagnostic à conserver.
- **Ledgers projet** (`.vibe-agent/{read,context}-ledger.json`) : auto-créés par
  `ensureLedger` (tout hook qui touche au projet) puis maintenus par `post-tool-use.js`
  (atomique `tmp`+`rename`, cap FIFO). Servent l'advisory `/check-context`. Granularité
  **per-fichier**, distincte de l'occupation globale. `post-tool-use.js` capture aussi le
  `statSync` (octets/mtime) de chaque `Read` : coût estimé ≈ `bytes / 4` tokens. Une relecture
  **complète** (`!partial`) d'un fichier **inchangé** (mtime identique à la dernière lecture)
  incrémente `estimated_context_waste` (total) et `waste_by_file[path]` (ventilé) — une lecture
  partielle ou un fichier modifié entre-temps est un coût justifié, pas du gaspillage.
  `audit-context.js` en tire la ligne « Gaspillage ≈ Xk sur N fichiers » + liste triée par coût.
- **Palier de gaspillage auto-surfacé** (`lib/ledger.js: evaluateWaste`, lot #52) : `stop.js`
  évalue **inconditionnellement** (hors branche clôture) le total `estimated_context_waste`
  contre des paliers **plus fins** que l'occupation — `WASTE_BUCKETS` = 25k/50k/100k puis
  rappel flottant tous les +100k. Au franchissement d'un **nouveau** palier, un seul
  `systemMessage` cite le **top-3 des coupables** (`waste_by_file` trié). Le palier franchi est
  **persisté** dans `context-ledger.json.waste_bucket` → monotone croissant, borné **1×/palier
  sur la vie du projet** (trans-session, pas 1×/session), écrit via `writeAtomic`. Ledger
  absent/corrompu/erreur → `null` (silence total, fail-open).
- **Statut d'économie chiffré en tokens** (`audit-context.js`, servant `/budget` et
  `/check-context`) : le verdict vert/orange/rouge est piloté par l'**occupation en tokens
  réels** — le miroir `context-ledger.json.occupancy.last` posé par le hook `Stop` (métrologie
  par tour) — combiné au gaspillage de relecture ci-dessus. Seuils alignés sur les paliers
  d'`occupancy.js` (orange à `BUCKETS[1]`=300k, rouge à `BUCKETS[2]`=500k, sans échelle inventée) ;
  un gaspillage **significatif** aggrave d'un cran — seuil aligné (lot #52) sur le **dernier palier
  fixe** de `WASTE_BUCKETS` (100k, source de vérité unique via `ledger.js`), de sorte que dès que
  `stop.js` a crié au franchissement du plus haut palier fixe, `/budget` lit au moins orange (pas
  de contradiction entre l'alerte de fin de tour et le statut d'audit). **Fallback annoncé** : sans occupation token connue
  (jamais passé par un `Stop` récent, hors-git), retombe sur le comptage de relectures et le dit
  explicitement — jamais de chiffre tokens fantôme.
- **Courbe des tours** (`audit-context.js`, lot #61) : `turnstats.computeTurn` persiste déjà à
  chaque `Stop` un FIFO `turns[]` (40 entrées, `{d: delta occupation, o: sortie, at}`) dans l'état
  hors-projet `<sha1(session_id)>-turns.json` — jamais relu avant ce lot. `/budget` retrouve le
  `session_id` courant via `context-ledger.json.session_id` (posé par `recordOccupancy`), lit ce
  FIFO et rend une **sparkline** unicode (1 caractère/tour, échelle min-max locale au FIFO) suivie
  d'un résumé chiffré (delta moyen, sortie moyenne). Aucune session connue → section absente
  (jamais de courbe vide ou trompeuse).
- **Advisory intra-tour** (`lib/advisory.js`, appelé par `post-tool-use.js`) : sur un `Read`
  **COMPLET** (`!partial`) d'un fichier **≥ 16 Ko** déjà lu, **inchangé** (mtime identique —
  signal `waste` renvoyé par `ledger.recordRead`) et **hors `files_modified`** (garde-fou en
  plus du mtime), émet un `additionalContext` d'une ligne (~60 tokens) signalant la relecture
  probablement redondante — et, si un résumé du fichier est connu (`read-ledger.summaries`,
  lot #53), le **sert en 2e ligne** à la place de la relecture (`ledger.getSummary`, lu
  seulement quand la relecture est redondante — zéro I/O sinon). Cet advisory ne porte jamais de
  `permissionDecision`, le `Read` est déjà exécuté (le seul levier « actif » de PostToolUse est
  `updatedToolOutput`, réservé au fallback de sortie Bash, lot #84). Plafonné par un état **hors-projet**
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
  backlog le plus pertinent (`lib/lot.js: suggestedTitle`) — priorité : lot **attribué à la
  session précédente** (`lotClosedBySession` : `closed_session_id === previousSessionId`, cf.
  plus bas — chemin **primaire**, ajouté v1.1.5) > lot **en cours** (travail qui continue,
  seulement si aucune clôture n'est attribuable à la session précédente) > dernier lot **clos**
  (repli sans attribution possible, cf. plus bas). **Jamais** de repli sur le prochain lot **à
  faire** (`nextLot`, todo) : rendu avec le même format qu'un lot clos (`titleForLot` ne distingue
  pas le statut), il affirmerait à tort qu'un travail non commencé a été fait (fix 2026-07-29,
  cf. plus bas). L'attribution est
  le vrai signal « qu'a fait la session précédente » : chaque session clôt son propre lot, donc 3
  sessions successives reçoivent 3 titres **distincts** (retour utilisateur japlan-app : 3
  sessions nommées à l'identique « #34 » — fix 2026-07-13). La clôture prime sur le lot en cours
  car une session qui clôt un lot puis enchaîne aussitôt sur le suivant laisse un `currentLot`
  fraîchement démarré (jamais encore touché) : le nommer masquerait ce que la session précédente
  a réellement fait (fix 2026-07-29). En repli, le « dernier » lot clos est celui au plus grand
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
  visait à éliminer. Tentation écartée (fix 2026-07-29) : déduire du CHANGELOG/dernier commit
  dans CE cas précis plutôt que de rester nu — rejeté, car ce texte souffre du **même biais
  d'attribution** qu'un lot périmé (le dernier commit peut appartenir à une session encore plus
  ancienne que la précédente, pas à celle qu'on nomme) ; la déduction ne reste légitime que
  lorsque le plan n'offre **aucun** titre du tout (cas ci-dessus), pas quand il en offre un qu'on
  choisit de taire. Puis demande à l'assistant de **proposer** ce nom en clair **et de poser une
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
  commit de clôture, et `closed_session_id` (session qui a clos le lot — auto-rempli depuis
  `.vibe-agent/session-state.json` (`lib/state.js: previousSessionId`) que le lot soit clos par
  le hook Stop ou par le CLI `done` (lot #96) ; `null` seulement sur opt-out explicite
  (`--no-session`) ou lot legacy pré-#96 — jamais un id tapé/deviné à la main). Au plus un `in_progress` ; cap 20 lots
  ouverts ; `doneLot` idempotent. `model_hint` est **obligatoire à l'`add` CLI** (refus doux sans `--model`) ;
  `effort_hint` est optionnel mais refusé (doux) si `--effort` est fourni hors énum. Les deux sont
  **réaffichés** partout où un lot est rendu (`show`/`start`/`next`, `summaryLines` → handoff auto,
  **filet resume `backlogResumeMessage`** qui pousse en plus une suggestion `/model` si le hint est
  un Claude joignable et un rappel « pose une `verify` » si le lot n'en a pas — lot #55)
  sous forme combinée `[modèle : … · effort …]` (`lib/backlog.js: modelEffortTag`) — jamais perdu
  silencieusement. Écrit par l'assistant (CLI) ; **auto-clos par `stop.js`**
  quand le working tree redevient propre et qu'exactement un lot est `in_progress` (sinon ne
  touche à rien — réconciliation bête via `backlog.js reconcile`). Jamais de promotion
  automatique du suivant. Champ optionnel `verify` (cap 150c, `MAX_VERIFY`, lot #29) : commande
  shell de preuve de clôture, posée à l'`add --verify` ou éditée après coup (`backlog.js verify
  --id N --set "…"`) — exécuté par `lib/project.js:runVerify` (helper partagé, ne throw jamais :
  `{ok}` / `{ok:false, timedOut, tail}`). `/close-batch` (`scripts/close-batch.js`) l'appelle avec un
  timeout **large** (`VERIFY_CLOSE_MS` = 120 s — clôture délibérée pilotée par l'assistant, hors budget
  serré d'un hook : une vraie suite peut aller au bout) avant d'indiquer le `done`. L'**ÉCHEC** n'est
  prononcé que sur un **exit ≠ 0 réel** (`ok:false && !timedOut`), jamais sur un grep de la sortie : un
  dépassement de délai tue l'enfant (`status` null) et son stdout bufferisé peut contenir des motifs
  trompeurs (p.ex. la ligne `ABORT` d'un test négatif volontaire) — il est affiché « non terminée »,
  pas « ÉCHEC » (bug lot #57bis). **Preuve déportée** (lot #67) : une verify qui expire est une
  verify *lourde* — la checklist prescrit son exécution en **subagent isolé** (outil Agent/Task,
  seul le verdict OK/ÉCHEC + dernières lignes remonte), jamais une relance à la main : **zéro
  sortie de tests dans le contexte principal**. Même prescription après correction d'un ÉCHEC.
  `VERIFY_CLOSE_MS` est surchargeable par l'env `PMZ_VERIFY_CLOSE_MS` (test-only, pour couvrir la
  branche timeout sans attendre 120 s). Refus doux **jamais bloquant** — même en échec la checklist reste
  exit 0, la décision de clore reste humaine/assistant. À
  l'**auto-clôture** (lot #44), `stop.js` l'exécute aussi mais avec un timeout **court**
  (`VERIFY_AUTOCLOSE_MS` = 2500 ms, borné bien en deçà du watchdog Stop 4,5 s), et depuis le
  lot #111 le verdict est calculé **AVANT** `doneLot` : sur `timeout`, `doneLot` n'est **jamais**
  appelé, le lot reste `in_progress` et le dit explicitement (« NON clôturé »). L'ordre inverse
  était le choix d'origine — persister d'abord pour qu'un dépassement de watchdog ne corrompe pas
  le backlog — mais il **fabriquait des clôtures fantômes** : le lot #110 s'est retrouvé `done`
  avec `closed_verify:"timeout"` alors qu'aucun de ses fichiers n'existait. Arbitrage assumé : un
  watchdog qui tue le verify laisse désormais le lot **ouvert**, état récupérable et visible,
  là où un `done` fantôme ne l'est pas (il faut `reopenLot`, et rien ne signale qu'il le faut).
  Un `failed` (échec net) reste **non bloquant** — seul le `timeout` empêche la clôture. Résultat
  rendu visible par `messages.js:closureProofMessage` — une non-terminaison dans le délai court est
  affichée « non terminée » (relancer via `/close-batch`), **pas** « ÉCHEC ». Le même message porte
  un **garde-fou CHANGELOG** : rappel doux si le commit de clôture (HEAD, tree propre ⇒
  `changelogTouched` se réduit au dernier commit) ne touche pas `CHANGELOG.md`. Un lot **sans
  aucune `verify`** est clos avec une ligne doux « **clos sans preuve** » (paramètre `noVerify`
  de `closureProofMessage`, lot #55) invitant à poser `--verify` au prochain `/scope`. try/catch
  dédié → fail-open : la clôture reste acquise même si la preuve échoue. Le VERDICT de cette
  preuve est désormais **persisté** (`closed_verify` — `'ok'|'failed'|'timeout'|'none'`, lot #96) :
  posé par `stop.js` juste après `runVerify`, via un setter DÉDIÉ (`backlog.js: setClosedVerify` —
  jamais via `doneLot`, idempotent et court-circuitant tout lot déjà `done`), donc jamais écrasé
  une fois posé. `'none'` = lot sans `verify` ; champ absent/`null` = non mesuré (`--no-verify`, ou
  watchdog tué pendant le verify). **La clôture CLI sait aussi l'écrire depuis le lot #119** —
  jusque-là, seule l'auto-clôture du Stop le faisait, si bien que les lots clos par le chemin
  **recommandé** (`/close-batch` → `backlog.js done`) étaient précisément ceux **sans preuve
  persistée**, l'inverse de l'intention du lot #96. Deux chemins, aucun ne devine :
  `--verify-verdict <ok|failed|timeout|none>` persiste un verdict **déjà obtenu** (c'est ce que
  `/close-batch` injecte désormais dans la ligne `done` qu'il propose — il vient d'exécuter la
  `verify`, la relancer coûterait deux fois la même preuve), et à défaut `done` **exécute** la
  `verify` du lot lui-même (`VERIFY_CLOSE_MS`, ce n'est pas un hook). `--no-verify` coupe
  l'exécution et laisse le champ `null` ; une valeur hors énum est **refusée** sans clore le lot.
  Non bloquant par choix (le refus doux sur échec est porté par `/close-batch`) : un verdict rouge
  est **persisté et annoncé**, jamais escamoté. Affiché par `show` et exposé en
  colonne d'export (`EXPORT_COLUMNS`) — distingue enfin un lot **prouvé** d'un lot clos sur échec,
  jusque-là stockés `done` à l'identique. Champ `closed_occupancy` (lot #29) :
  occupation contexte du tour figée à l'auto-clôture (`turnstats.computeTurn().occ`,
  métrologie de coût par lot) ; depuis le lot #96 le CLI `done` l'auto-remplit aussi (dernier `occ`
  mirorré au ledger, `lib/ledger.js: recordOccupancy`) — `null` seulement sur `--no-occupancy` ou
  aucune mesure disponible. Champ `cost_tokens` (lot #43) : coût réel cumulé du lot = tokens de sortie sommés par
  `stop.js` sur tous les tours où il était `in_progress` (`addCost`) — agrégat trans-session porté
  par le lot, figé de fait à la clôture, affiché par `show` ; cf. puce « Coût réel par lot » plus
  haut. Champs `cost_turns` / `closed_avg_cost_per_turn` (lot #111) : nombre de tours comptés dans
  `cost_tokens`, et accrétion moyenne (`cost_tokens / cost_turns`) **figée à la clôture** comme
  `closed_occupancy`. Sans ce diviseur, `cost_tokens` seul ne distingue pas un lot cher **parce que
  long** d'un lot cher **par tour** — et c'est la seconde famille que l'epic « Économie de contexte »
  cherche à faire baisser. Exposés en colonne d'export juste après `closed_occupancy` (l'assertion
  d'en-tête CSV est un préfixe ancré : toute colonne nouvelle se pose **après** lui, jamais avant).
  **Dépendances corrigeables après création** (`backlog.js depends --id N [--depends "2,3"]`,
  FIA-24, lot #98) : sans `--depends`, lecture ; avec, remplacement intégral via le `setDepends`
  déjà existant (`normalizeDepends` : self exclu, dédoublonné, capé `MAX_DEPENDS`) ; `--depends ""`
  vide la liste. Refus explicites sur `--id` inconnu, lot clos/abandonné, ou valeur non numérique
  (une faute de frappe ne doit pas se traduire par un vidage silencieux) ; un id ne correspondant à
  aucun lot est **averti** et non refusé — `blockedByOf`/`planWaves` le tiennent pour satisfait
  (tolérance hors-plan volontaire). **Réouverture d'un lot clos** (`backlog.js reopen --id N --note
  "raison"`, `lib/backlog.js: reopenLot`, FIA-25, lot #98) : la soupape aux quatre refus
  `status === 'done'` des setters. Repasse le lot en `todo` — **jamais** `in_progress`, `startLot`
  reste le seul chemin qui inscrit `session_owner`/vague — et **efface** `closed_commit`,
  `closed_at`, `closed_session_id`, `closed_occupancy`, `closed_verify`, plus (lot #100)
  `session_owner` et `lot_number`. Cet effacement n'est pas cosmétique : `doneLot` réécrit bien les
  quatre premiers au cycle suivant, mais **pas** `closed_verify` (posé par `setClosedVerify`, qui
  refuse d'écraser un verdict déjà là) — sans lui, un lot re-clos hériterait du verdict de l'ancien
  cycle ; et un `lot_number`/`session_owner` survivant faisait afficher « Lot N » et un
  propriétaire fantôme sur un lot redevenu **à faire**. `--note` **obligatoire** (une réouverture
  détruit de la trace, elle doit dire pourquoi) ; l'historique `reopened` (`{at, note, from_commit,
  from_verify, from_lot_number}`, capé `MAX_REOPEN` = 5, clé **droppée** si vide comme
  `integrations`) conserve le commit, le verdict et le numéro effacés, et son **cardinal** est
  exposé en colonne d'export `reopened` (vide si jamais rouvert : un lot repris deux fois n'a pas
  coûté le prix d'un lot passé du premier coup, et c'était invisible au reporting). Refus explicite si le lot est déjà ouvert, ou `dropped` (statut
  distinct : un lot abandonné se re-crée, il ne se rouvre pas). Côté archive, la fiche tier 1 est
  **complétée** en pied, jamais écrasée (`archive.appendFicheLine`), et la ligne d'index tier 0 est
  laissée telle quelle — la clôture a bien eu lieu, et la re-clôture la remet à jour (`mergeEntry`).
  **Durabilité par défaut** (le backlog ne doit JAMAIS être perdu) : le
  bootstrap pose un `.vibe-agent/.gitignore` **whitelist** (`*` puis `!.gitignore`, `!backlog.json`,
  `!rules.yaml`, `!trigram`, `!archive/` + `!archive/**` + `archive/raw/`) — l'état éphémère
  (ledgers, handoff, session-state, snapshot) reste hors git, seul le durable est suivi ; et
  `saveBacklog` **stage** le fichier à chaque écriture (survit à un
  `git clean`, part au prochain commit dès sa création). Sa disparition passée venait de ce qu'il
  n'était pas suivi par git. À part : `.vibe-agent/todo-snapshot.json`, capture passive de la
  todo-list Claude Code (écrasée à chaque `TodoWrite`, sens unique outil→disque — granularité
  tâche ≠ lot, jamais de promotion todo→backlog).
- **Toute troncature est bruyante côté CLI backlog** (epic « Périmètres fiables », lots #88/#90) :
  le backlog est la **spec** que lisent les sessions filles — une valeur amputée en silence (un
  « fait quand » coupé) se découvre au pire moment, quand une fille refuse de démarrer. Deux
  vecteurs, deux gardes dans `scripts/backlog.js` : (1) argv **non quoté** — tokens orphelins
  recensés (`lib/backlog.js: orphanArgs`) et commande **refusée** avant tout dispatch (#88) ;
  (2) valeur quotée **au-delà de son plafond `MAX_*`** — refus explicite (longueur reçue vs
  plafond + pattern conseillé « résumé court + spec complète dans un fichier du dépôt référencé
  en note »), sauf `--allow-trunc` qui accepte sciemment en **annonçant** la coupe (#90, sur
  `add`/`note`/`verify`/`drop`). `trunc()` reste en dernière ligne dans la lib (normalisation
  défensive au chargement, jamais supprimée) ; `show` marque `[⚠️ tronqué en donnée : …]` toute
  valeur stockée portant la signature de `trunc()` (`isTruncated` : longueur pile au plafond +
  « … » final) — `show` n'abrégeant rien à l'affichage, la distinction donnée/affichage est nette.
  checklist affiche, quand un lot est `in_progress`, un bloc `PMZ-Lot`/`PMZ-Cost`/`PMZ-Model`
  prêt à coller en pied du message de commit (id backlog, `cost_tokens` cumulé formaté
  `fmtK` — **avec sa part déléguée aux sous-agents** quand elle est non nulle (lot #119),
  `model_hint`/`effort_hint` combinés) — traçabilité coût/modèle par commit,
  greppable via `git log --format=%(trailers)` sans reparser le sujet. `null`/« non mesuré »
  si le champ correspondant est absent, jamais de valeur inventée. Nécessite `model_hint`/
  `effort_hint`/`cost_tokens`/`cost_subagent_tokens` sur `d.backlog.current` (`scripts/audit-batch.js:
  backlogSummary`, étendu à cet effet — absents du résumé initial qui ne portait que
  `id`/`title`/`verify`).
- **Tag modèle du lot suivant reporté au handoff** (`scripts/close-batch.js`, fix 2026-07-20) :
  `backlogSummary().next` (`scripts/audit-batch.js`) porte aussi `model_hint`/`effort_hint` — la
  ligne « Lot suivant à reprendre dans le handoff » de la checklist affiche son tag
  `modelEffortTag` (`lib/backlog.js`) au lieu du seul id/titre. `/close-batch.md`,
  `/fresh-session.md` et `templates/handoff-template.md` exigent désormais que le champ
  « Prochaine action recommandée » du handoff manuel nomme le lot suivant **et** son modèle
  préconisé, jamais l'un sans l'autre (le handoff auto le faisait déjà via `summaryLines` —
  seul le chemin manuel avait le trou).
- **Export du plan de lots** (`backlog.js export --format csv|md`, `lib/backlog.js: exportCsv`/
  `exportMarkdown`, lot #60) : sortie brute de tous les lots (colonnes fixes : id, title,
  status, epic, model_hint, effort_hint, verify, closed_verify (lot #96), cost_tokens,
  closed_commit, closed_at, closed_session_id, closed_occupancy),
  CSV échappé (guillemets doublés) ou table Markdown — pour reporting externe (tableur,
  compte-rendu) sans reparser `backlog.json` à la main. `--format` par défaut `md` ; refus
  doux hors énum `csv|md`.
- **Handoff de session** (`.vibe-agent/handoff.md`, `lib/handoff.js`) : UN fichier, **écrasé à
  chaque fin de tour** par `stop.js` (jamais cumulé — pas de bloat). Deux origines distinguées
  par marqueur en 1re ligne : `<!-- pmz:handoff:auto -->` (mécanique : epic/lot, branche,
  dernier commit, pointeur de vague active (`fleet.waveHandoffLines`, lot #91 — voir §
  « Registre de vague » plus haut), section `pmz:skip` (voir ci-dessous), plan de lots x/y + lot
  en cours + suivants, dernières todos, working tree filtré) et `<!-- pmz:handoff:manual -->` (riche, écrit
  par l'assistant via `/fresh-session` ou `/close-batch` — jamais écrasé par l'auto tant qu'il
  n'est pas consommé). Au SessionStart suivant (`startup`/`clear` uniquement, jamais
  `resume`/`compact`), le handoff est **injecté** (cap 6 000 caractères) puis **marqué consommé**
  (manuel → auto, l'auto reprend la main). Un fichier sans marqueur PMZ (notes utilisateur) n'est
  ni écrasé ni injecté. La détection de « lot ouvert » de `stop.js` utilise
  `gitStatusMeaningful` (porcelain **sans** `.vibe-agent/`) : le churn ledgers/handoff ne compte
  pas comme lot ouvert et ne bloque pas sa clôture.
  **Handoff PAR LOT en vague** (lot #99, FIA-19) : `handoff.md` est clé sur le seul `root`. En
  vague parallèle, N sessions filles partagent le même checkout donc le même `.vibe-agent/` — un
  fichier unique = *last-writer-wins* : l'état du lot A remplacé par celui du lot B juste avant
  la reprise de A. Une session **inscrite au fleet** écrit donc `handoff-lot-<id>.md` ;
  `handoff.md` reste celui de l'orchestrateur. En **lecture**, la fille essaie son fichier de lot
  puis retombe sur `handoff.md` (elle démarre donc sur le handoff de l'orchestrateur tant qu'elle
  n'a pas écrit le sien) ; en **écriture**, jamais de repli — ce serait précisément le
  last-writer-wins qu'on supprime. Activé **uniquement** quand la fille partage le root
  (`lot.worktree` vide) : en mode worktree chaque fille a déjà son `.vibe-agent` isolé, un fichier
  par lot y serait mort-né. Hors vague : strictement rien ne change (invariant mono-session).
  Articulation avec le registre de vague : **`fleet.json` reste le handoff PARTAGÉ** (structure —
  qui tient quoi, périmètres, tête d'intégration), **`handoff-lot-*` est le handoff PAR SESSION**
  (état riche : décisions, non-vérifié, prochaine action) ; ni l'un ni l'autre ne porte le plan,
  qui se recalcule depuis le backlog. Purge à la réintégration (`purgeLotHandoffs`, cf. « Registre
  de vague ») — sinon péremption d'état dans `.vibe-agent`. Le cas mono-session « deux
  `/close-batch` successifs s'écrasent » n'est **pas** corrigé : l'écrasement dernier-état est le
  design assumé.
- **Archive des lots clos — tier 0** (`.vibe-agent/archive/index.md`, `lib/archive.js` + CLI
  `scripts/archive.js`, epic « Archive à tiroirs », lot #94) : contrepartie **durable** du handoff.
  Le handoff reste un fichier unique écrasé (canal de reprise) ; l'archive est un référentiel
  **séparé, versionné git, jamais injecté**. Tier 0 = `index.md`, une ligne par lot clos, format
  contraint et greppable :
  `#0094 | 2026-07-27 | <sha> | epic:<epic> | verify:<OK|ÉCHEC|timeout|aucune|inconnu> | fiche:<oui|non> | <titre>`.
  Markdown ligne-à-ligne et **pas** JSON : lu par l'humain ET par `grep`, diff git lisible, merge
  d'un append trivial, et une ligne corrompue n'invalide pas le reste — là où un JSON corrompu
  retombe en bloc sur le fallback de `readJson` (mode de perte totale déjà observé sur les ledgers).
  **Filet machine** : `doneLot` (`lib/backlog.js`) appelle `appendIndexLine` après un `saveBacklog`
  réussi — l'index est donc complet même quand aucune fiche narrative n'est écrite (auto-clôture au
  Stop, clôture CLI), et le `fiche:non` rend la dette de documentation **visible** au lieu de la
  masquer. `appendIndexLine` est **idempotent par id** et sa fusion est **non dégradante** (un
  `fiche:oui` ou un `verify` connu n'est jamais réécrit en `non`/`inconnu` par un rappel machine) :
  le double chemin Stop + CLI ne produit ni doublon ni régression. Écriture atomique
  (`writeAtomicText`) + `git add` best-effort (modèle `stageBacklog`). Rétro-remplissage :
  `node …/scripts/archive.js backfill [--dry-run]`, reprenable et idempotent (skip des ids déjà
  présents), source = `backlog.json` (`closed_at` n'est pas fiable, l'**id** est le seul ordre sûr).
  **Pare-feu** : aucun hook ni module de la chaîne d'injection (`session-start.js`, `handoff.js`,
  `messages.js`, `pre-compact.js`) ne requiert `lib/archive.js` en lecture — l'archive s'écrit à la
  clôture et se lit **à la demande**, jamais toute seule. Spec : `mwn/promptimizer-archive-handoffs/`.
- **Archive des lots clos — tiroirs tier 1/2** (`lib/archive.js`, CLI `scripts/archive.js`,
  commande `/pmz:archive`, lot #95) : les deux tiroirs profonds, ouverts **un à la fois**.
  **Tier 1** = `archive/lots/lot-NNNN.md`, la fiche narrative (id zero-paddé 4 chiffres → tri
  lexicographique = tri numérique), **versionnée** et **immuable** : `writeFiche` refuse d'écraser
  une fiche existante sans `--force`. Un fichier par lot, écrit une fois à la clôture → zéro course
  entre sessions filles, contrairement au handoff unique last-writer-wins. Trois gardes **explicites,
  jamais muettes** (`exists` / `no-marker` / `too-long`) : le marqueur `<!-- pmz:archive:lot N -->`
  doit porter le **bon** id (pas de fiche mal rangée) et la borne dure de 8 000 caractères refuse
  plutôt que de rogner — une fiche trop longue est un symptôme (diff ou listing collé), pas un cas
  à couper. Une fiche écrite passe sa ligne d'index en `fiche:oui` via la fusion non dégradante.
  **Une seule exception à l'immuabilité** (lot #98) : `appendFicheLine` **ajoute** une ligne en pied
  — jamais une réécriture de section — utilisée par la réouverture d'un lot (`reopenLot`) pour
  inscrire « rouvert le AAAA-MM-JJ, raison ». La fiche du cycle clos n'est ni démentie ni écrasée ;
  sans fiche existante, l'appel est un no-op explicite (`missing`) et le champ `reopened` du backlog
  reste la seule trace.
  **Tier 2** = `archive/raw/lot-NNNN.md`, le brut (retour de sous-agent, handoff manuel intégral) :
  **non versionné** (volumineux, porteur de chemins machine), jamais stagé, écrasable sans cérémonie
  — sa perte au clone est acceptable puisque la fiche capture le stable.
  **Points d'écriture** — `/close-batch` émet un squelette de fiche **pré-rempli** (étape 6bis) : c'est
  le seul moment où le résultat de `verify` existe (il n'est persisté dans aucun champ du backlog),
  et la machine s'arrête là où commence le « pourquoi ». L'étape 6ter copie le handoff manuel en
  tier 2 **avant** que `markConsumed` ne le rebascule en auto : le handoff riche n'a qu'une vie.
  **Consultation** — `/pmz:archive` : sans argument `index` (tier 0 seul), avec un id `show` (une
  fiche seule), et le brut derrière `--confirm` — sans lui, `raw` n'affiche que chemin et taille,
  la commande imposant une question à choix avant d'ouvrir des dizaines de Ko de contexte.
  **Pare-feu, verrouillé par test** (`test/run-tests.js`, section « Archive tier 1/2 ») : un canari
  semé dans les quatre fichiers d'archive ne doit apparaître ni dans `session-start` (les 4 sources,
  avec et sans handoff), ni dans le handoff auto, ni dans `pre-compact` ; et un **verrou structurel**
  relit les sources de `hooks/*.js` + `lib/handoff.js` + `lib/messages.js` pour asserter l'absence
  de tout `require` d'archive et de tout chemin d'archive — il casse **avant** le pare-feu. Deux
  canaux résiduels fermés au passage : `skipCandidates` exclut tout `.vibe-agent/` (consulter
  l'archive ne consomme plus les slots `pmz:skip:` du handoff) et `seedSummaries` / `topSummaries` /
  `scoredSummaries` refusent les clés sous `archive/` (un `pmz:summary:` d'archive se ré-injectait
  de session en session — la boucle exacte que l'archive existe pour éviter ; filtré à la source
  ET à l'émission, pour les ledgers déjà pollués).
  **Reste à faire** : `/reintegrate` (fiches filles + `archive/waves/wave-<id>.md`) et la
  persistance du résultat `verify` dans le backlog.
- **`pmz:skip` du handoff → `avoid_reread_notes`** (`lib/handoff.js#parseSkipPaths`,
  `lib/ledger.js#seedAvoidReread`, lot T3 ; boucle fermée lot #51) : des lignes `pmz:skip:
  <chemin>` sèment `avoid_reread_notes` (read-ledger) dès l'injection du handoff au SessionStart
  suivant — actif dès le tour 1, sans attendre une 1re relecture réelle. Un handoff **manuel**
  peut lister ces chemins à la main ; l'auto (`writeAutoHandoff`) les **génère lui-même** à
  chaque tour à partir de deux sources mesurées : les fichiers lus le plus récemment
  (`files_read`) et le top-3 des plus gaspillés (`lib/ledger.js#topWaste`, relectures complètes
  inchangées — le gaspillage mesuré devient signal modèle-visible sans action manuelle). Les deux
  excluent les chemins modifiés **depuis le dernier commit** (`files_modified` filtré par
  `lastCommitEpoch` — `files_modified` brut n'est jamais purgé et daterait « modifié depuis
  toujours »). Émises juste après la ligne epic/branche, **avant** les blocs volumineux
  (plan/todos/working tree) : `readHandoff` tronque à 6 000 caractères avant le parse, ces lignes
  doivent survivre en premier. Ledger vide → section omise (comportement inchangé). Champ
  `avoid_reread_notes` réutilisé, pas dupliqué. Parse raté/vide = ignoré silencieusement
  (fail-open).
- **`pmz:summary` du handoff → `read-ledger.summaries`** (`lib/handoff.js#parseSummaryLines`,
  `lib/ledger.js#seedSummaries/getSummary/topSummaries`, lot #53) : des lignes
  `pmz:summary: <chemin> — <résumé>` (« — » tiret cadratin obligatoire, ligne malformée
  ignorée) sèment `summaries` (clé = chemin **normalisé `/`** — les lignes du handoff sont
  POSIX alors que `relOf` produit des `\` sous Windows ; texte plafonné 240 c ; cap 200
  entrées, éviction des plus anciennes via `capObject` étendu aux entrées `{ at }`). Trois
  débouchés : (1) l'advisory de relecture redondante sert le résumé (voir ci-dessus) ;
  (2) le handoff **auto** restitue les résumés **scorés par ROI** (`scoredSummaries`, lot #66)
  en lignes `pmz:summary` — la boucle survit de session en session sans relecture ; (3) le
  modèle écrit les lignes initiales dans le handoff **manuel** (template + `/fresh-session`
  + `/close-batch`). **Purge sur Edit/Write** (`recordModify`) : un fichier modifié perd son
  résumé — mieux vaut aucun résumé qu'un résumé faux. `relOf` (post-tool-use) relativise
  désormais via `fs.realpathSync` quand le cwd passe par un symlink (macOS `/var` →
  `/private/var`) — sinon les clés de ledger divergeraient des chemins du handoff.
- **Résumés servis à ROI mesuré — `scoredSummaries` (`lib/ledger.js`, lot #66)** : le handoff
  auto ne déverse plus les N résumés les plus **récents** mais les mieux **rentables**. Score
  par chemin = **octets × fréquence de relecture** — `octets` = dernière taille connue du
  fichier (`reads[].bytes`), `fréquence` = nb d'entrées dans `repeated_reads` (minorée à 1, un
  résumé pas encore relu garde un score ∝ sa taille). Tri décroissant, tie-break récence (`at`)
  → un score nul reste ordonné comme l'ancien `topSummaries`. La sélection est remplie
  **gloutonnement sous un budget de caractères explicite** (`MAX_SUMMARY_BUDGET_CHARS = 1200`,
  câblé avec le cap de lignes `MAX_SUMMARY_LINES`) : garde toujours ≥ 1 résumé même s'il excède
  seul le budget. Le **gain estimé** (`gainTokens` = Σ `estTokens(octets) × freq` − coût
  one-shot des résumés servis) est affiché dans l'en-tête du bloc (« ≈ Nk tokens de relecture
  évités ») pour rendre l'économie visible au repreneur. Fail-open : `{ entries:[], gainTokens:0 }`.
- **Amorçage à froid — `hot_files` (`lib/project.js#gitHotFiles`,
  `lib/ledger.js#seedHotFiles/hotFiles`, `lib/bootstrap.js#runBootstrap`, lot #65)** : au
  bootstrap (`/init` ou auto-scaffold) d'un dépôt **mûr** (`hasAnyCommit` vrai) dont le ledger
  vient d'être créé (jamais un ledger déjà existant/vécu — condition sur `created`, pas
  seulement `isInitialized`), `gitHotFiles` compte les occurrences de chemins sur les 500
  derniers `git log --name-only` et sème `context-ledger.hot_files` (top 15, `{ path, commits }`
  décroissant). `seedHotFiles` ne remplace jamais un `hot_files` non vide (semé ou accumulé en
  session réelle) : rejouer le bootstrap est un no-op reprenable. Dépôt neuf (0 commit) ou
  `git log` en échec → `[]`, fail-open silencieux.

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

**Clivage d'état plugin/manuel** (lot #118, epic Bridge RTK) : un script mutant l'état persisté
peut être lancé **« à la main »** — terminal nu, hors session Claude Code — auquel cas
`CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` sont **absents du process**, même sur une machine où le
plugin PMZ est installé et actif. `stateDir()` y retombe alors sur le chemin manuel
(`~/.claude/promptimizer/state`) alors que les hooks du plugin, eux, tournant avec l'env posé par
le harness, visent `CLAUDE_PLUGIN_DATA/state` — deux fichiers différents : un `enable` écrit là où
personne ne lit (symptôme observé : « un enable qui n'active rien »). Le chemin réel de
`CLAUDE_PLUGIN_DATA` n'est **jamais reconstruit** en son absence (aucun format garanti côté
harness au-delà de l'env, cf. D1) — `claude-dir.js` expose donc `stateDirDivergenceRisk()` :
détecte le plugin installé sur disque (mêmes signaux que `doctor.js`, `enabledPlugins` de
`settings.json` ou `plugins/installed_plugins.json`, dupliqués volontairement — `lib/` ne dépend
pas d'`install/`) **indépendamment** de l'env du process courant, et signale un risque quand ce
dernier ne tourne pas dans le contexte plugin. `rtk-status.js`/`scripts/rtk.js` l'exploitent :
`status` affiche l'alerte, `enable` **refuse** plutôt que d'écrire un état mort.

Audit des AUTRES appelants de `stateDir()` (mêmes symptômes possibles ?) : **aucun** ne partage ce
clivage. `lib/occupancy.js` et `lib/rtk-metrics.js` ne sont écrits/lus que depuis des hooks (env
harness toujours correct) ou des commandes slash exécutées **en session** (même contexte shell que
le hook, `CLAUDE_PLUGIN_DATA` y est donc posée en plugin) — aucun chemin d'écriture « à la main »
n'existe pour ces deux-là. `install/merge-settings.js` n'écrit sous `STATE_DIR` que le sidecar de
prise de relais `context-guard.py` — mécanisme **exclusif au canal manuel** (impossible en plugin,
cf. D1) et relu uniquement par `merge-settings.js` lui-même : pas de second lecteur susceptible de
diverger.

`merge-settings.js` : parse strict (échec → **abort**), backup horodaté vérifié (suffixe `-N`
anti-collision, perms 0600), fusion **append-only par event** taguée (idempotente). La purge
reconnaît les tags **courant + hérités** (`PMZ_TAGS`) → un renommage du paquet ne laisse pas de
hooks orphelins (sinon double-firing). Préserve `permissions`/`statusLine`/`enabledPlugins` et
tout hook tiers. Prise de relais de `context-guard.py` (`--takeover`) : ses entrées `Stop`
retirées sont sérialisées dans le **sidecar** `state/taken-over.json` ; `--remove` **restaure
depuis ce sidecar** (le backup horodaté n'est qu'un filet de secours, pas la source de
restauration) et **signale** un sidecar corrompu au lieu de l'avaler. Écriture atomique, perms 0600.

**Verdict coexistence PreToolUse — hook natif RTK vs gate PMZ** (lot #115, epic Bridge RTK) :
question posée — `rtk init -g` installe son propre hook sur PreToolUse `Bash` ; peut-il
remplacer le gate de sûreté PMZ (`bash-guard.classify()`, deny/ask) plutôt que coexister avec
lui ? **Verdict : NON**, on garde le gate PMZ ; aucune recommandation de bascule vers `rtk init -g`
seul. Preuves : (1) la doc Claude Code officielle confirme que plusieurs hooks PreToolUse pour un
même matcher tournent **en parallèle et indépendamment** (chacun reçoit le `tool_input`
**original**, pas de chaînage) et **ne documente aucune règle de fusion/priorité** entre
`permissionDecision`/`updatedInput` divergents ; (2) le binaire `rtk` (v0.43.0) expose son propre
format de décision de permission (`deny` via sa config `deny_rule`) — ce n'est pas un simple
réécrivain, c'est un **second décideur de sûreté non coordonné** avec PMZ ; (3) une trace live à
deux hooks concurrents (bac à sable `claude -p`) a été tentée mais bloquée par une frontière
d'auth propre à cet environnement (impossible d'authentifier un second process CLI headless
depuis cette session) — non affirmé comme vérifié en pratique faute de cette preuve-là. Portée du
verdict : le mécanisme de neutralisation existant (lot #82, conflit détecté → `bridgeEnabled`
repassé à `false`) protège **uniquement** contre la double réécriture du bridge **optionnel** — il
reste inchangé et suffisant pour ce risque précis. Le gate de sûreté, lui, ne consulte **jamais**
`rtk-status` : `pre-tool-use.js` appelle `classify(cmd)` avant tout accès à `rewriteCommand()`, il
rend donc toujours son verdict deny/ask, qu'un conflit RTK soit détecté ou non. Verdict exporté
(`rtk-status.RTK_HOOK_COEXISTENCE_VERDICT`) et verrouillé par test (`test/run-tests.js`) pour
éviter de rouvrir la question sans nouvelle preuve.

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
- **Métadonnées marketplace complétées + première publication conforme** (lot F1, 2026-07-27) :
  `promptimizer/.claude-plugin/plugin.json` portait `name`/`version`/`description`/`author`/
  `keywords` mais aucun `license`/`homepage`/`repository` — champs optionnels du schéma manifeste
  officiel (`docs/en/plugins-reference`) mais attendus pour une diffusion publique sérieuse. Ajout
  de `license: "MIT"` (`LICENSE` créé à la racine du dépôt, absent jusqu'ici) et
  `homepage`/`repository` pointant sur `github.com/shwrm-xx/promptimiser` (dérivés du remote
  `origin`, pas inventés). `marketplace.json` (généré par `build-plugin.js`) était déjà conforme
  au schéma requis (`name`, `owner.name`, `plugins[].name`+`source`) — vérifié contre la doc
  officielle, aucun changement nécessaire côté marketplace elle-même. `VERSION` bumpée
  1.7.0 → 2.0.1 (décision utilisateur explicite, marque la première publication publique
  conforme, pas une rupture de compatibilité technique). Validé avant publication :
  `claude plugin validate <dossier> --strict` (0 avertissement) + installation réelle en
  `CLAUDE_CONFIG_DIR` bac à sable (`marketplace add` + `plugin install`) avant tout
  `publish-plugin.js --push`.

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
- **Occupation RELATIVE à la fenêtre du modèle** (lot OC3, `pmz/impl/occupancy-oc.js`) : le
  transcript `.jsonl` de Claude Code n'existe pas ici — la source est l'événement
  `message.updated` (tokens du dernier message assistant : occ = input + cache.read +
  cache.write), avec repli `client.session.messages` à l'idle. L'occ est comparée à la
  **fenêtre utile** (`limit.context − limit.output`, lue dans le catalogue
  `client.config.providers`) en paliers **relatifs 50/70/85/95 %** ; franchissement → toast
  (pas de statusline). Palier persisté monotone par session (état hors-projet, clé sha1),
  réarmé par une nouvelle session_id ou un resync post-compaction.
- **Équivalent Stop = `event: session.idle`** (lot OC3, coût+preuve lot #54) : idempotent
  multi-idle (l'anti-spam monotone du palier + le drapeau de clôture par lot évitent tout
  doublon). Y sont branchés, dans l'ordre : franchissement d'occupation (toast) ; **coût réel
  par lot** (`accountCost`, parité `stop.js` bloc a4) — agrège les tokens de SORTIE du dernier
  message assistant sur le lot in_progress (`addCost`), **AVANT** le bloc clôture ; faute de
  transcript scannable, l'anti-double-comptage passe par un **watermark messageID**
  (`state.cost_watermark`), et un toast **warning** est émis au franchissement du budget 250k ;
  puis rappel/auto-clôture de lot (miroir de `hooks/stop.js`, canal toast au lieu de
  `systemMessage`). À l'**auto-clôture univoque**, la **preuve de clôture** est désormais rejouée
  (parité `stop.js` bloc b2) : `verify` court (`runVerify`, `VERIFY_AUTOCLOSE_MS`) + garde-fou
  `CHANGELOG` (`closureProofMessage`) → échec/timeout en toast distinct, **clôture jamais
  bloquée**. La clôture *disciplinée* (résumé demande, map fait/non fait) reste la commande
  `/pmz close-batch`. Puis handoff auto (`writeAutoHandoff` réutilisé tel quel), et **renommage
  de session** (`client.session.update`, 1× par session). Renommage : contrairement à Claude Code
  où PMZ ne fait que suggérer un titre (validation utilisateur), OpenCode n'offre aucun canal de
  confirmation à un plugin — le titre est donc appliqué directement mais **jamais réécrit** ensuite
  (drapeau `renamed` par session).
- **Injection différée** (lot OC3) : pas d'équivalent au `additionalContext` de SessionStart —
  le contexte de (re)démarrage est mis en file par `session.created` (gouvernance + handoff +
  plan de lots) et `session.compacted` (réinjection minimale du lot en cours), puis flushé au
  **1er `chat.message`** en part texte synthétique (`out.parts`). `session.compacted` sert aussi
  de resync du palier d'occupation (l'occ chute après compaction).
- **Nudges de gouvernance = `chat.message`** (lot OC4, miroir de `hooks/user-prompt-submit.js`) :
  au même point que le flush d'injection, `computeNudges` détecte **init avant code** (projet
  non `isFullyInitialized` + prompt de démarrage), **demande trop large** (regex/bullets), et
  **model-mismatch**. Anti-spam 1×/session via `prompt_reminders` (lib/state, remis à zéro sur
  nouvelle session_id). Le nudge d'occupation haute n'existe PAS ici : côté OpenCode il passe par
  le toast à `session.idle`. Nudges et injection différée sont fusionnés en une seule part
  synthétique. Le prompt utilisateur est lu dans `out.parts` (parts texte), pas dans `input`.
- **Vigie model-mismatch avec résolution locale** (lot OC4) : le modèle réel est lu dans l'occ
  record (`providerID/modelID` du dernier `message.updated`) — pas `inp.model`, qui arrive `null`
  au `chat.message` en 1.18.3. Le `model_hint` du lot (alias libre « sonnet »/« opus ») n'est
  comparé que s'il est **résoluble** par le catalogue `client.config.providers` du côté courant
  (`hintResolvable` : au moins un modèle dont l'id contient l'alias) ; un hint absent du catalogue
  (ex. « sonnet » sur une install 100 % locale) ou un catalogue indisponible → **ignoré en
  silence**, jamais de faux nudge. Comparaison réutilise `lib/modelwatch.js: modelsDiffer` (pure).
- **Toutes les commandes `/pmz`** (lot OC4) : `budget`, `scope`, `close-batch`, `fresh-session`
  rejoignent `about`/`help`/`init`/`check-context` — 8 au total, chemins réécrits vers
  `~/.config/opencode/pmz/{scripts,templates}/`, frontmatter `allowed-tools` (Claude Code) retiré.
  Les scripts sous-jacents (`audit-context.js`, `backlog.js`, `close-batch.js`) sont les mêmes
  libs vendorées, aucun code métier dupliqué.
- **Pas de merge de settings** : l'installer ne pose que `plugin/pmz.js`, `command/pmz/` et
  `pmz/` — il ne touche jamais `opencode.json` ni un plugin/commande tiers.
- **État projet `.vibe-agent/` partagé** avec Claude Code (backlog/handoff cross-outil).
  Règle : pas deux sessions simultanées sur un même projet ; un `model_hint` non résoluble
  par un côté est ignoré silencieusement (cf. vigie model-mismatch OC4 ci-dessus).
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
- **Parallélisation gouvernée : GO palier 2, palier 3 conditionné** (2026-07-20) : N sessions
  filles coordonnées par périmètres exclusifs disjoints (hook PreToolUse étendu à Edit/Write en
  mode fleet uniquement — révision scopée de « PreToolUse limité à Bash » ci-dessous), contrat
  d'interfaces gelé avant fan-out, réintégration pipeline avec gates. Principe : les conflits
  s'éliminent au découpage, pas au merge. Rien d'implémenté à ce jour — orientation et découpage
  pressenti : [docs/decisions/D3-parallelisation-gouvernee.md](docs/decisions/D3-parallelisation-gouvernee.md).
- **Occupation-tokens plutôt que compteur de tours** (vs spec) : signal réel, déjà éprouvé par
  `context-guard.py` ; PMZ le reprend à son compte (système standalone unifié).
- **Stop non bloquant** : un Stop bloquant risque la boucle (cap 8) et gonfle le contexte ;
  `systemMessage` informe sans bloquer.
- **PreToolUse limité à `Bash`** : `acceptEdits` montre que l'utilisateur veut peu de
  confirmations ; on ne gêne pas Read/Edit. **Révision scopée (lot #78)** : hors vague, ce
  contrat tient à l'identique ; à l'intérieur d'une vague active, `Edit`/`Write`/`MultiEdit` sont
  gardés **pour le seul test de périmètre**, avec `deny` sur **certitude** uniquement (chemin hors
  des globs du lot). L'exception est donc strictement bornée au régime fleet-fille — voir
  « Garde de périmètre » plus haut.
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
  **Amendée (lot #94, epic « Archive à tiroirs »)** : le handoff RESTE un fichier unique écrasé —
  c'est le canal de *reprise*, la décision ci-dessus tient. Mais la conclusion « pas d'historique »
  était trop large : le narratif riche de fin de lot (décisions **et pourquoi**, non-vérifié,
  dette) n'avait qu'UNE vie et a été perdu pour les ~90 lots clos, ce que git/CHANGELOG ne
  restituent pas (ils portent le *quoi*, pas le *pourquoi* ni le non-vérifié). L'archive
  (`.vibe-agent/archive/`) est un référentiel **séparé** qui répond aux objections d'origine :
  bloat → une entrée courte et bornée par lot ; nettoyage → immuables et versionnées ; « valeur
  seulement pour la session suivante » → faux pour les décisions et le non-vérifié, prouvé par la
  perte constatée. Elle n'est **jamais** injectée automatiquement (pare-feu, voir § Flux de
  données) : c'est ce qui rend l'historique gratuit en contexte.
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
  « feature » = un epic court (2-5 lots). Le champ `us` (lot #101) ne rouvre **pas** cette
  décision : la maille de pilotage reste le lot, l'US est un **document optionnel référencé**
  (un pointeur vers un fichier du dépôt), jamais une ligne du plan ni un niveau de hiérarchie.
- **Frontière Jira : écarté** (epic « US & Jira », lots #101-#103 ; retiré au lot #105, epic
  « Formalisation US ») : PMZ a porté un temps un pointeur de clé Jira (`PROJ-123`, zéro réseau,
  zéro secret, zéro synchronisation — traçabilité seule). Retiré faute d'usage réel : sans
  connectivité Jira derrière, un pointeur inerte ne rendait pas le service attendu. **Option MCP
  Atlassian toujours écartée**, pointeur ou pas : une intégration vivante exigerait un token API
  (violation « zéro secret » du dépôt), des appels réseau dans des hooks fail-open (une panne ou
  latence Jira dégraderait des sessions locales qui n'en ont pas besoin), et une dépendance
  externe (violation « zéro dépendance »). Si un besoin réel de lecture/écriture Jira émerge un
  jour, il passera par un MCP configuré **côté utilisateur** (hors PMZ). Cf. aussi « Epic = label,
  pas conteneur » ci-dessous : une table de tickets avec statuts serait le début du Jira que
  `backlog.js` refuse par principe.
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
- **Grammaire de sévérité des nudges** (lot #56, epic « Coût par livrable ») : le canal
  `systemMessage` accumule des nudges hétérogènes (occupation, coût, gaspillage, clôture, preuve…)
  qui, concaténés par `stop.js`, forment un pavé sans hiérarchie. `lib/severity.js` centralise
  trois niveaux (info/warn/alert), leur glyphe et leur **rang de priorité** ; les fabriques de
  `lib/messages.js` préfixent chaque nudge VISIBLE de son glyphe (structure « constat → chiffre →
  action »). Frontière assumée : **seuls les nudges visibles** (systemMessage / toast OpenCode)
  portent un glyphe — les messages `additionalContext` (MSG_ACTIF, handoff, résumés, vigie modèle,
  occupancyPrompt) sont des **instructions injectées**, pas des alertes, et un glyphe y coûterait
  des tokens de contexte pour rien. `severityOf(texte)` reparse le glyphe : c'est le hook prévu
  pour l'**arbitre de tour** (lot #57) qui plafonnera/triera les nudges par sévérité décroissante
  sans re-parser la prose. Glyphes purement cosmétiques (jamais lus par une logique de contrôle) —
  fail-open par construction. Alternative écartée : nudges structurés `{severity, text}` portés
  jusqu'à `stop.js` — reporté au lot #57 (l'arbitre), pour garder #56 non invasif sur les hooks.

- **Arbitre de tour — plafond de nudges** (lot #57, epic « Coût par livrable ») : même préfixés
  d'un glyphe, cinq à six nudges concaténés en un tour noient le signal important. `lib/arbiter.js`
  (`arbitrate(items, {max, sevOf})`) plafonne à `MAX_NUDGES_PER_TURN` (3) en gardant les plus
  **sévères** : tri par rang décroissant (départage stable par ordre d'origine), puis **ré-émission
  dans l'ordre d'origine** (l'ordre de lecture reste stable, la hiérarchie vient du glyphe). Il lit
  la sévérité via `severityOf` (le glyphe de tête) sans re-parser la prose — décision « Grammaire de
  sévérité » ci-dessus. **Choke point unique des deux canaux** : `stop.js` fait `arbitrate(parts)`
  juste avant `systemMessage(parts.join)` ; le plugin OpenCode collecte tous les toasts candidats de
  l'idle (occupation + coût/clôture/preuve) et les passe par `arbitrate(…, {sevOf: t => t.sev})`
  avant émission — `evaluateOccupancy`/`closureAndHandoff` **retournent** désormais leurs toasts au
  lieu de les émettre (les effets de bord état+handoff restent inconditionnels). Fail-open : entrée
  non-tableau → `[]`, jamais d'exception. En pratique OpenCode dépasse rarement 3 toasts (clôture et
  preuve sont mutuellement exclusives) : le port vise la **parité de contrat**, pas un gain immédiat.
  Alternative écartée : indicateur « (+N nudges masqués) » en pied de bloc — écarté pour rester
  littéral (plafond seul demandé) ; à rouvrir si un drop silencieux d'une carte de clôture / d'une
  preuve gêne — c'est précisément ce que le lot #108 a traité (fusion + coda hors arbitre, ci-dessous).

- **Bilan d'epic auto + hitRate visible** (lot #58, epic « Coût par livrable ») : `backlog.epicBilan(b,
  lot)` s'appelle juste après `doneLot` — renvoie `null` tant qu'un lot de la MÊME epic reste
  todo/in_progress, sinon agrège ce qui est **déjà persisté par lot** (`cost_tokens` #43,
  `started_at`/`closed_at`) : nombre de lots, coût total, coût moyen/lot, durée (écart entre le plus
  ancien `started_at` et le plus récent `closed_at`, `null` si l'une des deux dates manque — vieux
  lots créés avant l'ajout de `started_at`). Aucun recalcul depuis le transcript. `epicBilanMessage`
  émet le nudge (glyphe INFO, grammaire #56) ; passe par l'arbitre de tour (#57) comme les autres.
  **Choke points identiques à #57** : bloc auto-clôture de `hooks/stop.js`
  côté Claude Code, `closureAndHandoff` côté OpenCode (même toast, même parité de contrat).
  *Depuis le lot #108, côté Claude Code, ce bilan n'est plus un nudge autonome mais une **ligne** de
  la carte de clôture unique (`epicBilanLine`) ; `epicBilanMessage` reste le nudge du canal OpenCode.*
  hitRate cache : `turnstats.computeTurn().hitRate` était déjà calculé mais jamais persisté —
  `recordOccupancy` le miroir maintenant dans `context-ledger.json` (`occupancy.hit_rate`, dernière
  valeur connue conservée si absente ce tour) ; `audit-context.js` (donc `/budget` sur les deux
  canaux, script partagé) l'affiche en pourcentage arrondi, une ligne en moins si jamais calculé
  (pas de chiffre fantôme). Non couvert : mirroring de l'occupation côté OpenCode (`recordOccupancy`
  n'y est jamais appelé, gap préexistant hors scope de ce lot) — `/pmz budget` y retombe sur le
  fallback « comptage de relectures » comme avant.

- **Carte de clôture** (lot #59, epic « Coût par livrable ») : contrairement à `lotCostMessage`
  (seuil ~300k) et `epicBilanMessage` (dernier lot d'une epic seulement), `lotClosureCardMessage`
  sort à **CHAQUE** auto-clôture de lot univoque — coût réel (`cost_tokens` déjà persisté, #43),
  durée (`started_at` → `closed_at`, même calcul que `epicBilan`, `null` silencieux si une date
  manque), relectures évitées (taille de `read-ledger.avoid_reread_notes` — fichiers que l'hygiène
  de lecture a empêché de relire). Glyphe INFO (grammaire #56), passe par l'arbitre de tour (#57).
  **Ordre de poussée délibéré** : dans les deux choke points (bloc auto-clôture de `hooks/stop.js`,
  `closureAndHandoff` OpenCode), la carte est poussée **après** le bilan d'epic — à sévérité INFO
  égale, l'arbitre départage à égalité par ordre d'origine (stable) ; le bilan (rare, 1×/epic) doit
  donc primer sur la carte (systématique, 1×/lot) quand les deux coïncident et que le plafond de 3
  force un arbitrage. Aucun recalcul depuis le transcript. *Cet ordre de poussée ne concerne plus que
  le canal OpenCode : côté Claude Code, la fusion du lot #108 (ci-dessous) a supprimé l'arbitrage.*

- **Carte de clôture UNIQUE + coda de prescription hors arbitre** (lot #108, epic « Reco de session
  fraîche »). Trois constats, un principe.
  1. **Prescription ≠ diagnostic.** L'arbitre de tour (#57) borne le **bruit de diagnostic** : des
     constats concurrents qui se disputent l'attention d'un même tour. Une **prescription** — l'action
     à prendre maintenant, unique et non rejouable — n'est pas du bruit et n'a rien à faire dans ce
     concours. `hooks/stop.js` émet donc la reco « nouvelle session » en **coda, APRÈS `arbitrate()`**,
     hors plafond : elle ne peut plus être évincée. Elle vivait jusqu'ici comme une ligne de
     `lotClosedMessage` (INFO) — donc perdue dès qu'une alerte du tour évinçait le message, or
     l'instant d'après-clôture (lot clos, handoff frais, plan persisté) est exactement celui où
     repartir coûte le moins et où la reco ne doit pas manquer. `freshSessionCodaMessage` est la seule
     sortie de ce type ; toute nouvelle prescription doit être justifiée sur le même critère, sinon le
     plafond ne veut plus rien dire.
  2. **Une clôture = une carte.** `closureCardMessage` fusionne en UN nudge (donc une place
     d'arbitre) ce qui sortait en trois : « lot clos + suivant » (#97), bilan d'epic (#58, ligne
     conditionnelle) et chiffres du lot (#59). Séparés, ils occupaient à eux seuls les 3 places
     disponibles et, au dernier lot d'une epic, ils étaient **4 candidats (avec la preuve #44) pour
     3 places** : la carte chiffrée, poussée en dernier, était systématiquement évincée — et la
     transition n'est pas rejouable (le lot est `done` au tour suivant). Fusionnés : tout ou rien.
  3. **Auto-clôture armée sur le backlog, plus sur un flag de session.** La branche d'auto-clôture
     exigeait `closure_reminded_for_batch` — un flag remis à zéro à **chaque session**. Un lot démarré
     dans une session et commité dans la suivante restait donc `in_progress` **indéfiniment** : ni
     clôture, ni carte, ni preuve, ni numéro de lot. L'armement lit désormais l'état du **backlog**
     lui-même : *exactement un `in_progress`* + *arbre propre (meaningful)* + *un commit tombé depuis
     le `started_at` du lot* (date de commit de HEAD, `git log -1 --format=%cI`). Aucune persistance
     nouvelle et robuste aux sessions fraîches, contrairement à un sha mémorisé dans l'état de session.
     Le flag reste un armement valide (chemin historique intact) ; la garde « commit depuis le
     démarrage » est ce qui empêche de clore un lot qui n'a rien livré. Deux replis assumés : lot sans
     `started_at` (legacy) → pas d'armement backlog ; résolution de `%cI` à la seconde → un lot démarré
     ET commité dans la même seconde n'est pas détecté (sans objet en pratique, un lot dure des
     minutes). Non porté côté OpenCode (`closureAndHandoff` garde le flag seul) : périmètre du lot.

- **Verdict chiffré de session fraîche dans `/close-batch`** (lot #109, epic « Reco de session
  fraîche »). La checklist de clôture (`scripts/close-batch.js`) disait « oui si le sujet
  change » — un jugement à l'œil, jamais vérifiable, contredit par l'étape 7 de `close-batch.md`
  qui recommandait une session fraîche inconditionnellement. Remplacé par `freshSessionVerdict` :
  booléen + raison chiffrée fondés sur le **palier d'occupation déjà persisté** par le hook Stop
  (`occupancy.stateFileFor(sessionId)`, un seul chiffre) — zéro relecture du transcript (`/close-batch`
  n'est de toute façon pas un hook, il n'a pas `transcript_path`). Seuil = `BUCKETS[1]` (300k) :
  repris tel quel du nudge subagent (`occupancy.evaluateSubagentNudge`, lot #52), pas inventé au
  jugé pour ce lot — même seuil déjà calibré et éprouvé en usage. La priorité « après clôture »
  (lot ouvert, modifs non commitées) reste inchangée et passe **avant** le verdict : tant que la
  clôture n'est pas faite, la question de la fraîcheur ne se pose pas. `close-batch.md` étape 7
  renvoie désormais explicitement à ce verdict au lieu de le contredire par une reco fixe.
