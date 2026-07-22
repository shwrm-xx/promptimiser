# Note d'orientation — Archive à tiroirs des handoffs de lots (Promptimizer)

## Objet

Cette note fixe la conception d'un référentiel **durable et consultable sur demande** des
handoffs de lots — décisions, non-vérifié, dette — pour combler une déperdition constatée dans
le code : le handoff riche de fin de lot n'a aujourd'hui qu'une seule vie (voir §0). Elle a été
produite par une étude multi-agents (6 lecteurs de cartographie du code, conception, puis
vérification adversariale à 2 lentilles — existence du problème / respect des invariants PMZ —
sur chaque point de la spec). Les deux verdicts de vérification sont **CONFIRMÉ** (§10).

Ce document est la référence de conception ; le catalogue des opportunités de fiabilisation et
de non-déperdition associées est dans [02-catalogue-deperditions-fiabilisation.md](02-catalogue-deperditions-fiabilisation.md).
La matière brute de cartographie (faits et citations par sous-système) est dans
[03-cartographie-brute.md](03-cartographie-brute.md).

---

## Spec — « Archive à tiroirs » des handoffs de lots (PMZ)

## 0. Objet et principes

Combler la déperdition n°1 du système : le narratif riche de fin de lot (objectif, décisions+pourquoi, non-vérifié, dette) n'a aujourd'hui qu'UNE vie — écrit dans `.vibe-agent/handoff.md` (fichier unique, gitignoré via `.vibe-agent/.gitignore:9`), consommé une fois au SessionStart (`promptimizer/hooks/session-start.js:63-68`, `markConsumed` à `promptimizer/lib/handoff.js:79-88`), puis écrasé par le handoff auto au Stop suivant (`promptimizer/hooks/stop.js:219`, `promptimizer/lib/handoff.js:128-199`). Les handoffs riches des ~90 lots clos ont tous disparu.

Principes non négociables :

1. **Durable et versionné git** — comme `backlog.json` (whitelist `.vibe-agent/.gitignore:9-13` + staging à chaque écriture, `promptimizer/lib/backlog.js:221-231`).
2. **Divulgation progressive** — trois tiroirs, on n'en ouvre qu'UN à la fois, via une commande dédiée.
3. **Pare-feu absolu** — jamais relu automatiquement : ni SessionStart (startup/clear/resume/compact), ni handoff auto (`writeAutoHandoff`), ni pré-compact, ni `pmz:summary`. Le pare-feu existant est STRUCTUREL : `session-start.js:6` (« ne scanne jamais le repo ») + liste blanche codée en dur (handoff.md, backlog.json, ledgers). L'archive s'appuie dessus et le verrouille par test (§6).
4. **Anti-péremption** — la fiche capture le narratif stable (pourquoi, non-vérifié, dette) ; on lie le sha (`closed_commit`), jamais le diff ni le contenu de fichiers. Fiche immuable après écriture.
5. **Révision explicite d'une décision documentée** — ARCHITECTURE.md:1058-1063 (« Handoff : un seul fichier écrasé, pas d'historique ») doit être amendée : le handoff RESTE un fichier unique écrasé (canal de reprise) ; l'archive est un référentiel SÉPARÉ, jamais injecté, qui répond aux objections d'origine (bloat → fiches courtes bornées, une par lot ; nettoyage → immuables, versionnées ; « valeur seulement pour la session suivante » → faux pour les décisions et le non-vérifié, prouvé par la perte constatée).
6. **Invariants PMZ** — zéro dépendance (stdlib), fail-open absolu (une erreur d'archive ne casse JAMAIS une session ni une clôture), cross-platform, compatible canaux manuel ET plugin.

## 1. Arborescence et formats

```
.vibe-agent/archive/
  index.md                 ← tier 0 (versionné)
  lots/lot-0091.md         ← tier 1, une fiche par lot (versionné)
  waves/wave-<id>.md       ← tier 1 bis, une fiche par vague réintégrée (versionné)
  raw/lot-0091.md          ← tier 2, brut (NON versionné par défaut, cf. question ouverte Q1)
```

### Tier 0 — `index.md` : une ligne par lot, greppable

Format contraint, append-only, triée par id :

```
#0091 | 2026-07-18 | bcff59e | epic:Verbe & Vagues | verify:OK | fiche:oui | pointeur de vague dans le handoff auto
```

**Pourquoi markdown ligne-à-ligne et pas JSON/JSONL** : (a) consulté par l'humain et par `grep` — zéro cérémonie de parse ; (b) diff git lisible, merge trivial (append d'une ligne ≠ conflit sur un tableau JSON) ; (c) robustesse : une ligne corrompue n'invalide pas le reste, alors qu'un JSON corrompu retombe sur le fallback silencieux de `readJson` (`promptimizer/lib/fsjson.js:19-26`) — exactement le mode de perte totale observé sur les ledgers. Champ `verify:` ∈ {OK, ÉCHEC, timeout, aucune, inconnu} ; `fiche:` ∈ {oui, non} (rend visible une fiche manquante — filet machine §4.2).

### Tier 1 — `lots/lot-NNNN.md` : la fiche narrative

**Pourquoi markdown, un fichier par lot** : contenu = prose stable (décisions+pourquoi) ; un fichier par lot = écrit une fois à la clôture puis immuable → zéro course entre sessions filles (contrairement à un fichier unique last-writer-wins, le défaut structurel du handoff, `promptimizer/lib/handoff.js:128-132`) ; lisible sur GitHub. Id zero-paddé 4 chiffres (tri lexicographique = tri numérique).

Gabarit (≤ ~600 tokens, bornes dures côté writer : refus au-delà de 8 000 caractères, message explicite — même philosophie que la garde anti-troncature du lot #90, `promptimizer/lib/backlog.js:102-118`, jamais de coupe silencieuse) :

```markdown
<!-- pmz:archive:lot 91 -->
# Lot #91 — <titre backlog>

- epic : … · clos : 2026-07-18 · commit : bcff59e · session : <id|inconnue>
- verify : `node test/run-tests.js` → OK · coût : ~Nk tokens | non mesuré

## Objectif
## Décisions (et pourquoi)
## Vérifié
## Non vérifié
## Dette restante
## Périmètre
(globs / fichiers touchés — noms seulement, jamais de diff)
## Liens
- commit bcff59e · entrée CHANGELOG du 2026-07-18 · brut : archive/raw/lot-0091.md (local) | transcript <session_id>
```

Interdits (anti-péremption) : diff, contenu de fichier, listing de code, sortie de tests complète. Le sha et l'entrée CHANGELOG font foi pour le volatil.

### Tier 2 — `raw/lot-NNNN.md` : le brut

Retour intégral du sous-agent (orchestration) ou, en flux série, simple pointeur transcript (session_id + horodatage) consigné dans la fiche — on ne copie jamais un transcript. **Non versionné par défaut** (reste sous le `*` du gitignore, comme le précédent `.vibe-agent/logs/` du fallback de sortie, ARCHITECTURE.md:403-404) : volumineux, potentiellement porteur de chemins machine/sorties de tests, et sa perte au clone est acceptable puisque la fiche tier 1 capture le stable. Markdown/texte brut (c'est un collage, pas une structure).

## 2. Frontière git

`.vibe-agent/.gitignore` (dépôt vivant `:9-13` ET template `promptimizer/templates/vibe-gitignore:7-10`) — ajouter, dans cet ordre (le `*` initial impose de dé-ignorer le dossier puis son contenu, puis de ré-ignorer le brut) :

```
!archive/
!archive/**
archive/raw/
```

**Migration de la base installée** : `copyIfAbsent` ne met JAMAIS à jour un `.gitignore` existant (`promptimizer/lib/bootstrap.js:25-33`, posé en `:51`) — précédent vécu : le backlog avait disparu faute d'être suivi par git. Le writer appelle donc `ensureArchiveGitignore(root)` avant toute écriture : si `.vibe-agent/.gitignore` existe et ne contient pas `!archive/`, append idempotent du bloc ci-dessus (philosophie merge-settings : append-only, idempotent, fail-open). À brancher aussi dans `runBootstrap` après `bootstrap.js:51`. Rétro-porter au passage `!trigram` manquant du template (`.vibe-agent/.gitignore:13` vs `templates/vibe-gitignore` qui s'arrête à `!rules.yaml`).

**Staging** : chaque écriture tier 0/1 est suivie d'un `git add` best-effort (modèle exact : `stageBacklog`, `promptimizer/lib/backlog.js:221-223`) — la fiche survit à un `git clean` et part avec le commit suivant (en pratique le commit « chore(backlog): clôture du lot #N » déjà systématique). `gitStatusMeaningful` exclut `.vibe-agent/` (`promptimizer/lib/project.js:102-108`) : les écritures d'archive ne comptent jamais comme « lot ouvert » et ne bloquent jamais une clôture.

## 3. Writer — `promptimizer/lib/archive.js` (nouveau)

Stdlib seule ; chaque fonction try/catch → valeur neutre (fail-open). API :

- `archiveDir(root)`, `ficheFile(root, id)`, `rawFile(root, id)`, `indexFile(root)` ;
- `writeAtomicText(file, text)` — tmp unique pid+timestamp puis rename, pendant texte de `fsjson.writeAtomic:7-16` (à ajouter dans `fsjson.js` et à réutiliser, au passage, pour corriger l'écriture non atomique de `handoff.js:199` et `:84` — fiabilisation connexe) ;
- `appendIndexLine(root, entry)` — relit l'index, **idempotent par id** (ligne déjà présente → no-op ; présente avec `fiche:non` → remplacée), réécrit atomiquement, stage. Course RMW multi-sessions résiduelle assumée (même palier que fleet, `promptimizer/lib/fleet.js:14-18`) ; le lecteur tolère les doublons (dernier gagne par id) ;
- `writeFiche(root, id, markdown, {force})` — refuse si la fiche existe (immuabilité) sauf `--force` ; valide la présence du marqueur `<!-- pmz:archive:lot N -->` et la borne de taille ; écrit atomique, stage, met à jour la ligne d'index (`fiche:oui`) ;
- `writeRaw(root, id, text)` — écrit `raw/lot-NNNN.md` (jamais stagé) ;
- `readIndex(root)`, `readFiche(root, id)` — lecture pour le CLI uniquement. **Aucun hook, aucun module de la chaîne d'injection (`session-start.js`, `handoff.js`, `messages.js`, `pre-compact.js`) ne doit jamais requérir `lib/archive.js` en lecture** — c'est l'invariant vérifié par le test pare-feu.

## 4. Points d'écriture (à la clôture, quand le contexte riche existe encore)

### 4.1 `/close-batch` — chemin principal (fiche tier 1)

- `promptimizer/commands/close-batch.md:22-28` : nouvelle étape **6bis**, juste avant le handoff : « Rédige la fiche d'archive du lot (mêmes matériaux que le handoff : décisions+pourquoi, vérifié/non-vérifié, dette) et écris-la : `node ~/.claude/promptimizer/scripts/archive.js write --id N --stdin` ». La fiche et le handoff sont deux distillats distincts d'un même contexte : le handoff = reprise (prochaine action), la fiche = mémoire (pourquoi).
- `promptimizer/scripts/close-batch.js:64-95` : la checklist émet un **squelette de fiche pré-rempli** (id, titre, epic, `verify` avec son résultat déjà calculé en `:56-62` — c'est LE moment où le résultat verify existe et n'est aujourd'hui persisté nulle part, cf. `backlog.js:400-423` qui ne stocke aucun champ de résultat) + la ligne de commande `archive.js write`.

### 4.2 Filet machine tier 0 — `doneLot`

`promptimizer/lib/backlog.js:400-423` : après `saveBacklog` réussi, `try { appendIndexLine(root, …) } catch {}` avec les champs machine (id, date, closed_commit, epic, titre, `verify:inconnu`, `fiche:non`). Garantit un index **complet** même quand la fiche n'est pas écrite (auto-clôture par `stop.js:182`, clôture CLI `scripts/backlog.js:326-330` — les deux passent par `doneLot`). Le `fiche:non` rend la dette de documentation visible dans l'index au lieu de la masquer. Fail-open strict : ce code tourne dans le hook Stop.

### 4.3 Orchestration — `/reintegrate` (fiches filles + fiche de vague)

- `promptimizer/commands/reintegrate.md:22-29` : étape supplémentaire pour l'orchestrateur : « Pour chaque lot réintégré, distille le **retour structuré du sous-agent / de la session fille** en fiche tier 1 (`archive.js write --id N`) et colle son retour intégral en tier 2 (`archive.js raw --id N --stdin`) — c'est le seul moment où ce retour existe encore dans ton contexte. » Comble la perte « retour de sous-agent = texte libre jamais persisté » (`close-batch.md:13-15`) et le handoff partagé écrasé entre filles (`handoff.js:128-132`).
- `promptimizer/scripts/backlog.js:232-235` (bloc `--execute`) : écriture **machine** de `archive/waves/wave-<id>.md` — changelog agrégé (`reintegrate.js:100-116`), résultat par lot (mergé+gate vert / conflit / gate rouge avec queue de sortie), branche et sha d'intégration. Comble la perte « bloc agrégé et diagnostics de gate uniquement sur stdout, non régénérables » (une ré-exécution renvoie `nothing-ready`, `reintegrate.js:156`).

## 5. Commande `/pmz:archive` — `promptimizer/commands/archive.md` + `promptimizer/scripts/archive.js` (nouveaux)

Frontmatter : `description: Consulte l'archive des lots clos (index / fiche / brut — un tiroir à la fois)` ; `allowed-tools: Bash(node *)`.

- **Sans argument** → tier 0 seul : `node ~/.claude/promptimizer/scripts/archive.js index`. Consigne explicite dans le .md : « Restitue l'index tel quel. N'ouvre AUCUNE fiche sans demande explicite de l'utilisateur. »
- **Avec `lot-id`** → tier 1 seul : `archive.js show --id N` (affiche la fiche ; si absente : la ligne d'index + « fiche jamais écrite — brut/transcript éventuels : voir `--raw` »).
- **Garde-fou tier 2** : `archive.js raw --id N` sans `--confirm` n'affiche QUE le chemin et la taille (`raw/lot-0091.md — 34 812 octets. Relance avec --confirm pour l'afficher.`). Le .md ordonne de poser une question à choix (afficher le brut ? OK/Non) avant tout `--confirm` — le brut peut peser des dizaines de Ko de contexte.
- Sous-commandes d'écriture : `write --id N [--stdin|--file F] [--force]`, `raw --id N --stdin`, `backfill [--dry-run]` (§8).
- CLI fail-open : `try { main() } catch {}` puis `process.exit(0)`, id inconnu/index corrompu → message doux, jamais d'exit ≠ 0 (modèle : `scripts/backlog.js:376-379`).

## 6. Test pare-feu (nouvelle section de `test/run-tests.js`)

Harnais existant : sandbox + `runHook(file, input, env)` (`test/run-tests.js:21-55`). Section « Archive à tiroirs — pare-feu » :

1. **Empoisonnement** : repo bac à sable bootstrappé ; écrire `archive/index.md`, `archive/lots/lot-0001.md`, `archive/raw/lot-0001.md` et `archive/waves/wave-x.md` contenant chacun le canari `PMZ_ARCHIVE_CANARY_9f3`.
2. **Aucune injection** : pour `source` ∈ {startup, clear, compact, resume}, `runHook('session-start.js', {source, cwd, session_id, transcript_path})` → assert `!r.out.includes(CANARI)` (sur startup, forcer aussi le cas AVEC handoff présent et le cas fallback backlog).
3. **Aucune fuite via le handoff auto** : `runHook('stop.js', …)` puis lire `.vibe-agent/handoff.md` → pas de canari (ni dans stdout) ; idem `runHook('pre-compact.js', …)`.
4. **Verrou structurel anti-régression** : lire les sources de `hooks/*.js`, `lib/handoff.js`, `lib/messages.js` et asserter qu'aucune ne contient `require(...archive` ni `.vibe-agent/archive` — un futur branchement en lecture dans la chaîne d'injection casse le test avant de casser le pare-feu.
5. **Fail-open** : `archive.js` stdin vide / id inexistant / `index.md` corrompu → exit 0 ; `doneLot` avec `archive/` remplacé par un fichier (mkdir impossible) → la clôture backlog réussit quand même.
6. **Frontière git** : après `writeFiche`, `git check-ignore` refuse `archive/lots/lot-0001.md` (versionné) et accepte `archive/raw/lot-0001.md` (ignoré) ; `git status` montre la fiche stagée ; `ensureArchiveGitignore` sur un vieux `.gitignore` (sans `!archive/`) l'ajoute une seule fois (idempotence).

## 7. Compat canal plugin / cross-platform

- **Découverte automatique** : `build-plugin.js` copie intégralement `promptimizer/` moins `{install, .DS_Store, statusline.md}` (`promptimizer/install/build-plugin.js:42, 90-93`) — `commands/archive.md`, `scripts/archive.js` et `lib/archive.js` sont embarqués sans manifest.
- **Obligatoire** : ajouter `'archive.md'` à `REQUIRED_COMMANDS` (`build-plugin.js:49-52`) — et corriger au passage `rtk.md`, livré mais absent de la liste (garde inopérante pour lui).
- **Chemins** : `archive.md` référence ses scripts EXACTEMENT sous `~/.claude/promptimizer/scripts/archive.js` pour bénéficier de la réécriture `${CLAUDE_PLUGIN_ROOT}` (`build-plugin.js:59-61, 108-110`). Rien sous `install/` (exclu du plugin, cf. précédent statusline `build-plugin.js:38-42`).
- **Canal manuel** : copie plate des .md → commande `/archive` (nom nu), plugin → `/pmz:archive` (`install/install.js:112-117`, ARCHITECTURE.md:846-854).
- **Cross-platform** : `path.join` partout, aucune commande shell hors `git` via le wrapper `git()` de `lib/project.js` (jamais throw), pas de `rg`. L'état écrit vit dans le repo (`.vibe-agent/archive/`), jamais dans `pmzDir()` (remplacé à chaque update plugin, ARCHITECTURE.md:769-773).

## 8. Rétro-remplissage des ~90 lots clos — faisable, tiers différenciés

Sources : `.vibe-agent/backlog.json` (90/90 lots done avec `closed_commit` ; `closed_at` NON fiable — `backlog.js:513-520`, l'id est le seul ordre sûr), `git log` (113 commits « lot #N », motif stable), `CHANGELOG.md` (126 entrées « lot #N », narratif riche : c'est déjà un tier 1 de fait).

- **Tier 0 : OUI, complet et machine** — `archive.js backfill` génère une ligne par lot done depuis le backlog (id, titre, epic, closed_commit, date, `verify:inconnu` — le résultat n'a jamais été persisté, `fiche:non`). Reprenable/idempotent (skip des ids déjà présents), `--dry-run` d'abord.
- **Tier 1 : DÉGRADÉ, assumé** — fiche squelette par lot : méta backlog + **lien** vers l'entrée CHANGELOG (grep du heading « lot #N » ; lier plutôt que dupliquer, règle doc), marquée `<!-- pmz:archive:backfill -->` en provenance. Les décisions/non-vérifié d'époque sont définitivement perdus (handoffs écrasés) : la fiche backfill ne les invente pas.
- **Tier 2 : NON** — transcripts non retrouvables, aucune source.

## 9. Déperditions couvertes / fiabilisations connexes recensées

Couvertes par cette spec : handoff riche à vie unique (`handoff.js:79-88` + `.gitignore:9`) ; résultat verify jamais persisté (`backlog.js:400-423`, `stop.js:204-212`) ; « non-vérifié » purement discursif (`close-batch.md:12`, `rules.yaml:35`) ; checklist et mapping fait/non-vérifié sur stdout seulement (`close-batch.js:72-96`) ; retour de sous-agent en texte libre (`close-batch.md:13-15`) ; changelog agrégé de vague perdu sur stdout (`scripts/backlog.js:232-235`) ; carte de clôture/bilan d'epic éphémères et évinçables par l'arbitre (`stop.js:186-212`, `arbiter.js:20`).

Connexes, recommandées dans le même chantier ou en lots séparés : écriture atomique du handoff via `writeAtomicText` (`handoff.js:199`, `:84` — un crash mi-écriture bloque aujourd'hui le canal définitivement via le garde `:132`) ; test unitaire de `writeAtomic` (zéro occurrence dans `run-tests.js`) ; quarantaine avant reset silencieux d'un ledger corrompu (`fsjson.js:19-26`) ; plafond global testé de l'injection SessionStart (`session-start.js:147-163`).

Hors périmètre (notées, non traitées ici) : chaînon manquant d'écriture fleet (`upsertLot`/`setLotState` sans appelant prod), péremption du fleet post-vague, gate final de vague absent, `depends_on` ignoré en flux série.

---

## 10. Vérification adversariale de cette spec

Deux lentilles indépendantes ont tenté de réfuter la spec ci-dessus sur le code réel du dépôt.

### Lentille ancrage (les points d'intégration cités sont-ils exacts ?)

**Verdict : CONFIRMÉ**

Tous les points d'intégration majeurs vérifiés dans le code, aucun faux : (1) close-batch.md:22-28 = bien l'étape 6 (handoff) où insérer un 6bis ; allowed-tools `Bash(node *)` (close-batch.md:3) couvre `node …/archive.js write`. (2) close-batch.js : verify calculée en :56-63 (runVerify :57, verdicts :58-62), checklist émise :64-95 — bon endroit pour le squelette de fiche. (3) lib/backlog.js:400-423 = doneLot exact, saveBacklog dans le return :422 ; appelants confirmés stop.js:182 et scripts/backlog.js:327. (4) scripts/backlog.js:232-235 = bien la branche --execute de reintegrate() (fonction :150, --execute :207-208) avec aggregateChangelog :232, m.head par lot :221, res.integrationBranch :217 — la matière du wave-<id>.md est disponible là. (5) reintegrate.md:22-29 = bloc « Étapes » orchestrateur, exact. (6) staging façon stageBacklog : lib/backlog.js:221-223, exact. (7) build-plugin.js:49-52 = REQUIRED_COMMANDS exact, et rtk.md est bien présent dans promptimizer/commands/ mais ABSENT de la liste (bug confirmé) ; rewritePaths :59-61 réécrit ~/.claude/promptimizer → ${CLAUDE_PLUGIN_ROOT}, cohérent avec le point archive.md. (8) templates/vibe-gitignore:7-10 = whitelist (*, !.gitignore, !backlog.json, !rules.yaml), sans !trigram ; .vibe-agent/.gitignore:9-13 du dépôt contient !trigram :13 — rétro-port justifié. (9) bootstrap.js:51 = copyIfAbsent('vibe-gitignore') exact, et :25-33 confirme qu'un .gitignore existant n'est jamais mis à jour (migration nécessaire). (10) lib/handoff.js et lib/messages.js existent ; hooks touchant le handoff = session-start.js, stop.js, pre-compact.js, post-tool-use.js — cibles du pare-feu correctes ; test/run-tests.js existe. (11) lib/archive.js, scripts/archive.js, commands/archive.md n'existent pas (NOUVEAU exact). Les risques cités recoupent le code/doc : ARCHITECTURE.md:617-618 (backlog disparu), :403-404 (logs sans rétention), :837-843 (dérive cache plugin), :1058-1063 (décision « pas d'historique » à amender), fleet.js:14-18 (concurrence assumée palier 2).

**Corrections à intégrer avant implémentation :**

1) Citation à ajuster : le calcul verify de close-batch.js s'étend sur :56-63 (pas 56-62). 2) Filet doneLot : saveBacklog est DANS l'expression de retour (lib/backlog.js:422 `return saveBacklog(root, b) ? lot : null;`) — l'appendIndexLine « après saveBacklog » impose de capturer le résultat dans une variable avant le return (petite restructuration, pas un simple ajout de ligne). 3) Idempotence du filet : doneLot court-circuite un lot déjà done (lib/backlog.js:404 `if (lot.status === 'done') return lot;`) — le double chemin stop.js:182 + CLI :327 peut rappeler doneLot sur un lot déjà clos sans repasser par le filet, ET le rappeler deux fois avant clôture ; l'idempotence par id de appendIndexLine doit couvrir les deux sens. 4) build-plugin.js : en plus d'ajouter archive.md à REQUIRED_COMMANDS (:49-52), vérifier qu'il n'entre PAS dans EXCLUDE (:42, précédent statusline.md exclu volontairement car dépendant d'install/) — archive.js vivra sous scripts/+lib/, inclus dans le plugin, donc OK, mais à valider explicitement dans le lot. 5) Gitignore : l'ordre des motifs compte (dernier gagnant) — `!archive/` doit précéder `!archive/**` (git ne ré-inclut jamais le contenu d'un dossier exclu), puis `archive/raw/` re-ignore le tier 2 ; à figer tel quel dans le template ET dans ensureArchiveGitignore. 6) Squelette de fiche (close-batch.js) : le champ « résultat verify » n'existe que si bl.current.verify est posée (:56) — prévoir la valeur « inconnu » pour les lots sans verify, cohérente avec le tier 0 du filet. 7) Wave writer (scripts/backlog.js:232-235) : n'écrire l'archive de vague que dans la branche res.ok/waveClosed (:234) ou par lot mergé (:219-225) — le chemin culprit (:226-229) sort avant :232, donc une vague stoppée ne produirait rien ; décider explicitement si un échec de pipeline laisse une trace tier 1 (recommandé : oui, c'est une info à forte déperdition).

### Lentille pare-feu (l'archive peut-elle fuir dans l'injection automatique ?)

**Verdict : CONFIRMÉ**

Tentative de réfutation : cherché un canal d'aspiration automatique du contenu de .vibe-agent/archive/ vers le contexte injecté. (1) Aucun scan de dossier au runtime : `git grep readdirSync|glob` ne touche que install/ (build-plugin.js:65,78, install.js:114,127…), jamais hooks/ ni lib/ — session-start.js:6 affirme « ne scanne jamais le repo » et le code le confirme. (2) Toutes les lectures injectées sont à chemin FIXE : readHandoff lit uniquement .vibe-agent/handoff.md (handoff.js:25-27,64-75), backlogFallback lit backlog.json (session-start.js:48-56), fleetLines et ledgers sont des JSON à chemin fixe ; le compact-resume (session-start.js:102-121) ne puise que backlog + todo-snapshot + avoidRereadNotes/topSummaries du ledger. (3) writeAutoHandoff (handoff.js:128-204, appelé par stop.js:219 et pre-compact.js:19) n'émet que des lignes DÉRIVÉES : chemins pmz:skip (handoff.js:157-161), résumés pmz:summary déjà présents dans le ledger (handoff.js:169-175), lignes git status (handoff.js:192-195) — jamais le contenu d'un fichier arbitraire. Un fichier archive/ non commité n'apparaît que comme CHEMIN dans le status, plafonné (MAX_DIRTY_LINES=15, handoff.js:20) et sous cap global 6000c (handoff.js:19,70). (4) Si l'humain consulte l'archive à la demande, post-tool-use.js:74-82 enregistre le CHEMIN dans files_read (aucune exclusion .vibe-agent, ledger.js:88-126) → il peut ressortir en pmz:skip au handoff suivant : c'est un chemin anti-relecture, pas du contenu — effet protecteur, pollution de slots au pire. Le pare-feu tient structurellement.

**Corrections à intégrer avant implémentation :**

Deux canaux résiduels MOUS à fermer, tous deux paramétrés par le comportement assistant et non par la machine : (a) pollution des slots pmz:skip — recentReads/skipCandidates (handoff.js:91-100,118-124) ne filtrent pas les chemins .vibe-agent/ : après consultation de l'archive, ses chemins consomment des slots MAX_READ_LINES=10 du handoff ; ajouter une exclusion des chemins sous .vibe-agent/archive/ (voire .vibe-agent/ entier) dans skipCandidates ; (b) boucle de résumés — si l'assistant écrit une ligne `pmz:summary: .vibe-agent/archive/… — <texte>` dans un handoff manuel, session-start.js:67 (seedSummaries) la sème dans le ledger, puis scoredSummaries (handoff.js:169-175) et topSummaries au compact (session-start.js:113) RÉ-INJECTENT ce distillat d'archive de session en session : filtrer les clés sous archive/ dans seedSummaries (ledger.js:210-226) ou dans les émetteurs. Enfin, le test canari prévu par la spec (canari dans archive/ jamais présent dans session-start startup/clear/compact/resume, stop, pre-compact, handoff.md + verrou statique « aucun require d'archive dans hooks/ + lib/handoff.js + lib/messages.js ») est nécessaire et suffisant pour verrouiller ce constat dans la durée — il doit couvrir aussi les deux corrections (a) et (b) ci-dessus.
