# D3 — Parallélisation gouvernée des lots (paliers 2 & 3)

Date : 2026-07-20 · Décision d'orientation (aucun code — le découpage en lots suivra via
`/pmz:scope`). Contexte : un backlog peut compter plusieurs dizaines de lots ; aujourd'hui PMZ
gouverne strictement **une** session à la fois (un seul lot `in_progress`, handoff mono-session).
Question posée : PMZ peut-il **missionner, coordonner et réintégrer** plusieurs sessions filles en
parallèle pour accélérer les gros chantiers — sans sacrifier la traçabilité ni exploser en
conflits de merge ?

## Décision : **GO — palier 2 d'abord, palier 3 conditionné**

On vise la parallélisation **gouvernée** (palier 2 : N sessions Claude Code réelles, chacune avec
le protocole PMZ complet), avec le palier 3 (orchestrateur autonome) comme cible différée dont les
conditions d'entrée sont définies ici. Le fan-out éphémère (palier 1 : outil `Workflow` du
harness) reste disponible tel quel pour paralléliser *l'intérieur* d'un lot — hors périmètre PMZ,
rien à construire.

Le principe directeur, non négociable : **on n'élimine pas les conflits à la réintégration, on
les rend impossibles au découpage**. Tout le design découle de ce renversement.

## Les trois paliers (rappel)

1. **Fan-out éphémère** — sous-agents sans état dans un lot. Déjà couvert par le harness
   (`Workflow`, worktrees). PMZ n'y touche pas.
2. **Multi-sessions coordonnées** — N lots du backlog avancent en parallèle, chacun dans une
   vraie session (handoff, changelog, commit, clôture PMZ). **C'est le scope de cette décision.**
3. **Orchestrateur autonome** — PMZ découpe, lance, surveille et réintègre seul, l'humain valide
   aux frontières de vague. Cible long terme (cf. mémoire projet « vision orchestrateur »).

## Principes de conception (dans l'ordre d'efficacité)

### P1 — Périmètre exclusif contractualisé (élimine les conflits git textuels)

Chaque lot parallélisable déclare **avant lancement** la liste des chemins (globs) qu'il a le
droit de modifier. Deux garanties mécaniques :

- **Au découpage** : une vague parallèle n'est valide que si les périmètres des lots sont
  **disjoints** (intersection vide). Deux lots sur le même module → séquentiel, sans négociation.
- **En vol** : le hook PreToolUse de chaque session fille **refuse toute écriture hors
  périmètre** (verdict `deny` + message expliquant le périmètre). L'agent qui déborde n'est pas
  rappelé à l'ordre a posteriori : l'écriture est bloquée au moment où il la tente.

Le conflit git devient structurellement impossible entre lots d'une même vague — contrainte
outillée, pas discipline.

### P2 — Gel des interfaces frontières (élimine les conflits sémantiques)

Deux lots à périmètres disjoints peuvent casser un contrat commun (l'un renomme ce que l'autre
consomme). Parade : avant le fan-out, un **lot préliminaire séquentiel court** fige les
interfaces frontières (signatures, schémas JSON, formats de fichiers partagés). Ces
fichiers-contrats sont en **lecture seule pour toute la vague** (dans le périmètre de personne) ;
chaque session fille reçoit le contrat dans son brief et code *contre lui*, pas contre l'état
mouvant du code des autres. (Même patron que le « seam de persistance » posé au jour 1 des
projets : l'interface d'abord, les implémentations en parallèle derrière.)

### P3 — Réintégration en pipeline, jamais en big-bang (rend le résidu détectable et attribuable)

- **Merge séquentiel dans l'ordre du graphe de dépendances** : lot A → typecheck+tests → lot B →
  typecheck+tests… Si ça casse à l'étape B, le coupable est B, sans ambiguïté.
- **Rebase continu** : dès qu'un lot est réintégré, les lots encore en vol rebasent sur la
  branche d'intégration (signal transmis via l'état partagé, cf. « fleet » ci-dessous).
- **Gate final** : la vague n'est close que quand la branche d'intégration passe
  typecheck + tests + build — « fait = prouvé » appliqué à la *fusion*, pas aux branches isolées.

### P4 — Résidus irréductibles : convertis en événements gérés

| Problème | Mitigation (pas d'élimination possible) |
|---|---|
| Découpage initial faux (dépendance non vue) | Le hook P1 le révèle immédiatement : la session fille bloquée demande une **extension de périmètre** → arbitrage (accord, ou requalification en séquentiel). Erreur de planification = événement en vol, pas surprise au merge. |
| Qualité hétérogène entre sessions | Chaque lot garde la clôture PMZ complète (vérif, changelog, commit). Plus lent qu'un fan-out brut — prix assumé de la traçabilité. |
| Humain goulot de validation | Vagues de **3-4 lots max**. Les vigies (lot #75, notifications OS) signalent chaque clôture prête. |

## Architecture cible (palier 2) — extensions des organes existants

Contrainte transversale : les organes PMZ sont des **hooks Node zéro-dépendance** — ils ne
parlent qu'au disque et au contexte injecté. Le canal de coordination est donc **un état partagé
sur disque + l'injection SessionStart/UserPromptSubmit** de chaque session fille (déterministe,
compatible avec les deux canaux de déploiement, y compris `CLAUDE_PLUGIN_DATA`). Les outils
inter-sessions du harness (`send_message`, worktrees) sont utilisables *côté modèle* par la
session-orchestratrice, jamais requis côté hooks.

| Composant | Base existante | Extension |
|---|---|---|
| **Schéma backlog v2** | `.vibe-agent/backlog.json` (`lib/backlog.js`) | Deux champs par lot : `perimeter` (globs de chemins autorisés) et `depends_on` (ids de lots). Rétro-compatible : absents = lot séquentiel classique. |
| **Multi-`in_progress`** | `startLot` **rétrograde** tout autre lot `in_progress` (hypothèse mono-session câblée) | Autoriser N lots `in_progress` **si et seulement si** chacun porte un `session_owner` distinct et un périmètre disjoint. Sans fleet actif, comportement actuel inchangé. |
| **Registre de vague (« fleet »)** | `lib/occupancy.js` + fichiers d'état par session (`stateFileFor`) | `.vibe-agent/fleet.json` : lots en vol, session propriétaire, branche/worktree, périmètre, état (en vol / prêt à merger / réintégré), tête de la branche d'intégration (déclencheur de rebase). |
| **Hook de périmètre** | PreToolUse existant (`hooks/pre-tool-use.js`) — aujourd'hui **limité à `Bash`** (décision ARCHITECTURE « on ne gêne pas Read/Edit ») | **Révision assumée et scopée** : en présence d'un fleet actif où la session courante est fille, PreToolUse s'étend à `Edit`/`Write` pour le seul test d'appartenance au périmètre. Hors fleet : comportement actuel intact. Fail-open préservé : `deny` uniquement sur certitude (chemin résolu hors globs) ; toute erreur/ambiguïté → `allow`. |
| **`pmz:parallelize`** | `lib/backlog.js`, `scripts/backlog.js` | Lit le backlog, calcule les vagues (périmètres disjoints + `depends_on`), propose le **plan de vagues** avec branches et périmètres. **N'ouvre rien seul** : validation humaine, lancement des sessions filles manuel au début. |
| **`pmz:reintegrate`** | `lib/gitdebt.js`, discipline `/close-batch` | Merge pipeline (P3) : ordre du graphe, gate typecheck+tests à chaque étape, changelog **agrégé** de la vague, mise à jour de `fleet.json` (déclenche les rebases des lots en vol). |
| **Handoff de vague** | `lib/handoff.js` (mono-session) | Le handoff par session subsiste ; `fleet.json` **est** le handoff partagé de la vague (pas de duplication). |
| **Signal** | `lib/notify.js` (vigies #75) | Notification OS quand un lot fille est prêt à merger et quand une vague est close. |

## Palier 3 — conditions d'entrée (pas de date)

Le palier 3 n'ajoute pas de mécanisme : il **déplace la validation humaine** du lancement de
chaque vague vers les frontières (plan initial + gate final). Conditions pour l'ouvrir :

1. Palier 2 rodé : **≥ 3 vagues réelles** réintégrées sans conflit git ni casse au gate.
2. Extensions de périmètre en vol **rares** (< 1 par vague en moyenne) — sinon le découpage
   automatique n'est pas mûr, et l'automatiser l'aggraverait.
3. Vigies capables de porter tout le signal (l'humain n'a plus besoin de surveiller les sessions,
   seulement de répondre aux notifications).

Tant que ces trois conditions ne sont pas mesurées, toute demande « orchestrateur autonome » est
requalifiée en palier 2.

## Risques & garde-fous

- **Fail-open vs `deny` de périmètre** : pas de contradiction — le `deny` P1 est un *verdict de
  gouvernance* (comme les verdicts PreToolUse existants), pas une erreur. La doctrine reste :
  erreur/timeout/doute → `allow` silencieux ; jamais d'`exit 2`.
- **Révision de « PreToolUse limité à Bash »** : strictement scopée au mode fleet-fille. Le coût
  (friction sur Edit/Write) n'est payé que par les sessions qui bénéficient de la garantie.
- **Zéro dépendance / cross-platform** : fleet.json = JSON plat via `lib/fsjson.js` ; matching de
  globs en stdlib (pas de lib de glob) ; git en chemin absolu (`lib/env.js`). Rien de neuf.
- **Concurrence d'écriture sur `fleet.json`** : N sessions écrivent le même fichier — écritures
  atomiques (write-temp + rename) et champ par session pour minimiser les fenêtres de course ;
  en cas de JSON corrompu, fail-open (le fleet se désactive, les sessions redeviennent
  autonomes).
- **Coût de contexte** : l'injection fleet dans chaque session fille doit rester **courte**
  (périmètre + contrat + tête d'intégration), jamais le plan complet de la vague.

## Ce qui reste ouvert (à trancher au découpage)

- Lancement des sessions filles : manuel (l'utilisateur ouvre les onglets sur le plan proposé)
  au palier 2 ; l'automatisation du spawn est un choix du palier 3, pas avant.
- Worktrees : un worktree par lot fille (isolation forte, coût disque) vs branches simples dans
  le même arbre (léger, mais interdit deux lots build-and-run simultanés). Pressenti : worktree,
  à valider sur la première vague réelle.
- Granularité des globs de périmètre : par dossier (simple, gros grain) vs par fichier (précis,
  fragile aux créations de fichiers). Pressenti : dossier + liste d'exceptions.

## Découpage pressenti (indicatif — à passer par `/pmz:scope`)

1. Schéma backlog v2 (`perimeter`, `depends_on`, multi-`in_progress` gardé) + migration douce.
2. `fleet.json` : format, écritures atomiques, lecture par les hooks, injection courte.
3. Hook de périmètre (PreToolUse étendu en mode fleet-fille) + demande d'extension arbitrée.
4. `pmz:parallelize` : calcul de vagues + plan proposé (sans lancement).
5. `pmz:reintegrate` : pipeline de merge + gates + changelog agrégé + signal de rebase.
6. Vigies de vague (extension `lib/notify.js`).

Chaque brique est utile seule (1-2 améliorent déjà le backlog mono-session) ; l'ordre minimise le
risque : la garantie (3) existe avant le premier plan de vague (4), la réintégration (5) avant la
première vague réelle.
