# Changelog

Toutes les évolutions notables de ce dépôt. Format inspiré de Keep a Changelog.

## 2026-07-11 (chore — /pmz/ ignoré)

`/pmz/` est un dépôt git imbriqué (checkout séparé, hors périmètre) qui traînait non suivi à la
racine et empêchait l'auto-clôture des lots au Stop (working tree jamais « propre »). Ajouté au
`.gitignore` sur confirmation de l'utilisateur.

## [0.5.15] — 2026-07-11 (suggestedTitle : ne pas attribuer un lot clos à la mauvaise session)

Suite du lot précédent : `lastDoneLot` décrit ce qui vient d'être fait, mais uniquement en se
fiant à la chronologie globale des lots — pas aux sessions elles-mêmes. Repéré concrètement en
renommant la session précédente de CE dépôt : la session la plus récente n'avait clos aucun lot
(un simple état des lieux) et aurait hérité, à tort, du titre du lot fermé par la session
d'AVANT. Objectif du projet : que le nom de session serve à retracer l'avancée réelle — un
lot mal attribué va à l'encontre de ça.

- **`lib/backlog.js`** : nouveau champ `closed_session_id` sur chaque lot, posé par `doneLot`
  (nouveau param `sessionId`, optionnel) ; `null` si clôture manuelle (CLI) sans id connu.
- **`lib/state.js`** : nouvelle fonction `previousSessionId` — lit le `session_id` BRUT persisté
  dans `session-state.json`, sans le reset que fait `loadSessionState`. Doit être lu AVANT que
  `session-start.js` n'écrase le fichier avec le `session_id` de la session courante.
- **`hooks/stop.js`** : passe le `sid` courant à `doneLot` lors de l'auto-clôture.
- **`hooks/session-start.js`** : réordonné — `suggestedTitle` (et donc `previousSessionId`) est
  calculé AVANT `saveSessionState`, pas après (sinon le `session_id` précédent est déjà perdu).
- **`lib/lot.js`** : `suggestedTitle` ne retient le dernier lot clos que si aucune preuve
  contraire n'existe — `closed_session_id` absent (clôture ancienne/manuelle, on l'affiche quand
  même) ou égal à `previousSessionId` (ça matche) ; s'il diffère, clôture avérée plus ancienne
  que la session précédente → on tait le suffixe plutôt que de mentir.
- **`ARCHITECTURE.md`** à jour. **Tests** : 4 assertions ajoutées (closed_session_id posé à
  l'auto-clôture, suffixe visible juste après clôture, suffixe tu après une session B sans
  activité de lot, retombée sur la forme nue). 325 OK.

## [0.5.14] — 2026-07-11 (fix — titre de session nu quand le plan est entièrement clos)

Retour utilisateur : le titre suggéré pour la session précédente ne montrait que « Epic — Lot N »,
sans rien qui décrive ce qui avait été fait — le but (suivre l'avancée des développements via le nom
de session) n'était pas atteint. Cause : `suggestedTitle` (`lib/lot.js`) ne suffixait le titre qu'à
partir du lot **en cours** ou **à faire** du backlog (`currentLot(b) || nextLot(b)`) ; juste après
la clôture du dernier lot d'un plan (aucun in_progress, aucun todo restant — le cas le plus courant
en fin de session), les deux sont `null` et le titre retombe nu.

- **`lib/backlog.js`** : nouvelle fonction `lastDoneLot(b)` — dernier lot clos (plus grand
  `lot_number`, sinon `closed_at` le plus récent).
- **`lib/lot.js`** : `suggestedTitle` suffixe désormais avec
  `currentLot(b) || lastDoneLot(b) || nextLot(b)` — décrit ce qui vient d'être fait plutôt que de
  retomber nu ou de pointer vers un lot pas encore commencé.
- **`ARCHITECTURE.md`** : documente le fallback et sa raison d'être.
- **Tests** : régression couverte (suffixe = dernier lot clos, pas le suivant à faire) + nouveau
  cas plan entièrement clos (aucun in_progress/todo) → titre suffixé au lieu de nu. 321 OK.

## [0.5.13] — 2026-07-11 (renommage de session : proposition à valeur ajoutée)

Le dialogue d'autorisation du renommage (`mcp__ccd_session_mgmt__set_session_title`) est un `ask`
**câblé côté serveur** par Claude Code Desktop : vérifié (guide Claude Code) qu'aucune config user
ne le supprime — ni `permissions.allow`, ni `bypassPermissions`, ni un hook PreToolUse « allow ».
Ce tool n'appartient pas à ce dépôt (`git grep` → 0 occurrence), PMZ ne fait que l'appeler.

Puisque l'autorisation est incontournable, on la transforme en **valeur ajoutée** plutôt que de la
subir : l'assistant annonce désormais le nom proposé **en clair dans sa réponse** (pas seulement
enfoui dans le JSON du dialogue) et invite explicitement l'utilisateur à l'accepter ou à en donner
un autre. Le clic « Autoriser » devient une simple validation de nom.

- **`lib/messages.js`** : `sessionTitleMessage` réécrit — proposition de nommage en clair +
  invitation à changer le nom + cadrage de l'autorisation comme validation (non contournable).
- **`ARCHITECTURE.md`** : documente le `ask` câblé côté serveur et le pourquoi du cadrage.
- Feedback remonté à Anthropic (`/feedback`) : permettre d'auto-approuver les tools de gestion de
  session.

## [0.5.12] — 2026-07-11 (fix — formulation du renommage de session)

`sessionTitleMessage` (`lib/messages.js`) disait littéralement « renomme **cette** session » —
or l'outil de renommage refuse explicitement la session active. L'assistant suivait la
consigne à la lettre, tentait, échouait, puis expliquait pourquoi au lieu d'agir directement.

- **`lib/messages.js`** : consigne réécrite pour cibler explicitement la session
  **précédente** ("jamais la session courante — l'outil la refuse"), sans détour ni
  justification a priori.

## [0.5.11] — 2026-07-11 (lot B6 — préconisation de modèle par lot)

Chaque lot du plan porte désormais une **préconisation de modèle** (`model_hint`, ex. `sonnet`
pour du mécanique, `opus` pour du raisonnement lourd), imposée au découpage et jamais perdue.

- **`lib/backlog.js`** : nouveau champ `model_hint` (capé `MAX_MODEL_HINT=40`, normalisé au
  chargement, valeur `null` pour les lots legacy pré-B6). `addLot(root, title, scope, modelHint)`.
  `summaryLines` réaffiche `[modèle : …]` sur le lot en cours **et** les suivants → le handoff
  auto (`lib/handoff.js`, qui consomme `summaryLines`) en hérite sans changement.
- **`scripts/backlog.js`** : `--model` **obligatoire** sur `add` (refus doux sans lui — la
  préconisation est imposée, pas optionnelle) ; `[modèle : …]` réaffiché dans `show`, `start`
  et `next`.
- **`commands/pmz-scope.md`** : l'étape de découpage impose une préconisation de modèle par lot,
  validée avec le découpage en une question, persistée via `--model`.
- **Tests** (`test/run-tests.js`, +12) : refus sans `--model`, persistance, réaffichage
  `show`/`start`/`next`/`summaryLines`, troncature au cap, lot legacy sans `model_hint` (chargé
  sans crash, affiché sans tag). Appels `add` existants mis à jour avec `--model`.

## [0.5.10] — 2026-07-11 (lot B5 — nudges haute occupation)

Deux nudges d'occupation contexte supplémentaires, complémentaires de l'alerte de fin de tour
(`stop.js`) : l'un **avant** le tour (coûte du contexte, donc rare et plafonné), l'autre **à la
reprise** d'une session (gratuit, jamais injecté).

- **`user-prompt-submit.js`** : si l'occupation ≥ 500k, injecte un `additionalContext` de
  2 lignes (`messages.occupancyPromptMessage`). Plafonné **1×/palier** via une clé `occ_<bucket>`
  dans `prompt_reminders` (même état que les rappels `broad`/`init_before_code` existants,
  indépendant du fichier d'état palier de `stop.js`/`occupancy.evaluate`).
- **`session-start.js`** : au `source=resume`, si l'occupation ≥ 300k, émet un `systemMessage`
  (réutilise `messages.occupancyMessage`) — **zéro token injecté**, jamais d'`additionalContext`.
  Comble le silence d'une session reprise déjà haute en contexte, qui restait muette jusqu'au
  premier `Stop`.
- **Tests** (`test/run-tests.js`, +8) : silence sous 500k, nudge 2 lignes au palier, anti-spam
  1×/palier même session, ré-escalade au palier suivant, silence resume sous 300k, `systemMessage`
  au resume ≥ 300k (jamais d'`additionalContext`), non-régression du `startup` normal.

## [0.5.9] — 2026-07-11 (lot B4 — advisory intra-tour sur relecture redondante)

`post-tool-use.js` peut désormais **signaler** (jamais bloquer) une relecture complète et
inutile, au moment même où elle se produit — plus besoin d'attendre `/check-context`.

- **Advisory intra-tour** (`lib/advisory.js`, nouveau) : sur un `Read` **complet** (`!partial`)
  d'un fichier **≥ 16 Ko**, déjà lu et **inchangé** (mtime identique — réutilise le signal
  `waste` de `ledger.recordRead`, désormais renvoyé à l'appelant) et **hors `files_modified`**,
  émet un `additionalContext` d'une ligne (~60 tokens) via la nouvelle sortie `postToolContext`
  (`lib/output.js`). Jamais de `permissionDecision` : purement informatif.
- **Plafonds** : 1×/fichier ET 3×/session, via un état **hors-projet**
  `<sha1(session_id)>-advisory` (même convention que `occupancy.js`/`turnstats.js`) — remis à
  zéro à chaque nouvelle session.
- **Opt-out** : `PMZ_NO_ADVISORY=1` coupe uniquement cette note (le reste de PMZ continue de
  tourner) ; ne consomme pas le plafond.
- **Tests** (`test/run-tests.js`, +12) : baseline sans advisory, relecture redondante avec
  advisory, plafond 1×/fichier, plafond 3×/session sur fichiers distincts, relecture partielle
  silencieuse, fichier sous le seuil de 16 Ko, fichier marqué modifié malgré mtime identique,
  opt-out (silence + plafond non consommé).

## [0.5.8] — 2026-07-11 (lot B3 — `/budget` et `/check-context` chiffrés en tokens)

Le statut d'économie de contexte de `/budget` et `/check-context` (via `audit-context.js`) n'est
plus dérivé du **nombre de relectures** mais de l'**occupation en tokens réels**.

- **Statut piloté par tokens réels** (`scripts/audit-context.js`) : vert/orange/rouge calculé à
  partir du miroir `context-ledger.json.occupancy.last` (posé par le hook `Stop`, métrologie B2)
  combiné au gaspillage de relecture (B1). Seuils **alignés sur les paliers d'`occupancy.js`**
  (orange à `BUCKETS[1]`=300k, rouge à `BUCKETS[2]`=500k — pas d'échelle inventée) ; un gaspillage
  ≥ un palier aggrave d'un cran. La ligne de statut affiche l'occupation réelle et le delta du
  dernier tour.
- **Fallback annoncé** : sans occupation token connue (projet jamais passé par un `Stop` récent,
  ou hors-git), retombe sur l'ancien comptage de relectures et **le dit explicitement**
  (« données tokens absentes ») — jamais de chiffre tokens fantôme.
- **Commands** `/budget` et `/check-context` : mises à jour pour reprendre le chiffre du script
  (elles délèguent, ne dupliquent pas la logique de statut).
- **Tests** (`test/run-tests.js`, +7) : les 3 statuts token (vert 100k / orange 350k / rouge 600k),
  l'affichage occupation + delta, et le cas fallback annoncé sans chiffre fantôme.

## [0.5.7] — 2026-07-10 (lot B2 — métrologie par tour + sécurisation du backlog dans l'ADN)

Deux volets, d'une même consigne. Le lot **B2** du plan (#8) livre la mesure fine du coût par
tour ; et la **sécurisation du backlog** est désormais un comportement par défaut du package (et
plus un correctif ponctuel de ce dépôt) — le plan de lots ne peut plus être perdu entre sessions.

- **B2 — métrologie par tour** (`lib/turnstats.js`, nouveau) : à chaque Stop, mémorise l'**offset
  en octets** du transcript + la dernière occupation dans `<sha1(sid)>-turns.json` (FIFO 40 tours) ;
  au Stop suivant, ne scanne QUE `[offset, EOF]` = exactement le tour écoulé. `computeTurn` en tire
  `delta` d'occupation, tokens de sortie, appels, ratio de cache et les **cache-busts** (`first:true`
  = pause/TTL au 1er appel, normal, 1×/session ; `first:false` = bust en plein tour, anormal).
  `stop.js` émet un `systemMessage` : tour coûteux (`delta ≥ 50k`, anti-spam 3 tours), bust intra,
  pause. Garde-fous : offset > taille → `baselineReset` (`delta=null`, zéro alerte parasite) ;
  `delta < -100k` (compaction) → `occupancy.resyncBucket` réarme le palier. Miroir compact
  `context-ledger.json.occupancy`.
- **Sécurisation du backlog par défaut** : le bootstrap pose un `.vibe-agent/.gitignore`
  **whitelist** (`*` puis `!.gitignore`, `!backlog.json`, `!rules.yaml`) — l'état éphémère (ledgers,
  handoff, session-state, snapshot) reste hors git, seul le plan durable est suivi ; `saveBacklog`
  **stage** le backlog à chaque écriture (survit à `git clean`, part au prochain commit dès sa
  création). `commitScaffold` ajoute désormais fichier par fichier (tolère les ledgers ignorés).
  Ce dépôt lui-même dogfoode l'ADN : `.vibe-agent/.gitignore` posé, ledgers/session-state
  dé-suivis (`git rm --cached`), `backlog.json` + `rules.yaml` conservés.
- **Tests** : 279 OK, 0 échec (+27 depuis 0.5.6). B2 : delta sur 2 Stops, anti-spam 3 tours,
  baselineReset, delta négatif → resync, busts `first` vs intra. Backlog-ADN : `.gitignore`
  whitelist, éphémère ignoré / durable suivi, staging auto, survie à `git clean -fd`, commit du
  socle malgré ledgers ignorés. Smoke test bout-en-bout de `stop.js` (tour coûteux → `systemMessage`).

## [0.5.6] — 2026-07-10 (sécurisation du backlog — lots B2 à B5 détaillés)

`.vibe-agent/backlog.json` n'était pas versionné dans ce dépôt : il avait disparu entre deux
sessions et les lots B2-B5 avaient dû être reconstruits à la volée depuis git (note sur #7).
Committer le fichier corrige ce trou — le plan ne dépend plus de la mémoire de l'assistant.

- **Backlog commité** : 7/11 faits (A0-A5, B1), 4 lots restants détaillés avec un critère
  « fait quand » complet (mécanisme, fichiers, seuils, tests attendus) — repris du plan
  approuvé : #8 B2 métrologie par tour, #9 B3 `/budget` chiffré, #10 B4 advisory intra-tour,
  #11 B5 nudges haute occupation. Aucun lot démarré : le choix du prochain lot revient à la
  session suivante.
- **Tests** : suite complète relancée (252 OK, 0 échec) — aucune régression, ce lot est
  purement administratif (backlog + changelog).

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
