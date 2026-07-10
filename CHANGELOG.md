# Changelog

Toutes les évolutions notables de ce dépôt. Format inspiré de Keep a Changelog.

## [0.5.5] — 2026-07-10 (lot B1 — coût par fichier + gaspillage réel)

Premier lot du chantier B « économie de tokens » : le stub mort `estimated_context_waste`
devient une mesure réelle du gaspillage de relecture.

- **Coût par fichier** : `post-tool-use.js` capture le `statSync` (octets + mtime) de chaque
  `Read` ; `recordRead` mémorise `bytes`/`mtime` par entrée et estime le coût ≈ `bytes / 4`
  tokens.
- **Gaspillage réel** : une relecture **complète** (`!partial`) d'un fichier **inchangé**
  (mtime identique à la dernière lecture) incrémente `estimated_context_waste` (total) et le
  nouveau `waste_by_file[path]` (ventilé). Une lecture partielle ou un fichier modifié
  entre-temps reste un coût justifié — non compté.
- **`/check-context`** (`audit-context.js`) : nouvelle section « Gaspillage estimé » —
  « ≈ Xk tokens sur N fichier(s) » + liste triée par coût décroissant ; « (aucun détecté) »
  sinon.
- **Nettoyage** : bloc `budget:` de `templates/rules.yaml` (documentaire, aucun parseur YAML
  ne le lit) débarrassé des seuils par tours morts — pointe désormais vers les vrais paliers
  tokens de `lib/occupancy.js`.
- **Tests** : section S (5 cas) — 1re lecture non comptée, 2 relectures inchangées = 2000,
  ventilation `waste_by_file`, relecture partielle non comptée, fichier modifié non compté,
  rendu audit trié + « aucun détecté ». `node test/run-tests.js` : 252 OK.

## [0.5.4] — 2026-07-10 (lot A5 — couche explicite du lotissement + docs)

Les points d'entrée explicites du plan de lots, par-dessus la couche passive (A1-A4).

- **`/pmz-scope`** (nouveau) : reformuler une grosse demande en 2-5 lots (titre + « fait
  quand »), validation en UNE question, persistance via `backlog.js add`/`start`, puis
  traiter uniquement le premier lot.
- **`MSG_LARGE` v2** (UserPromptSubmit, même anti-spam `broad`) : la consigne « découpe »
  devient actionnable (proposer 2-5 lots + les persister). Variante quand un plan existe
  déjà : « rattache la demande au lot en cours (x/y faits), sans élargir » — jamais de
  redécoupage par-dessus un plan vivant.
- **`/close-batch` avec plan** : `audit-batch.compute()` expose `backlog` (null-safe) ; la
  checklist gagne un bloc « Plan de lots » (conformité du périmètre → `note --id`, étape
  `done --id N` pré-remplie, lot suivant à reprendre dans le handoff). Sans plan : sortie
  historique inchangée. Filet : le hook Stop fait le `done` tout seul si l'assistant oublie.
- **Docs** : README (lotissement, `/pmz-scope`, note « réinstaller pour les matchers »),
  SKILL.md (§ 2bis Lotir une grosse demande), ARCHITECTURE déjà à jour (A3-A4).
- **Tests** : section R (5 assertions) + preuve de bout en bout du correctif A0 (handoff
  réinjecté au `source=clear`). 243 OK.

## [0.5.3] — 2026-07-10 (lot A4 — continuité : compaction et démarrages sans handoff)

Le plan de lots survit désormais aux deux points de perte restants : la **compaction** du
contexte et un démarrage **sans handoff**.

- **`hooks/pre-compact.js`** (nouveau, 6e hook, matcher `manual|auto`) : réécrit le handoff
  auto (qui porte plan de lots + todos depuis A3) juste AVANT que le transcript soit
  compacté. Aucune sortie ; ne touche jamais un handoff manuel non consommé. Même préambule
  fail-open que les autres hooks.
- **`session-start.js` — branche `compact`** : réinjection MINIMALE (≤ 300 chars) du lot en
  cours + reste à faire TodoWrite (in_progress + 2 pending). Ni MSG_ACTIF, ni handoff, ni
  titre — le contexte compacté n'a perdu que le plan, on ne réinjecte que le plan. Sans lot
  `in_progress` : rien.
- **`session-start.js` — filet sans handoff** : au startup/clear, si aucun handoff n'est
  injectable (premier démarrage, notes utilisateur), 2 lignes sur le plan de lots (lot en
  cours, ou prochain lot avec la commande `start --id N`), cap 400 chars.
- **`merge-settings.js`** : `PreCompact` enregistré → 6 hooks PMZ. Réinstallation requise.
- **Tests** : fail-open étendu au 6e hook, compteurs merge-settings à 6, section Q
  (11 assertions) — PreCompact écrit/préserve, compact minimal capé, compact sans lot ou
  hors git silencieux, fallback plan. 237 OK.

## [0.5.2] — 2026-07-10 (lot A3 — suivi passif du plan de lots)

Le suivi du lotissement devient **entièrement passif** : plus rien à penser, le plan avance
tout seul au rythme des commits et voyage dans le handoff.

- **Handoff auto enrichi** (`lib/handoff.js`) : deux blocs ajoutés — « Plan de lots : x/y
  faits + lot en cours + 3 suivants » (`summaryLines`) et « Tâches en cours (TodoWrite,
  dernier état) : l'in_progress puis 5 pending ». Blocs omis si artefacts absents ; cap
  d'injection 6 000 caractères inchangé.
- **Auto-clôture au Stop** (`stop.js`) : quand le working tree redevient propre (le point
  exact d'`incrementLot`), si le backlog a **exactement un** lot `in_progress`, il est marqué
  `done` (commit + `lot_number` fraîchement incrémenté) et un systemMessage annonce
  « Lot “X” clos (n/y). Suivant : “Z” — nouvelle session recommandée ». Cas ambigu (0 ou
  plusieurs in_progress) → aucune écriture, aucun message. **Pas de promotion automatique**
  du lot suivant (un `start` fantôme sur un plan périmé serait pire que rien).
- **Titre de session enrichi** (`lib/lot.js: suggestedTitle`) : « Epic — Lot N : <titre du
  lot backlog en cours> » (40c) quand un plan existe.
- Filet à double chemin : si l'assistant fait le `done` via close-batch d'abord, l'auto-
  clôture ne trouve plus d'in_progress et se tait (doneLot idempotent) — les deux chemins
  convergent.
- **Tests** : section P (11 assertions) — cycle complet dirty→commit→clos (1/3), message,
  pas de promotion, handoff enrichi et mis à jour, cas ambigu intact, titre suffixé. 223 OK.

## [0.5.1] — 2026-07-10 (lot A2 — capture passive TodoWrite)

La todo-list native de Claude Code — le seul artefact de découpage que le modèle produit
spontanément chaque session — n'est plus perdue à la fin de la session : elle est capturée
passivement dans `.vibe-agent/todo-snapshot.json`, sans aucune coopération requise.

- **`post-tool-use.js`** : branche `TodoWrite` (avant le guard `file_path` — l'outil n'en a
  pas) → `writeTodoSnapshot`. L'outil transmet la liste COMPLÈTE à chaque appel : un seul
  fichier, écrasé intégralement (même philosophie que le handoff auto).
- **`lib/backlog.js: writeTodoSnapshot/readTodoSnapshot`** : `activeForm` jeté, contenu
  tronqué à 120c, cap 30 items ; jamais effacé en début de session (dernier état connu,
  précieux après un crash) — remplacé au premier TodoWrite suivant.
- Sens unique TodoWrite→disque : le snapshot alimente le handoff (lot A3), il ne pilote
  jamais l'outil (pas de promotion automatique todo→lot : granularité tâche ≠ lot).
- **Tests** : section O (9 assertions) — capture, écrasement intégral, caps, malformé →
  exit 0, hors-git → rien, lecteur. 212 OK.

## [0.5.0] — 2026-07-10 (lot A1 — noyau backlog)

Le « lot » devient un **objet persistant** : `.vibe-agent/backlog.json`, un plan de 2 à
20 lots durables (id, titre, critère « fait quand », statut, commit de clôture) — trans-
session, distinct des todos volatils de Claude Code. Livrable volontairement **inerte** :
aucun hook câblé (le suivi passif arrive aux lots A2-A4).

- **`lib/backlog.js`** (nouveau) : module pur fail-silent — `loadBacklog` (normalisation
  défensive : fichier corrompu → backlog vide valide), `addLot`/`startLot`/`doneLot`/
  `dropLot`/`noteLot`, `currentLot`/`nextLot`/`progress`, `summaryLines` (bloc compact pour
  le futur handoff), `reconcile` (réparation bête : un seul `in_progress`, commit attaché aux
  `done` orphelins — jamais de matching sémantique).
- **Règles** : au plus un lot `in_progress` (start rétrograde les autres) ; `doneLot`
  idempotent, capture `lot_number` (compteur `(lot N)` du CHANGELOG) pour la traçabilité ;
  cap **20 lots ouverts** (refus doux : un backlog n'est pas un Jira) ; troncatures titre
  80c / scope 400c / note 200c ; écriture atomique `fsjson`, ledger auto-créé.
- **`scripts/backlog.js`** (nouveau) : CLI zéro-dépendance —
  `show|add|start|done|drop|note|next|reconcile` (+`--json`), sortie française lisible,
  toujours exit 0. `lot-counter.json`/`epic` inchangés (numérotation chronologique
  découplée, aucune migration).
- **Tests** : section N (20 assertions) — CRUD, unicité in_progress, idempotence,
  troncatures, cap, corruption, reconcile, hors-git. 203 OK.

## [0.4.8] — 2026-07-10 (lot A0 — correctifs socle)

Correctifs préparatoires au chantier « lotissement + économie de tokens » (plan approuvé) :
trois incohérences dormantes corrigées avant de bâtir dessus.

- **Matcher SessionStart `startup|resume|clear|compact`** (était `startup|resume`) : le hook
  gérait `clear` depuis toujours mais n'était jamais déclenché dessus — **le handoff n'était
  jamais réinjecté après `/clear`**, précisément le geste que PMZ recommande pour repartir au
  plancher. `compact` est ajouté au matcher (passThrough aujourd'hui, branche de réinjection
  post-compaction prévue au lot A4).
- **Matcher PostToolUse `Read|Edit|Write|TodoWrite`** : TodoWrite observé (no-op pour
  l'instant ; la capture passive des todos arrive au lot A2).
- **`audit-batch.js` aligné sur `stop.js`** (`gitStatusMeaningful`) : quand seuls des fichiers
  `.vibe-agent/` étaient sales, `/close-batch` disait « clôture nécessaire » alors que
  `stop.js` considérait le lot fermé. Une seule définition de « lot ouvert » désormais.
- **Champs morts supprimés** de `lib/state.js` et `templates/session-state.json`
  (`current_batch`, `batch_status`, `verification_status` — jamais écrits par aucun code ;
  l'état de lot vivra dans `backlog.json` à l'échelle projet, pas dans l'état de session).
- **Réinstallation requise** pour activer les nouveaux matchers (`install.command`).
- **Tests** : matchers vérifiés après install, régression audit-batch (`.vibe-agent/` seul
  sale → clôturable), absence des champs morts. 183 OK.

## [0.4.7] — 2026-07-10

Init des projets **en cours** : `/pmz-init` ne produisait rien de visible sur un projet qui
avait déjà son `CLAUDE.md`/`AGENTS.md` (`copyIfAbsent` sautait tout) — les règles PMZ
n'entraient jamais dans les fichiers existants.

- **`bootstrap-project.js --augment`** (+ `lib/bootstrap.js: augmentExisting`) : ajoute en fin
  des `CLAUDE.md`/`AGENTS.md` existants la section « Règles Promptimizer » taguée
  (`templates/pmz-rules.md`, bloc `pmz:rules:start/end`) — append-only, idempotent,
  réversible en supprimant le bloc. Même philosophie que `merge-settings`.
- **Templates `CLAUDE.md`/`AGENTS.md`** : portent désormais le même marqueur autour de leurs
  règles — un fichier issu du scaffold n'est jamais ré-augmenté (pas de doublon).
- **Réservé au flux explicite** : seul `/pmz-init` (après confirmation) augmente ; les hooks
  (auto-scaffold projet neuf) ne modifient jamais un fichier existant, comme avant.
- **`/pmz-init` et `SKILL.md`** réécrits pour couvrir le cas « projet en cours » (sortie
  `created` / `augmented` / `skipped`).
- **Tests** : section L (10 assertions) — augmentation avec préservation du contenu original,
  idempotence, comportement historique sans `--augment` intact, auto-scaffold hook inchangé.
  175 OK.

## [0.4.6] — 2026-07-10

Handoff de session automatisé : plus besoin de copier-coller le handoff dans la nouvelle
session — il vit dans UN fichier `.vibe-agent/handoff.md`, écrasé à chaque tour (pas de
bloat), et il est injecté automatiquement au démarrage de la session suivante.

- **`lib/handoff.js` (nouveau)** : handoff **auto** (mécanique — epic/lot, branche, dernier
  commit, working tree, fichiers récemment lus à ne pas relire) écrit par `stop.js` à CHAQUE
  fin de tour ; handoff **manuel** (riche) écrit par l'assistant via `/fresh-session` ou
  `/close-batch`, distingué par le marqueur `<!-- pmz:handoff:manual -->` et jamais écrasé
  par l'auto tant qu'il n'a pas été consommé. Un fichier sans marqueur PMZ (notes
  utilisateur) n'est ni écrasé ni injecté.
- **`session-start.js`** : injecte le handoff au démarrage (`startup`/`clear` uniquement,
  cap 6 000 caractères) puis le marque consommé (manuel → auto, l'auto reprend la main).
- **`lib/project.js: gitStatusMeaningful`** : la détection de « lot ouvert » de `stop.js`
  ignore désormais le churn `.vibe-agent/` (ledgers + handoff réécrits à chaque tour), qui
  rendait le working tree perpétuellement sale et bloquait la clôture de lot.
- **`/fresh-session` et `/close-batch`** : écrivent le handoff riche dans
  `.vibe-agent/handoff.md` (écrasement) au lieu de seulement l'afficher ; templates
  (`handoff-template.md`, `CLAUDE.md`, `AGENTS.md` — équivalent Codex : lire le handoff en
  première action) et `SKILL.md` alignés.
- **Tests** : section K (16 assertions) — écrasement sans cumul, préservation du manuel,
  injection SessionStart, consommation, non-réinjection au resume, fichier utilisateur
  intouché, clôture de lot malgré `.vibe-agent/` non commité. 165 OK.

## [0.4.5] — 2026-07-10

Six optimisations issues de l'audit d'usage tokens sur assistHealth (rapport + dashboard) :
la couche ledger/clôture restait inerte sans `/pmz-init` explicite, et les skills PMZ étaient
quasi jamais invoqués malgré des rappels vagues.

- **Ledger auto-créé sans confirmation** (`lib/project.js: ensureLedger`) : `.vibe-agent/`
  se crée dès qu'un repo git existe, branché dans `post-tool-use.js` et `stop.js`. Le socle
  **visible** (CLAUDE.md/AGENTS.md/CHANGELOG.md) reste derrière confirmation sur un projet
  mature (`isFullyInitialized`).
- **Rappels qui nomment la commande exacte** : `occupancyMessage()` et `MSG_CLOTURE`
  pointent vers `/close-batch`/`/fresh-session` au lieu d'une prose générique.
- **Palier d'alerte flottant** (`lib/occupancy.js: FLOATING_STEP`) : au-delà du dernier palier
  fixe (750k), une alerte continue de se déclencher tous les +250k au lieu de se taire pour
  le reste d'une session marathon.
- **Hygiène de lecture** (`lib/occupancy.js: scanTailForReadMix/evaluateReadMix`) : le hook
  Stop signale, une fois par session et sans dépendre du ledger, une majorité de `Read`
  complets (sans offset/limit) face aux recherches (`Grep`/`git grep`).
- **Nommage automatique de session** (`lib/lot.js`, nouveau) : compteur de lot par projet
  (`.vibe-agent/lot-counter.json`, amorcé depuis les `(lot N)` déjà présents dans
  `CHANGELOG.md`), epic configurable via `.vibe-agent/epic` (sinon nom du dossier).
  `session-start.js` suggère « Epic — Lot N » et demande à l'assistant de tenter le
  renommage réel puis d'accuser explicitement le résultat.
- **Auto-scaffold d'un projet neuf** (`lib/bootstrap.js`, nouveau — logique extraite de
  `scripts/bootstrap-project.js`) : sur un repo git à 0 commit, ou même sans `.git` du tout
  (PMZ fait alors `git init` lui-même) sur un prompt de démarrage, le socle est posé et
  commité automatiquement. Un projet mature continue de nécessiter `/pmz-init` explicite.
- **Vérifié** : `node test/run-tests.js` vert (149 assertions) ; parcours manuel en bac à
  sable pour les 6 points (textes de rappel réels, fichiers créés, commits) ; `ARCHITECTURE.md`
  mis à jour (invariant §3 reformulé, flux de données, décisions).

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
