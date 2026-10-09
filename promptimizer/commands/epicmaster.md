---
description: Session maître — lance tous les lots ouverts du backlog en sous-agents (modèle préconisé) et consolide un handoff dette / à trancher
allowed-tools: Bash(node *), Bash(git *), Agent, Write
---

Tu es la **session maître** : tu ne codes pas, tu **lances** les lots ouverts du backlog en
**sous-agents** (outil Agent), chacun avec le **modèle et l'effort préconisés par le lot**, puis
tu **consolides** — commit et clôture par lot, CHANGELOG, et UN handoff final qui porte la
dette et ce qui reste à trancher. Les lots peuvent appartenir à une seule epic ou à plusieurs.

## 1. Plan et confirmation (UNE question, cases précochées)

`node ~/.claude/promptimizer/scripts/backlog.js epicmaster` (ajouter `--epic "…"` pour se limiter
à une epic ; `--max-parallel N` pour abaisser le plafond de sous-agents en vol).

Restitue la sortie **telle quelle** (elle est déjà mise en forme : une ligne alignée par lot
`[x] #id  titre  modèle · effort  ← vague`, détail indenté, ordre de lancement, budget et
**modèle préconisé pour toi**). Puis demande la confirmation en **UNE** fois, avec des **cases à
cocher précochées** — jamais une liste à retaper :

- **Si un outil de widget interactif est disponible** (`show_widget`) : rends un widget HTML
  **libre** (pas le formulaire d'elicitation, qui n'a pas de cases) avec de **vraies
  `<input type="checkbox" checked>`**. En tête, pour chaque epic embarquée : son **nom** et une
  **description courte** (une phrase, déduite des titres et « fait quand » de ses lots — jamais
  inventée au-delà). Puis **un bloc par vague** (« Vague N — k en parallèle » / « Vague N —
  série ») et **un lot par ligne** : case cochée (`value="#id"`), **titre** `#id titre`,
  **description** = le « fait quand » du lot, `modèle · effort` en sourdine. Un bouton « Lancer
  la sélection » appelle `sendPrompt("Lancer : #1, #2 · sans : #3")` à partir des cases ; zéro
  case cochée → erreur inline, pas d'envoi. Tout lot listé dans « sans » est décoché.
- **Sinon** (outil AskUserQuestion) : une question à choix multiples « Quels lots lancer ? »
  avec, en premier, « Tous les lots (Recommandé) », puis une option par lot « #id titre —
  modèle · effort » ; sélection = lancer. À défaut de tout outil : texte « Je lance ces lots
  tels quels ? Pour en décocher : « sans #12, #15 ». »

Si des lots sont décochés : relance avec `--skip 12,15`, réaffiche, et ne redemande que si un
lot est devenu **bloqué** (dépendance sur un lot décoché). N'embarque **jamais** un lot absent de
la sortie du script.

Si le script préconise un autre modèle que le tien pour la session maître, dis-le en une
ligne (`/model …`) avant de lancer — tu orchestres, tu n'as pas besoin de raisonner lourd.

## 2. Lancement, vague par vague

Pour **chaque vague** du plan, et **jamais plus de lots en vol que le parallélisme affiché** :
1. Pour chaque lot de la vague : `backlog.js epicmaster --brief --id <id>` → colle le brief
   **tel quel** dans le prompt de l'outil Agent, avec `model` = modèle préconisé du lot et
   `effort` = effort préconisé (les deux sont dans le brief ; ne les remplace jamais par les
   tiens). Démarre le lot : `backlog.js start --id <id> --owner "master/lot-<id>"` (un owner
   **distinct par lot**, sinon le second démarrage rétrograde le premier en « à faire »).
   Une vague à plusieurs lots = sous-agents lancés **en parallèle** (arrière-plan) ; une vague
   « série » = un seul sous-agent, attendu avant la suivante.
2. Attends le rapport de **tous** les sous-agents de la vague. Un rapport est ≤ 250 mots aux
   sections fixes (Fait / Fichiers modifiés / Verify / Non vérifié / Dette / À trancher / Bloc
   CHANGELOG). **Ne relis jamais** le transcript ni la sortie brute d'un sous-agent, ni les
   fichiers qu'il a modifiés : le rapport est ta seule source.
3. Pour chaque lot livré, **dans l'ordre du plan** (les commandes exactes sont données à la
   fin du brief) :
   - **Verify verte** → commit **borné au périmètre** (`git add -- ':(glob)…'`, ou `git add -A`
     pour un lot sans périmètre, seul en vol) + message français court, puis
     `backlog.js done --id <id> --commit "$(git rev-parse --short HEAD)" --verify-verdict ok`.
   - **Verify rouge ou absente** → **pas de commit** ; `backlog.js note --id <id> --note "verify
     rouge : <cause en une ligne>"` ; le lot reste ouvert et passe dans « À trancher ». Si la
     cause est triviale (< 5 min), relance **un** sous-agent de correction au même modèle, une
     seule fois.
   - Un sous-agent qui a écrit **hors de son périmètre** : ne commite pas ses écritures hors zone
     (`git checkout -- <chemin>` après confirmation), note-le, poursuis.
4. Ajoute au `CHANGELOG.md` une entrée datée par lot, reprise du « Bloc CHANGELOG » du rapport.

## 3. Vigilance contexte (non négociable)

- Le plan dit « au plus N lots par session maître ». **Arrête-toi** après la dernière vague de
  ta session : les lots restants restent ouverts, la session suivante les reprend avec
  `/epicmaster`.
- Si le hook Stop prescrit une session fraîche (zone rouge, budget de tours) **avant** la fin :
  termine la vague en cours (commits + `done`), consolide (étape 4) et **arrête-toi** — ne lance
  pas la vague suivante. Rien n'est perdu : le backlog porte l'état.
- Jamais de `git diff` complet, jamais de lecture des fichiers livrés « pour vérifier » : la
  preuve est la verify rejouée par le sous-agent et persistée par `done --verify-verdict`.

## 4. Consolidation finale

1. Fiche d'archive par lot clos : `node ~/.claude/promptimizer/scripts/archive.js write --id N
   --stdin` — les sections du rapport (Fait, Non vérifié, Dette, À trancher) se reportent telles
   quelles ; aucun diff ni contenu de fichier.
2. Handoff consolidé, modèle `~/.claude/promptimizer/templates/epicmaster-handoff.md`, écrit dans
   `.vibe-agent/handoff.md` (écrase ; garde la première ligne `<!-- pmz:handoff:manual -->`) :
   lots livrés (id + commit), lots restés ouverts et pourquoi, **Non vérifié** agrégé, **Dette
   consolidée** (une puce par item, lot d'origine entre parenthèses), **À trancher** (décisions
   qui attendent l'humain — jamais tranchées à sa place), prochaine action (lots restants →
   `/epicmaster` ; sinon « plan terminé »). Moins de 800 tokens.
3. Résume en 5 lignes à l'utilisateur : livrés / ouverts / à trancher / session fraîche
   recommandée (oui si des lots restent ou si le hook l'a prescrit).

Ne déclare jamais un lot « fait » sans verify verte rapportée **et** persistée.
