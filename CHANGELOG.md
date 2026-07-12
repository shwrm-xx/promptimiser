# Changelog

Toutes les évolutions notables de ce dépôt. Format inspiré de Keep a Changelog.

## 2026-07-13 (v1.1.1 — fiabilité du renommage : validation immédiate + redéploiement)

Retour direct : renommage « pas fiable au global » — démarre une fois sur deux, tantôt en début
tantôt en fin de tour, pas de dialogue de validation, nomenclature et numérotation non
respectées. **Cause racine n°1 : dérive de déploiement** — le plugin installé était figé en
**1.0.0** (cache `~/.claude/plugins/cache/`, commit `5085625`), donc SANS le rappel doublé du
1er prompt (lot #40) ni la nomenclature v1.1.0 (`#N` = ID du plan). Committer la source ne
change rien aux sessions tant que le cache n'est pas mis à jour. Cause n°2 : le protocole ne
mandatait pas de dialogue de validation immédiat.

- `promptimizer/lib/messages.js: sessionTitleMessage` : le protocole exige désormais, **tout
  début du 1er tour et AVANT la demande utilisateur**, le titre en clair + une **question à
  choix IMMÉDIATE** (valider / autre nom / non) — jamais en fin de tour ; renommage de la
  session PRÉCÉDENTE sur accord, accusé de résultat explicite (inchangés). ≤ 400 o conservé.
- `test/run-tests.js` : 4 assertions du nouveau protocole (dialogue immédiat, avant la demande,
  jamais en fin de tour) — **517 OK, 0 échec**.
- `ARCHITECTURE.md` : protocole de renommage mis à jour + encart « Dérive silencieuse
  source ↔ installé » (canal plugin) : tout lot touchant `hooks/`/`lib/` doit finir par
  bump `VERSION` → rebuild `build-plugin.js` → `claude plugin update pmz@pmz-local` + restart.
- `promptimizer/VERSION` + `.claude-plugin/plugin.json` : 1.1.0 → **1.1.1** ; plugin rebuilé
  (`dist/marketplace`) et **déployé** (cache 1.0.0 → 1.1.1, redémarrage requis pour appliquer).

## 2026-07-12 (v1.1.0 — nomenclature de titre de session : nom de plan + #lot + résumé)

Retour direct : depuis le passage en plugin, le renommage de session était « inférieur à
avant » — pas de numéro de lot, format instable d'une session à l'autre. Nouvelle nomenclature
**validée utilisateur** : `[XXX] PlanTitle #N · résumé`, et `[XXX] Session Libre · résumé` quand
aucun plan ne nomme le lot. Le renommage de la session **précédente** reste la priorité du 1er
tour (mémoire `feedback-session-rename-priority`), inchangé côté déclenchement.

- `promptimizer/lib/lot.js: suggestedTitle` / `titleForLot` : format refondu.
  - `#N` = **ID backlog** du lot retenu (le `#N` visible dans `backlog.js show`).
  - `PlanTitle` = nom de plan **≤ 3 mots** = l'`epic` du lot (le « voyageur » qui reste juste
    selon le lot travaillé, décision utilisateur), coupé au 1er séparateur `— / – / :` d'un
    libellé long puis borné à 3 mots (`planName`). Absent → repli `Session Libre` (sans `#N`).
  - `résumé` = focus du lot, préfixe de numérotation métier redondant retiré (`stripLotPrefix`,
    ex. « Lot E1 — Namespace » → « Namespace », la numérotation canonique étant `#N`).
  - Le repli déduction (backlog absent/vide) devient `[XXX] Session Libre · <résumé déduit>`
    (CHANGELOG/commit) au lieu d'un `Lot N` nu ; troncature du résumé portée à 50 c.
- `skills/promptimizer/SKILL.md` : au découpage, proposer un nom de plan court (≤ 3 mots, validé)
  et le poser sur chaque lot via `--epic` — c'est lui qui nomme le plan dans le titre.
- `ARCHITECTURE.md` : contrat du format mis à jour (nomenclature + Session Libre).
- `promptimizer/VERSION` + `.claude-plugin/plugin.json` : 1.0.0 → 1.1.0 (canaux alignés).
- Tests : section (partie N) et blocs `suggestedTitle` alignés sur le nouveau format ; nouveaux
  cas — nomenclature complète `[XXX] <epic> #N · <focus sans préfixe>`, troncature du nom de plan
  à 3 mots, `Session Libre` sans epic. 514 OK, 0 régression (`node test/run-tests.js`).
- Choix signalé (interprétation minimale) : le suffixe `(partie N)` d'un lot multi-session est
  **conservé** en fin de titre (non demandé retiré, additif au format) ; le champ `epic` long
  historique n'est **pas** réécrit en base (la troncature d'affichage à 3 mots suffit).

## 2026-07-12 (Lot #40 — fiabilité du renommage de session, rappel doublé au 1er prompt)

Retour direct : le renommage de session proposé par `session-start.js` n'était « plus
systématique », sur plusieurs projets. Diagnostic : le mécanisme lui-même fonctionne
(vérifié : `session_id` correctement mis à jour par projet, message bien injecté) — le vrai
point de fragilité est **structurel** : la suggestion n'apparaît qu'**une seule fois**, dans le
contexte additionnel de `SessionStart`, noyée au milieu d'autres rappels (handoff, plan de
lots…) et injectée AVANT le premier tour — rien ne la ramène si elle n'est pas traitée tout de
suite, contrairement aux autres nudges PMZ (occupation, init, lot trop large) qui remontent
aussi sur le premier `UserPromptSubmit`.

- `promptimizer/lib/state.js` : nouveau champ persisté `pending_title_rename` (titre calculé
  par `session-start.js`, remis à zéro à chaque nouvelle session comme le reste de l'état).
- `promptimizer/hooks/session-start.js` : persiste le titre calculé (`suggestedTitle(root)`)
  dans l'état de session en plus de l'injecter, sans changement de comportement au
  `SessionStart` lui-même.
- `promptimizer/hooks/user-prompt-submit.js` : réaffiche ce titre (déjà calculé, **jamais
  recalculé** — un second appel à `suggestedTitle` fausserait le compteur « (partie N) » de
  `touchLot`) au **premier** prompt de la session, si pas déjà vu là (anti-spam 1×/session,
  même mécanique que les autres rappels `prompt_reminders`).
- Tests : nouvelle section « rappel doublé » (session-start → titre injecté ; 1er prompt →
  titre réaffiché à l'identique ; 2e prompt → silence ; pas de « (partie 2) » parasite). 513 OK
  (+5), 0 régression.
- Non couvert par ce lot (hors du périmètre code) : le fait d'agir sur l'instruction reste
  entièrement à la charge de l'agent — un hook ne peut pas appeler l'outil de renommage
  lui-même (cf. mémoire `feedback-session-rename-priority`). Ce lot double la visibilité, il ne
  rend pas le renommage automatique.

## 2026-07-12 (Lot #37 — script de publication vers `plugin-release`, epic diffusion GitHub publique)

Premier lot de l'epic « Diffusion pmz — marketplace GitHub publique » : rendre le plugin
installable par n'importe qui via `claude plugin marketplace add <owner>/<repo>@<branche>`,
sans dépendre d'un partage manuel de dossier (canal déjà couvert par le lot D4).

- `promptimizer/install/publish-plugin.js` (nouveau) : construit l'artefact plugin (réutilise
  `build-plugin.js`), puis le publie sur une branche dédiée **`plugin-release`** via un **commit
  orphelin** — aucun historique hérité de `main`, régénéré intégralement à chaque publication.
  `main` reste le miroir plat source, intact ; la publication se fait dans un `git worktree`
  détaché pour ne jamais perturber le checkout courant. Renomme la marketplace générée
  (`pmz-local` → `pmz-marketplace`, nom non réservé) pour distinguer l'usage public du sandbox
  local de `build-plugin.js`. Purge la branche locale existante avant régénération (idempotent).
  Garde-fou : refuse de publier sur un working tree non propre. Ne pousse vers le remote que si
  `--push` est explicitement passé (jamais de push automatique) ; sans ce flag, affiche la
  commande à lancer manuellement.
- Vérifié en bac à sable (clone temporaire, jamais le vrai remote) : contenu de branche correct
  (`install/` exclu, `skills/` inclus, chemins réécrits en `${CLAUDE_PLUGIN_ROOT}`), un seul
  commit à chaque régénération, aucun worktree résiduel, `main` inchangé après coup. Prérequis
  côté utilisateur (hors du périmètre de ce lot, changement de visibilité GitHub) : basculer le
  dépôt en **public** — sinon la marketplace `github` reste inaccessible aux tiers.
- Tests : 508 OK, aucune régression.
- Reste à faire (lots #38/#39 du même epic) : documenter le canal dans README/ARCHITECTURE, et
  vérifier bout-en-bout `marketplace add` + `install` depuis la branche publiée.

## 2026-07-12 (Lot E3 — doctor conscient du canal plugin, plus de faux « rouge »)

Retour direct : après la migration vers le plugin (epic D-E), le `pmz-doctor` affichait
« rouge » sur une installation pourtant saine, ruinant la confiance dans le fait que le plugin
était bien installé et actif. Cause : `doctor.js` est l'outil historique du **canal manuel** —
il exige des hooks PMZ câblés dans `settings.json`. En canal **plugin**, hooks/skill/commandes
sont fournis PAR le plugin (jamais dans `settings.json`) ; le doctor concluait donc « rouge » à
tort. Diagnostic complet effectué sur le poste (plugin installé, 6 hooks, 7 commandes, hook
`session-start` exécuté à blanc → produit bien l'instruction de renommage) : **rien de
mécanique n'était cassé**.

- `promptimizer/install/doctor.js` : détection du canal plugin par signaux **indépendants de la
  commande `claude`** (absente du PATH GUI macOS) — `CLAUDE_PLUGIN_ROOT`, `enabledPlugins` de
  `settings.json`, et `plugins/installed_plugins.json` (chemin d'install). En canal plugin sain,
  le statut est **vert** sans exiger le câblage manuel ; nouvelle ligne `Canal : plugin | manuel
  | plugin + manuel (CONFLIT)` et « Hooks / skill / commandes : fournis par le plugin ». Le
  dry-run du hook et la détection de projet s'exercent sur le code du plugin quand le canal
  manuel a été nettoyé. Détection de double installation simplifiée (plus de `claude plugin
  list` best-effort) : `hooks legacy présents ET plugin actif`.
- Nettoyage du poste (hors dépôt) : suppression de l'install manuelle legacy résiduelle
  (`~/.claude/promptimizer/` — code seulement, `state/` conservé), backup préalable. Le plugin
  reste l'unique canal actif.
- Renommage de session prouvé de bout en bout (outil MCP `set_session_title`) — le mécanisme
  n'était pas cassé : le hook ne peut qu'**injecter** l'instruction, c'est l'assistant qui
  l'exécute (identique en canal manuel).
- Tests : 508 OK (+4 assertions « doctor plugin seul → vert »).
- Fix trigramme de ce dépôt : dérivé par défaut à `PRO` (3 lettres de « promptimiser »),
  fixé à `[PMZ]` (`backlog.js trigram --set PMZ`) pour matcher le nom du produit.
  `.vibe-agent/trigram` était ignoré par `.vibe-agent/.gitignore` (règle `*` sans exception) :
  un trigramme choisi à la main se serait perdu au prochain clone/session fraîche, comme le
  backlog avant son ajout aux exceptions. Ajouté aux exceptions durables.
- Non fait (signalé) : sous le plugin, aucun doctor CLI n'est livré (exclu du build) — la santé
  se lit via `claude plugin details pmz` ou le doctor du dépôt. Un `/pmz:doctor` serait un lot
  distinct. `suggestedTitle` retombe sur le dernier lot clos après un commit `chore` hors
  backlog (titre « Lot E2 » proposé pour une session de nettoyage) — imperfection secondaire, à
  traiter séparément.

## 2026-07-12 (Lot E2 — Titres de session : trigramme + focus du lot + langue)

**Lot #35**. Refonte du format de titre de session suggéré, suite à un retour direct sur trois
problèmes observés en usage réel : répétition du nom complet du projet, double numérotation de
lot (« Lot 32 : Lot D3 — … »), mélange de langue. Ancien format `${epic} — Lot ${id} :
${titre}` → nouveau format `[XXX] ${titre du lot}` (+ `(partie N)` si le lot dépasse une
session).

- `promptimizer/lib/trigram.js` (nouveau) : trigramme de projet (`.vibe-agent/trigram`), dérivé
  par défaut (3 premières lettres alpha du nom de dossier), modifiable via `backlog.js trigram
  --set XXX` ; `suggestTrigrams` propose 3 alternatives pour `/pmz-init` sur un nouveau projet.
- `promptimizer/lib/lot.js` : `titleForLot` remplace `titleForBacklogLot` — le focus du lot
  backlog prime (plus d'ID concurrent, plus d'epic dans le titre), préfixé du trigramme.
- `promptimizer/lib/backlog.js` : nouveau champ `session_touches` + `touchLot` — compte les
  sessions successives qui laissent un même lot `in_progress`, remis à zéro par `startLot`.
  Suffixe `(partie N)` si N>1 ; jamais sur un lot déjà clos (le travail est fini).
- `promptimizer/scripts/backlog.js` : commande `trigram --suggest` / `--set` / (lecture).
- `promptimizer/commands/pmz-init.md` : propose le trigramme (3 choix + saisie libre) seulement
  quand le socle vient d'être **créé** (nouveau projet) — un projet déjà initialisé garde sa
  dérivation automatique, sans interruption.
- Vérifié en bac à sable réel (hooks exécutés en sous-processus, pas seulement les tests
  unitaires) : trigramme dérivé, focus du lot sans double numérotation, et `(partie 2)`/
  `(partie 3)` sur des démarrages de session successifs pendant qu'un lot reste ouvert.
- Tests : 504 OK (+18 nouvelles assertions trigramme/partie, existantes adaptées au nouveau
  format).

## 2026-07-12 (Lot E1 — Namespace plugin pmz)

**Lot #34**. Le plugin Claude Code s'identifie désormais `pmz` (au lieu de `promptimizer`) :
le namespace des commandes est piloté directement par `plugin.json` `name` (constat du spike
D1) — `/pmz:about`, `/pmz:scope`, etc., aligné sur les commandes déjà nommées `/pmz-*` du canal
manuel. L'identité « Promptimizer » reste le nom du projet (description, README, branding).

- `promptimizer/.claude-plugin/plugin.json` : `name: "pmz"`.
- `promptimizer/install/build-plugin.js` : `marketplace.json` référence `pmz`, logs d'exemple
  mis à jour (`claude plugin install pmz@pmz-local`).
- `promptimizer/install/doctor.js` : détection de double installation cherche `pmz` (au lieu de
  `promptimizer`) dans la sortie de `claude plugin list`.
- `promptimizer/install/migrate-to-plugin.js` + nouveau `migrate-to-plugin-all.js` (enchaîne
  build + migration + install en une commande) : commandes affichées mises à jour.
- README/ARCHITECTURE : doc de namespace/installation à jour.
- Tests : nouvelle assertion `plugin.json name=pmz` + `marketplace.json plugins[0].name=pmz` ;
  486 OK.

## 2026-07-12 (Lot D4 — Diffusion tiers + doc distribution)

**Lot #33 (dernier de l'epic D)**. Diffusion générique à un tiers (entreprise, équipe,
communauté) documentée — plus de particularisation à une organisation donnée.

- `README.md` : section distribution reformulée en générique + exemple `settings.json`
  (`extraKnownMarketplaces`) pour référencer une marketplace privée sans `marketplace add`
  manuel par poste.
- `ARCHITECTURE.md` : nouvelle section « Diffusion tiers (lot D4) » ; mention MH généralisée
  dans la section décisions ; GitHub public confirmé comme objectif lointain.
- `.vibe-agent/backlog.json` : lot #33 renommé « Diffusion tiers + doc distribution ».
- **Non vérifié** : test Windows réel — aucune machine Windows disponible dans cet
  environnement d'exécution ; limite documentée dans ARCHITECTURE.md, revue par lecture de code
  uniquement (`install.ps1`, `claude-dir.js`, `bin/pmz-hook`).
- Epic D (packaging plugin Claude Code) clos : 33/33 lots faits.

## 2026-07-12 (Lot D3 — Migration legacy + semver)

**Lot #32**. `VERSION` passe en **semver** (`x.y.z`), aligné sur `.claude-plugin/plugin.json` —
les deux canaux (manuel/plugin) partagent désormais le même numéro. Outil de migration du canal
manuel vers le plugin, et détection de double installation par `doctor.js`.

- `promptimizer/lib/version.js` : `compareSemver`/`parseSemver` en plus de `readVersion`/
  `bumpVersion` (bump = patch par défaut, `major`/`minor` en paramètre). Format legacy (entier,
  ex. `"3"`) non comparable → `null`, traité comme première installation, jamais un crash.
- `promptimizer/install/install.js` : comparaison de version via `compareSemver` (remplace le
  `parseInt` d'entier) ; messages inchangés (« première installation », « mise à jour vX → vY »…).
- `promptimizer/install/build-plugin.js` : synchronisation du manifeste simplifiée
  (`manifest.version = readVersion()` direct, plus de conversion entier → `x.0.0`).
- `promptimizer/install/migrate-to-plugin.js` (nouveau) : retire les hooks PMZ legacy de
  `settings.json` (réutilise `merge-settings.js --remove`, qui restaure aussi un éventuel sidecar
  de prise de relais `context-guard.py`), puis affiche les commandes d'install du plugin.
  `--purge` supprime aussi les fichiers PMZ legacy (conservés par défaut).
- `promptimizer/install/doctor.js` : **détection de double installation** (plugin + canal manuel
  jamais retiré) par deux voies indépendantes — doctor tournant sous `CLAUDE_PLUGIN_ROOT` avec
  des hooks legacy encore câblés dans `settings.json` ; ou doctor en canal manuel avec
  `claude plugin list` (best-effort) rapportant `promptimizer` déjà installé. Statut `orange` +
  rappel de `migrate-to-plugin.js`. Bug latent corrigé au passage : `merge-settings.js` était
  localisé via `pmzDir()` (qui bascule sur `CLAUDE_PLUGIN_ROOT`), donc introuvable dans le
  scénario justement visé — localisé désormais via `__dirname` (sibling direct, toujours dans le
  canal manuel puisque `doctor.js` est exclu du plugin).
- `test/run-tests.js` : nouvelles sections semver/migration/double-install. 485 OK.
- Doc : `README.md` (canal manuel marqué **legacy, gelé** ; migration documentée),
  `ARCHITECTURE.md` (section « Migration manuel → plugin + versioning semver »).

## 2026-07-12 (Lot D2 — Packaging plugin Claude Code)

**Lot #31**. Promptimizer est désormais packageable en **plugin Claude Code natif**, en plus du
canal d'install manuelle (conservé). Le format plugin impose `commands/`, `skills/`,
`hooks/hooks.json` à la racine du plugin, sans chemin personnalisable : plutôt que de casser le
miroir plat source, un assembleur en **dérive** un dossier plugin self-contained (zéro
duplication committée). Validé en bac à sable (CLI desktop v2.1.205, vrai `~/.claude` non touché) :
`validate` OK, install effective, `plugin details` → **6 hooks + 7 commandes + skill**, hooks
réellement déclenchés via le wrapper.

- `promptimizer/lib/claude-dir.js` : **découplage `pmzDir()` / `stateDir()`**. `pmzDir()` renvoie
  `CLAUDE_PLUGIN_ROOT` en mode plugin (sinon `~/.claude/promptimizer`) ; `stateDir()` vise
  `CLAUDE_PLUGIN_DATA/state` (état **persistant** survivant aux updates), découplé de `pmzDir()`
  pour ne jamais être effacé à chaque update. Repli install manuelle inchangé (0 régression).
- `promptimizer/.claude-plugin/plugin.json` : manifeste du plugin (name, version, description).
- `promptimizer/hooks/hooks.json` : câblage statique des 6 hooks (remplace l'écriture dans
  `settings.json` de `merge-settings.js`). Mêmes matchers/timeouts. Commande =
  `sh "${CLAUDE_PLUGIN_ROOT}/bin/pmz-hook" "${CLAUDE_PLUGIN_ROOT}/hooks/x.js"`.
- `promptimizer/bin/pmz-hook` : wrapper fail-open qui **résout `node` au runtime** (remplace le
  `resolveNodeBin()` de `merge-settings.js`, inutilisable en plugin distribué). Invoqué via `sh`
  (le bit +x n'est pas préservé en `.zip`). `node` introuvable → exit 0 silencieux.
- `promptimizer/install/build-plugin.js` : **assembleur** `dist/marketplace/` (gitignoré) au
  layout conventionnel (install/ exclu, skill replacée, chemins `~/.claude/promptimizer` réécrits
  en `${CLAUDE_PLUGIN_ROOT}` dans commands + skill, version alignée sur `VERSION`, marketplace
  locale à source relative).
- `promptimizer/scripts/backlog.js` + `close-batch.js` : les chemins d'aide affichés passent par
  `CLAUDE_PLUGIN_ROOT` (sinon `~/.claude/promptimizer`) — corrects dans les deux canaux.
- `test/run-tests.js` : +14 assertions (découplage claude-dir mode plugin ; layout et réécriture
  de l'assembleur). 458 OK.
- Doc : `ARCHITECTURE.md` (canal plugin + assemblage), `README.md`, `CLAUDE.md` (deux canaux).
- Diagnostic en mode plugin = `claude plugin details promptimizer` (le `doctor.js` bespoke reste
  l'outil du canal manuel). Limite connue reportée en D3 : chemins d'aide des scripts corrects
  seulement si `CLAUDE_PLUGIN_ROOT` est exporté au shell du modèle.

## 2026-07-12 (Lot D1 — Spike plugin Claude Code : verdict go/no-go)

**Lot #30** (spike, session jetable, zéro code de portage mergé). Évaluation de faisabilité du
packaging de Promptimizer en plugin Claude Code natif, validée en bac à sable sur machine réelle
(CLI desktop v2.1.205, vrai `~/.claude` non touché).

- `docs/decisions/D1-plugin-go-nogo.md` : verdict **GO — staged** + preuves. Validé sur machine
  réelle : `plugin.json`/`hooks.json`/marketplace locale passent `validate` ; install effective ;
  **hook SessionStart réellement déclenché** en session sandbox ; `require('../lib/…')` résout.
- Corrections vérifiées vs doc : `CLAUDE_PLUGIN_ROOT` **et** `CLAUDE_PLUGIN_DATA` exposés en
  `process.env` au runtime (le second = état persistant survivant aux updates) ; source de
  marketplace locale = **string relative**, pas un objet ; plugin local exécuté in-place depuis
  la source ; `commands/*.md` assimilés à des skills et namespacés `/promptimizer:*`.
- Régression unique assumée : la prise de relais réversible d'un hook Stop tiers
  (`context-guard.py`) est impossible en plugin (pas de modif du `settings.json` global). Niche.
- Faisabilité MH : distribution interne via marketplace locale / git interne (zéro-réseau) ;
  éviter les sources `github`/`npm` publiques derrière proxy.
- `ARCHITECTURE.md` : pointeur vers le verdict depuis la section « Décisions & pourquoi ».

## 2026-07-12 (Lot P2 — Preuve de clôture verify + closed_occupancy)

**Lot #29**. Un lot backlog peut désormais porter une commande de preuve de clôture, et la
métrologie de coût par lot capture l'occupation contexte au moment où il se ferme.

- `promptimizer/lib/backlog.js` : nouveau champ optionnel `verify` sur le lot (cap 150c,
  `MAX_VERIFY`), normalisé au chargement, tronqué à l'ajout/édition ; nouvelle fonction
  `setVerify(root, id, verify)` pour poser la commande après coup. Nouveau champ
  `closed_occupancy` (occupation contexte à la clôture), posé par `doneLot(..., occupancy)`.
- `promptimizer/scripts/backlog.js` : `add --verify "…"` persiste le champ à la création ;
  nouvelle commande `verify --id N --set "…"` (édite) / `verify --id N` (lit) ; `show` réaffiche
  `[verify : …]` et, sur un lot fait, l'occupation figée à la clôture.
- `promptimizer/scripts/audit-batch.js` : le résumé backlog expose la commande `verify` du lot
  en cours.
- `promptimizer/scripts/close-batch.js` : exécute la commande `verify` du lot en cours (si posée)
  avant d'indiquer le `done` — refus doux, jamais bloquant (exit 0 dans tous les cas), affiche
  OK ou ÉCHEC (avec les dernières lignes de sortie) dans la checklist.
- `promptimizer/hooks/stop.js` : l'auto-clôture d'un lot backlog (cas univoque) fige désormais
  l'occupation contexte du tour (`turnstats.computeTurn().occ`) dans `closed_occupancy` — une
  clôture manuelle via le CLI laisse ce champ à `null` (pas de transcript à ce niveau).
- `test/run-tests.js` : section « backlog — verify + closed_occupancy (lot #29) » (+15).
  Suite **438 OK**.

## 2026-07-12 (Lot P1 — Epic-label + règle de découpe)

**Lot #28**. Epic reste un simple label (pas un conteneur) : `/pmz-scope` peut désormais l'écrire
lui-même, et un lot backlog peut porter son propre label epic (utile en multi-epics).

- `promptimizer/lib/lot.js` : nouvelle fonction `writeEpic(root, name)` — écrit
  `.vibe-agent/epic` (cap 60c), écriture atomique comme le reste du ledger.
  `titleForBacklogLot` : le champ `epic` du lot prime sur l'epic global du projet quand présent.
- `promptimizer/lib/backlog.js` : nouveau champ optionnel `epic` sur le lot backlog (cap 60c,
  `MAX_EPIC`), normalisé au chargement, tronqué à l'ajout.
- `promptimizer/scripts/backlog.js` : nouvelle commande `epic --set "…"` (écrit le label global)
  et `epic` sans argument (le lit) ; `add --epic "…"` persiste le champ du lot ; `show --epic
  "…"` filtre l'affichage sur ce label.
- `promptimizer/scripts/about.js` : affiche l'epic du lot en cours (sinon du prochain, sinon le
  label global) plutôt que systématiquement le label global.
- `promptimizer/commands/pmz-scope.md` : nouvelle étape — proposer et enregistrer un epic
  optionnel au découpage, le passer à chaque `add` ; règle de découpe explicite (1 lot = 1
  session sous ~300k, 1 commit, fait-quand vérifiable).
- `skills/promptimizer/SKILL.md` : la règle de découpe est reprise en §2bis.
- `test/run-tests.js` : section « backlog — champ epic optionnel du lot (lot #28) » (+10).
  Suite **422 OK**.

## 2026-07-12 (dégraissage tokens — Lot T3 : pmz:skip parsé dans le handoff)

Épic « dégraissage tokens ». **Lot T3** : un handoff manuel peut désormais lister des chemins à
ne pas relire via des lignes `pmz:skip: <chemin>` — l'advisory anti-relecture est actif **dès le
tour 1** de la session suivante, sans attendre une 1re relecture réelle pour l'alimenter.

- `promptimizer/lib/handoff.js` : nouvelle fonction `parseSkipPaths(text)` — extrait les chemins
  des lignes `pmz:skip: <chemin>`, ignore silencieusement les lignes vides/malformées.
- `promptimizer/lib/ledger.js` : nouvelle fonction `seedAvoidReread(root, paths)` — réutilise le
  champ `avoid_reread_notes` existant (pas de nouveau champ), dédupliqué, plafonné à `MAX_READS`.
- `promptimizer/hooks/session-start.js` (`withHandoff`) : après injection d'un handoff avec texte,
  sème `avoid_reread_notes` depuis ses lignes `pmz:skip:` — fail-open (try/catch dédié).
- `test/run-tests.js` : section « pmz:skip parsé dans le handoff (lot T3) » (+5). Suite **412 OK**.

## 2026-07-12 (dégraissage tokens — Lot T2 : trim injection SessionStart)

Épic « dégraissage tokens ». **Lot T2** : l'injection SessionStart était verbeuse et redondante
avec le CLAUDE.md déjà chargé. On la dégraisse **sans casser** les protocoles qu'elle porte.

- `promptimizer/lib/messages.js` : `sessionTitleMessage` réécrit court — **1027 o → 393 o**
  (titre réaliste). Les 5 invariants du protocole de renommage sont conservés : proposition
  **EN CLAIR** dans la réponse (pas seulement le dialogue), cible la session **PRÉCÉDENTE**
  (jamais la courante), nom donné par l'utilisateur respecté, autorisation = simple validation,
  accusé de résultat explicite (jamais muet). Le titre n'y apparaît **plus qu'une fois**.
- Nouveau `MSG_ACTIF_SLIM` (269 o) : sur projet dont le CLAUDE.md porte déjà le bloc `pmz:rules`,
  le rappel SessionStart **ne répète plus** les règles d'économie (déjà dans le contexte) ; il
  pointe vers le bloc et ne garde que le **protocole de clôture** (OK/Non + `/close-batch`),
  absent de `pmz-rules.md`.
- `promptimizer/lib/project.js` : helper `carriesRules(root)` (fail-open) — détecte le marqueur
  `pmz:rules:start` dans le CLAUDE.md.
- `promptimizer/hooks/session-start.js` : choix slim/plein selon `carriesRules` au `startup`/`clear`.
- `test/run-tests.js` : section « Trim injection SessionStart (lot T2) » (+10 assertions) —
  taille du titre ≤ 400 o, invariants du protocole, gating slim/plein sur les deux branches.
  Suite complète : **407 OK · 0 échec**.

## 2026-07-12 (dégraissage tokens — Lot T1 : nudge anti-compaction chiffré)

Épic « dégraissage tokens ». **Lot T1** : les rappels d'occupation invitaient à clôturer sans
jamais dire *pourquoi* compacter coûte plus cher — argument désormais **chiffré**, pour rendre le
choix « clôture + session fraîche » évident au bon moment.

- `promptimizer/lib/messages.js` : helper `compactionCostLines(occ)` partagé — compacter ≈ faire
  relire tout le transcript au résumeur (réécriture de l'occupation en **cache-write ×1,25**) +
  un résumé lossy, vs clôturer + repartir d'un handoff (**~8k**, sans perte). `occupancyMessage`
  l'ajoute **à partir du palier 300k** (bucket ≥ 2), pas avant. Nouveau `compactionNudgeMessage(occ)`.
- `promptimizer/hooks/pre-compact.js` : sur compaction **manuelle** (`/compact`), émet un
  `systemMessage` chiffré (non bloquant, fail-open sur lecture d'occupation) ; `auto` reste
  silencieux. Handoff toujours écrit avant.
- TTL formulé prudemment (**~5 min** clé API / **~1 h** abonnement), **aucun prix codé en dur** —
  on raisonne en tokens, jamais en €/$. Messages portés par `systemMessage` (visibles, **non
  réinjectés**) → zéro coût de cache ajouté.
- `ARCHITECTURE.md` : ligne `pre-compact.js` du tableau des hooks mise à jour (le contrat passe de
  « passThrough pur » à `systemMessage` sur `manual`).
- Vérifié : `node test/run-tests.js` → **397 OK, 0 échec** (11 nouveaux tests : chiffrage,
  palier 300k vs <300k, TTL, absence de prix, hook manual/auto).

## 2026-07-12 (export — Lot D : verrou de découplage + doc autonomie)

Épic « rendre PMZ totalement exportable ». **Lot D** (dernier de l'epic) : rien ne prouvait
qu'un package installé pouvait tourner sans le dépôt source — un `.zip` envoyé à quelqu'un
d'autre aurait pu casser silencieusement si un chemin absolu du dépôt s'était glissé dedans.

- `test/run-tests.js` : nouvelle section « autonomie du package » — `package.js` génère une
  archive, décompressée **hors dépôt** (`os.tmpdir()`, outil `unzip` système), installée vers un
  `$HOME`/`CLAUDE_CONFIG_DIR` fictif, puis `doctor.js` doit rendre un statut **vert sans dépôt
  source ni `.git` présents**. Grep de garde : 0 fichier sous `$DEST/promptimizer` ne contient le
  chemin absolu du dépôt source.
- `ARCHITECTURE.md` : documente le **contrat d'autonomie** du package installé (résolution de
  chemins toujours relative à `__dirname`, jamais un chemin absolu figé vers le dépôt source).
- Vérifié : `node test/run-tests.js` → **386 OK, 0 échec** (8 nouveaux tests).

## 2026-07-12 (audit pilotage produit — roadmap 3 epics T/P/D)

Audit « PMZ outil de pilotage produit » (workflow 8 agents : 3 explorateurs du dépôt, doc
Claude Code 2026, 3 lentilles de conception, critique adversarial vérifié sur le dépôt).
Décisions actées : epic → lot, 2 niveaux (epic = label, « feature » = epic court) ; maille
User Story refusée (`title` + « fait quand » = US compressée) ; distribution cible = plugin
Claude Code (public GitHub en objectif lointain) ; risque n°1 = adoption (aucune nouvelle
commande sans preuve d'usage des 7 existantes).

- `backlog.json` : 9 lots ajoutés (#25-#33) en 3 epics, après l'epic export (#24 prioritaire) —
  **T « dégraissage tokens »** : #25 nudge anti-compaction chiffré [opus · medium], #26 trim
  injection SessionStart (`sessionTitleMessage` ~1,1 Ko) [opus · medium], #27 `pmz:skip` parsé
  dans le handoff [sonnet · medium] ; **P « pilotage lean »** : #28 epic-label + règle de
  découpe « 1 lot = 1 session sous ~300k » [sonnet · medium], #29 preuve de clôture `verify` +
  `closed_occupancy` [sonnet · medium] ; **D « distribution plugin »** : #30 spike go/no-go
  [opus · high], #31 packaging plugin [opus · high], #32 migration legacy + semver
  [sonnet · medium], #33 diffusion MH [sonnet · medium].
- `ARCHITECTURE.md` § Décisions : 4 décisions consignées (US : non ; epic = label ;
  distribution cible = plugin, installeur #22 → outil de migration ; adoption avant features).
- Écartés comme sur-ingénierie (critique adversarial) : table `epics[]`/`/pmz-epic`, `deps[]`,
  `/pmz-review`, `/pmz-report`, `decisions.md`, budget estimé par lot, routage modèle injecté,
  handoff d'epic, MCP server, pivot `.claude/rules/`. Reportés sous preuve d'usage : `files[]`
  périmètre par lot, CLI `edit`/`move`, subagent verifier, statusLine opt-in.

## 2026-07-12 (export — Lot C : versioning d'upgrade)

Épic « rendre PMZ totalement exportable ». **Lot C** : une réinstallation écrasait la version
précédente sans que personne ne sache si c'était une mise à jour, un downgrade, ou une simple
réinstallation.

- `install.js` : lit la VERSION installée (`$DEST/promptimizer/VERSION`) **avant** la purge/copie
  (sinon écrasée), la compare à la VERSION entrante (`lib/version.js`), imprime « première
  installation », « mise à jour vN → vM », « réinstallation (vN) » ou « downgrade vN → vM ».
  Fail-open : version illisible/absente → traité comme première installation, jamais de crash.
- `package.js` : l'archive générée s'appelle `Promptimizer-vN-YYYYMMDD.zip` (au lieu de
  `Promptimizer-YYYYMMDD.zip`).
- `doctor.js` : affiche la version installée (« Version installée : N » ou « inconnue »).
- `test/run-tests.js` : nouvelle section « versioning d'upgrade » (bac à sable, VERSION mutée
  entre appels) — couvre première install, mise à jour, réinstallation identique, downgrade.
- Vérifié : `node test/run-tests.js` → **378 OK, 0 échec** ; `package.js` en bac à sable produit
  bien `Promptimizer-v1-20260712.zip`.

## 2026-07-12 (export — Lot B : installeur Node cross-platform)

Épic « rendre PMZ totalement exportable ». **Lot B** : la logique d'install/diagnostic/désinstall/
packaging vivait dans des scripts `.command` bash (~90 lignes chacun) — macOS uniquement. Un
portage bash+PowerShell aurait dupliqué cette logique (→ dérive). Décision : **installeur Node
unique**, les scripts shell deviennent de simples lanceurs.

- Nouveaux cores Node stdlib (source de vérité unique de la logique) :
  `install/install.js`, `install/doctor.js`, `install/uninstall.js`, `install/package.js`.
  Tous passent par `lib/claude-dir.js` (pas de recalcul du chemin config).
- `install/lib-io.js` (nouveau) : lecture stdin synchrone partagée ; cores **non-interactif-safe**
  (prompts/pause court-circuités hors TTY ou avec `--no-pause`, défauts alignés sur l'ancien bash).
- Lanceurs **fins** par OS (vérif `node` + délégation, zéro logique métier) :
  `install`/`pmz-doctor`/`uninstall`/`package` × `.command` (macOS) + `.sh` (Linux) + `.ps1`
  (Windows). Les anciens `.command` porteurs de logique sont réécrits en lanceurs.
- Portabilité OS : `xattr`/quarantine gardés à `process.platform === 'darwin'` ; packaging archive
  via `zip` (macOS/Linux) ou `Compress-Archive` PowerShell (Windows) ; `git config core.hooksPath`
  seulement sur le dépôt source (présence `.git` + `.githooks`).
- `install.js` : purge des sous-dossiers obsolètes en préservant `state/`, fusion `settings.json`
  via la copie installée de `merge-settings.js`, prise de relais `context-guard.py` (prompt
  interactif ou `--takeover`/`--no-takeover`), puis diagnostic `doctor.js`.
- `test/run-tests.js` : section « install.js bout-en-bout » (source stagée **sans `.git`** →
  aucun effet sur le vrai dépôt) : copie hooks/skill/commands sous `CLAUDE_CONFIG_DIR`, 6 hooks
  fusionnés, HOOK_BASE relocalisé, purge de l'obsolète + `state/` préservé, idempotence.
- `README.md` / `ARCHITECTURE.md` / `CLAUDE.md` : install cross-platform (3 OS), cores Node +
  lanceurs fins documentés.
- Vérifié en bac à sable : `node test/run-tests.js` → **368 OK, 0 échec** ; install.js, package.js
  (zip généré + structure), uninstall.js (retrait des 6 hooks, `state/` conservé) prouvés.
- Limite reportée (Lot D) : chaînes d'aide **affichées** (`messages.js`/`backlog.js`/
  `close-batch.js`) citent encore `~/.claude/...` en dur — cosmétique. Le delta Codex
  (`codex/install-codex.command`) reste bash macOS — hors périmètre du Lot B (package Claude Code).

## 2026-07-12 (export — Lot A : portabilité CLAUDE_CONFIG_DIR)

Épic « rendre PMZ totalement exportable » (plan 4 lots : A portabilité, B installeur Node
cross-platform, C versioning d'upgrade, D verrou de découplage). **Lot A** : PMZ calculait le
dossier de config en `~/.claude` codé en dur (installeur + runtime). Or Claude Code honore
`CLAUDE_CONFIG_DIR` pour relocaliser cette config : sur une machine où l'utilisateur l'a déplacée,
l'install visait le bon dossier mais les hooks restaient aveugles sur un `~/.claude` inexistant.

- `promptimizer/lib/claude-dir.js` (nouveau) : source de vérité **unique** du dossier config —
  `CLAUDE_CONFIG_DIR` si posée (non vide, `trim()`), sinon `~/.claude`. Expose
  `claudeDir/pmzDir/stateDir/hooksDir/settingsPath` (call-time, sensibles à l'env). Fail-open.
- Câblage runtime : `lib/occupancy.js` (STATE_DIR) et `install/merge-settings.js` (HOOK_BASE,
  STATE_DIR, settings.json par défaut) passent par le helper — `require('os')` mort retiré des deux.
- Câblage installeur : `install.command`, `pmz-doctor.command`, `uninstall.command` résolvent
  `DEST="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"`. Comportement shell `:-` (vide → repli) aligné sur
  le `trim()` JS.
- `test/run-tests.js` : section dédiée — helper direct (absente/posée/vide) + bout-en-bout
  merge-settings (settings.json et HOOK_BASE relocalisés sous `CLAUDE_CONFIG_DIR`).
- `ARCHITECTURE.md` : note « source de vérité unique » du dossier config.
- Vérifié en bac à sable : `node test/run-tests.js` → **357 OK, 0 échec** ; résolution shell
  `DEST` prouvée (posée/absente/vide) ; require des consommateurs OK.
- Limite connue (non traitée) : chaînes d'aide **affichées** (`messages.js`/`backlog.js`/
  `close-batch.js`) citent encore `~/.claude/...` en dur — cosmétique, aucun chemin fonctionnel.

## 2026-07-12 (fix — renommage de session bloqué sur un vieux lot)

Retour utilisateur : sur un projet, le hook proposait toujours le même « Lot 7 » en renommage
de session, sans jamais avancer. Cause : `lastDoneLot` (`lib/backlog.js`) triait les lots clos
par `lot_number` décroissant. Or `lot_number` vient du compteur global `lot-counter.json`, qui
avance indépendamment de l'`id` et peut être `null` ou recyclé sur d'anciennes clôtures legacy —
le plus grand `lot_number` *cohérent* restait porté par un vieux lot, sur lequel la sélection se
figeait. Le titre affiché suivait déjà l'`id` backlog (fix 2026-07-11), mais **la sélection**, en
amont, faisait toujours confiance à `lot_number`.

- `lib/backlog.js` : `lastDoneLot` trie désormais par `closed_at` le plus récent, puis par `id`
  décroissant — `lot_number` sort du tri. L'`id` est monotone, jamais recyclé, jamais `null`, et
  c'est déjà le référentiel affiché : le nommage de session devient cohérent bout-en-bout et
  immunisé contre tout `lot_number` sale. Aucune migration de donnée requise : les backlogs déjà
  corrompus se rattrapent seuls au prochain calcul de titre.
- `test/run-tests.js` : test de régression reproduisant le profil observé (plus grand `lot_number`
  sur un vieux lot, `lot_number` null/recyclé sur les lots récents) + cas sans `closed_at`
  exploitable (l'`id` tranche). Échoue sur l'ancien tri.
- `ARCHITECTURE.md` : ordre de sélection du dernier lot clos documenté (décision non-greppable).
- Vérifié en bac à sable : `node test/run-tests.js` → 347 OK, 0 échec.

## 2026-07-11 (fix — popup Gatekeeper qui revenait à chaque `git pull`)

Retour utilisateur : le popup macOS « Apple n'a pas pu confirmer que "install.command" ne
contenait pas de logiciel malveillant » réapparaissait à chaque récupération d'une nouvelle
version du dépôt, car `git pull` réécrit le contenu des `.command` et macOS réapplique la
quarantaine sur le fichier modifié.

- `.githooks/post-merge` et `.githooks/post-checkout` : lèvent automatiquement
  `com.apple.quarantine` sur tous les `.command` du dépôt après chaque pull/merge/checkout.
  Fail-open (jamais d'échec de `git pull`).
- `promptimizer/install/install.command` : active `core.hooksPath=.githooks` sur le dépôt
  source dès le premier lancement — le fix devient permanent sans étape manuelle répétée.
- `README.md` : note d'installation mise à jour.
- Vérifié en bac à sable (copie du repo) : clone frais → install → quarantaine posée
  artificiellement → hook `post-merge` → quarantaine levée. `node test/run-tests.js` :
  345 OK, 0 échec.

## 2026-07-11 (fix — numérotation du titre de session dérivait du numéro backlog)

Retour utilisateur : le titre de session affichait un numéro de lot (« Lot 14 ») déconnecté
du référentiel réel (`backlog.js show` affichait déjà #17). Cause : `suggestedTitle`
(`lib/lot.js`) construisait le numéro depuis `lot-counter.json`, un compteur qui avance à
chaque transition working-tree sale → propre — y compris sur un commit de bookkeeping de
clôture backlog qui n'ajoute aucun lot — et dérivait donc de l'ID backlog au fil du projet.

- `lib/lot.js` : le numéro affiché dans le titre de session est désormais l'**ID du lot
  backlog** retenu (lot en cours / dernier clos / suivant à faire), jamais `lot-counter.json`.
  Le compteur reste le seul recours quand le plan n'offre aucun lot exploitable (backlog
  absent/vide, ou lot écarté comme périmé) — faute d'un autre référentiel dans ce cas.
- `ARCHITECTURE.md` mis à jour (mécanisme + raison de l'ancien comportement).
- Tests : 3 nouvelles assertions simulant la dérive du compteur (`test/run-tests.js`) —
  vérifient que le titre suit l'ID backlog même quand `lot-counter.json` a avancé plus vite.
  `node test/run-tests.js` : 345 OK, 0 échec.

## 2026-07-11 (lot 18 — clôture de lot proposée en fenêtre OK/Non)

Retour utilisateur : la clôture de lot doit être demandée via une fenêtre de question à choix
cliquable (OK/Non), pas en texte libre dans le chat. Auto-exécution complète (commit compris)
écartée : casse « fait = prouvé » et « ne jamais committer sans demande explicite ».

- `promptimizer/lib/messages.js` : `MSG_ACTIF` et `MSG_CLOTURE` demandent désormais de proposer
  la clôture via une question à choix (OK/Non) avant de dérouler `/close-batch`.
- `promptimizer/templates/CLAUDE.md` : même règle ajoutée en Priorité 2, pour qu'elle persiste
  dans les projets qui déploient PMZ.
- `ARCHITECTURE.md` : décision documentée (pourquoi pas l'auto-exécution complète).
- Tests : `node test/run-tests.js` inchangés et verts (342 OK) — les assertions existantes sur
  `MSG_CLOTURE`/`MSG_ACTIF` restent satisfaites (contenu étendu, pas remplacé).

## 2026-07-11 (fix — commande renommée /about → /pmz-about)

Retour utilisateur : le nom `/about` était trop générique (risque de collision avec d'autres
plugins/commandes). Renommée en `/pmz-about`, préfixée comme les autres commandes structurantes
du package (`/pmz-init`, `/pmz-scope`).

- `promptimizer/commands/about.md` → `promptimizer/commands/pmz-about.md` (contenu inchangé,
  le script sous-jacent `scripts/about.js` garde son nom).
- README/ARCHITECTURE mis à jour.

## 2026-07-11 (lot 17 — version PMZ historisée + commande about) — PMZ v1

Lot #17 du plan (16/17 → 17/17). Le package n'avait jusqu'ici aucun numéro de version : deux
installations pouvaient tourner avec un comportement différent sans moyen de le vérifier.

- **`promptimizer/VERSION`** : entier simple (pas de semver, un seul mainteneur), copié tel
  quel à l'installation. Version actuelle : **1** — ce lot introduit le suivi.
- **`lib/version.js`** : `readVersion()` (fail-open, `null` si absent/illisible) et
  `bumpVersion()` (réservé au mainteneur du dépôt source — incrémente et persiste ; jamais
  appelé par les hooks installés dans un projet cible, qui n'ont pas leur propre version).
- **`scripts/about.js` + commande `/about`** : affiche la version installée de PMZ, l'epic du
  projet courant et l'état du backlog (progression, lot en cours ou prochain lot todo). Fail-open
  partout (hors-git, projet non initialisé, backlog vide → statuts annoncés, jamais de throw).
- Chaque future évolution notable bumpera `VERSION` et tracera le changement ici — ce fichier
  devient l'historique de version, pas seulement un journal de commits.
- **Tests** : 8 assertions ajoutées (lecture VERSION, `/about` sans backlog, avec epic +
  progression, lot in_progress, hors-git fail-open). 342 OK.

## 2026-07-11 (fix — le numéro de lot du titre de session ne reste plus figé)

Retour utilisateur (repro sur un autre projet) : le nom de session proposé affichait
« Epic — Lot 4 » cinq sessions de suite quel que soit le lot réellement en cours ou clos.

- **`lib/backlog.js`** : `doneLot` — la clôture **manuelle** d'un lot (`backlog.js done`,
  utilisée par `/close-batch`) lisait le compteur global (`lot-counter.json`) pour étiqueter
  le lot clos, mais ne l'**écrivait jamais** — seule la clôture automatique du hook Stop le
  persistait. Résultat : après une clôture manuelle, la session suivante recalculait le même
  numéro, l'attribuant à un autre lot (collision), et `suggestedTitle` (qui construit toujours
  son « Lot N » à partir de ce compteur, jamais du `lot_number` propre au lot) répétait
  indéfiniment le même chiffre. `doneLot` appelle désormais `incrementLot(root)` (qui persiste)
  quel que soit le chemin de clôture.
- **Tests** : 3 assertions ajoutées (le compteur avance et est persisté après une clôture
  manuelle ; deux clôtures manuelles de suite avancent deux fois, jamais figées ; deux lots
  clos de suite reçoivent des `lot_number` distincts). 333 OK.
- Le fix ne prend effet qu'après réinstallation du package (`install/install.command`) sur les
  projets qui utilisent déjà `~/.claude/promptimizer` — le dépôt source seul ne suffit pas.

## 2026-07-11 (fix — suggestedTitle déduit un titre quand le plan n'en offre aucun)

Retour utilisateur : le nom de session proposé pour la session précédente n'affichait parfois
que « Epic — Lot N », sans rien qui décrive ce qui avait été fait — cas du backlog absent ou
vide (`lots: []`), où aucun lot n'existe pour fournir un titre à suffixer.

- **`lib/lot.js`** : `suggestedTitle` — quand le plan de lots n'a lui-même **aucun titre à
  offrir** (backlog absent ou vide), déduit un intitulé des infos disponibles au lieu de
  retomber nu : dernier résumé `CHANGELOG.md` (parenthèse finale du dernier titre `##` ;
  ignorée si ce n'est qu'un marqueur `(lot N)` non descriptif), sinon sujet du dernier commit.
- Cette déduction ne s'applique **jamais** quand un lot existe dans le plan mais est écarté
  comme périmé (cf. lot #14) : un titre existe alors, il est volontairement tu — le remplacer
  par une supposition externe reviendrait à mentir.
- **`ARCHITECTURE.md`** à jour. **Tests** : 5 assertions ajoutées (déduction CHANGELOG, repli
  git quand la parenthèse n'est qu'un marqueur `(lot N)`, aucune info disponible → titre nu,
  `backlog.json` avec `lots:[]` traité comme absent, non-régression du cas « lot périmé » qui ne
  doit jamais utiliser cette déduction). 330 OK.

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
