# Fichier 2 — Prompt complet d’implémentation

Copie-colle ce prompt dans Claude Code pour demander la création du système.

---

# Prompt

Crée un système local nommé `vibe-session-governor`.

## Contexte utilisateur

L’utilisateur utilise principalement la version client lourd / application desktop de Claude Code.

Il ne faut donc pas concevoir un workflow dépendant de slash commands manuelles ou de manipulations terminal répétées.

Le système doit :

- s’installer une fois ;
- se configurer globalement ;
- s’activer automatiquement sur tous les projets ouverts dans Claude Code ;
- initialiser les nouveaux projets en mode prudent ;
- réduire prioritairement les relectures de contexte ;
- forcer une clôture propre des lots.

## Objectif général

Créer un système Claude Code global, auto-actif, qui optimise les sessions de vibecoding.

## Priorités

### 1. Réduire la consommation de tokens liée à la relecture du contexte

Le système doit limiter :

- les cache reads ;
- les fichiers relus inutilement ;
- les sessions longues qui gonflent ;
- les lectures complètes évitables ;
- les handoffs trop longs ;
- les vérifications exhaustives.

Le système doit préférer :

- `git status` ;
- `git diff` ;
- `rg` ;
- lecture partielle ;
- résumé local ;
- vérification ciblée ;
- handoff court ;
- session fraîche.

### 2. Garantir la qualité de clôture des lots

Le système doit forcer :

- traitement strict de la demande littérale ;
- absence de feature bonus ;
- vérification ciblée ;
- mise à jour de `CHANGELOG.md` ;
- mise à jour documentaire si nécessaire ;
- commit par lot ;
- liste explicite de ce qui n’a pas été vérifié ;
- handoff court.

### 3. Initialiser automatiquement les nouveaux projets

Le système doit créer en mode prudent :

- `CLAUDE.md` ;
- `AGENTS.md` ;
- `.vibe-agent/` ;
- ledgers de contexte ;
- `CHANGELOG.md` si absent.

Il ne doit jamais modifier automatiquement le code applicatif.

## Cible principale

Claude Code.

## Codex

Uniquement en delta :

- `AGENTS.md` global/projet ;
- skill optionnelle ;
- wrapper shell éventuel ;
- ne pas tenter de reproduire les hooks Claude Code côté Codex.

---

# Architecture globale à créer

```txt
~/.claude/
├─ settings.json
├─ skills/
│  └─ vibe-session-governor/
│     └─ SKILL.md
└─ vibe-session-governor/
   ├─ install/
   │  ├─ install.command
   │  ├─ uninstall.command
   │  └─ vsg-doctor.command
   ├─ hooks/
   │  ├─ session-start.js
   │  ├─ user-prompt-submit.js
   │  ├─ pre-tool-use.js
   │  ├─ post-tool-use.js
   │  └─ stop.js
   ├─ scripts/
   │  ├─ detect-project.js
   │  ├─ bootstrap-project.js
   │  ├─ audit-context.js
   │  ├─ audit-batch.js
   │  └─ close-batch.js
   └─ templates/
      ├─ CLAUDE.md
      ├─ AGENTS.md
      ├─ ARCHITECTURE.md
      ├─ CHANGELOG.md
      ├─ rules.yaml
      └─ handoff-template.md
```

Dans chaque projet initialisé :

```txt
projet/
├─ CLAUDE.md
├─ AGENTS.md
├─ CHANGELOG.md
└─ .vibe-agent/
   ├─ rules.yaml
   ├─ context-ledger.json
   ├─ read-ledger.json
   └─ session-state.json
```

---

# Exigences générales

- Scripts Node.js sans dépendance externe.
- Pas de `sudo`.
- Pas de modification automatique du code applicatif.
- Pas de scan massif du projet.
- Pas de fichiers automatiquement chargés trop longs.
- Les hooks doivent être rapides, silencieux sauf alerte utile, et économes en tokens.
- Les slash commands sont secondaires : le système doit tourner automatiquement.
- Si un fichier existe déjà, ne pas l’écraser brutalement.
- En cas de conflit, préserver l’existant et ajouter une section clairement délimitée ou produire une alerte.
- Tous les scripts doivent être robustes sur macOS.
- Les chemins contenant des espaces doivent être supportés.

---

# Skill globale Claude Code

Créer :

```txt
~/.claude/skills/vibe-session-governor/SKILL.md
```

La skill doit se déclencher implicitement sur :

- nouveau projet ;
- init projet ;
- scaffold ;
- setup Claude Code ;
- optimisation session ;
- économie de tokens ;
- cache read ;
- relecture contexte ;
- coût tokens ;
- clôture de lot ;
- changelog ;
- commit ;
- handoff ;
- session fraîche.

Le `SKILL.md` doit contenir :

- description courte ;
- procédure d’initialisation projet ;
- procédure budget contexte ;
- procédure clôture de lot ;
- règles d’arbitrage ;
- définition de “fini” ;
- delta Codex.

Ne pas rendre le `SKILL.md` inutilement énorme.

---

# Hooks globaux Claude Code

Installer les hooks dans :

```txt
~/.claude/settings.json
```

Avant modification, sauvegarder l’ancien fichier sous :

```txt
~/.claude/settings.vsg-backup-YYYYMMDD-HHMMSS.json
```

Fusionner les hooks VSG sans supprimer les settings existants.

## 1. Hook `SessionStart`

Matcher :

```txt
startup|resume
```

Script :

```txt
~/.claude/vibe-session-governor/hooks/session-start.js
```

Rôle :

- détecter le projet courant ;
- vérifier s’il est initialisé ;
- créer le bootstrap prudent si absent ;
- injecter un rappel très court ;
- ne jamais lire tout le projet.

## 2. Hook `UserPromptSubmit`

Script :

```txt
~/.claude/vibe-session-governor/hooks/user-prompt-submit.js
```

Rôle :

- détecter les prompts de création ou initialisation de projet ;
- détecter les demandes trop larges ;
- recommander un lot court ;
- injecter la priorité d’économie de contexte ;
- rappeler d’initialiser avant de coder si le projet est neuf.

## 3. Hook `PreToolUse`

Matcher :

```txt
Read|Bash|Edit|Write
```

Script :

```txt
~/.claude/vibe-session-governor/hooks/pre-tool-use.js
```

Rôle :

- alerter ou bloquer une relecture complète injustifiée ;
- alerter sur les lectures de gros fichiers ;
- recommander `rg`, `git diff`, lecture partielle ;
- bloquer ou demander confirmation pour commandes destructrices ;
- empêcher une modification applicative dans un projet non initialisé sauf demande explicite.

## 4. Hook `PostToolUse`

Matcher :

```txt
Read|Edit|Write
```

Script :

```txt
~/.claude/vibe-session-governor/hooks/post-tool-use.js
```

Rôle :

- mettre à jour `.vibe-agent/read-ledger.json` ;
- mettre à jour `.vibe-agent/context-ledger.json` ;
- enregistrer fichiers lus, modifiés, relus ;
- détecter les lectures répétées.

## 5. Hook `Stop`

Script :

```txt
~/.claude/vibe-session-governor/hooks/stop.js
```

Rôle :

- si fichiers modifiés et pas de changelog/commit/handoff, injecter une alerte courte ;
- recommander clôture de lot ;
- recommander session fraîche si la session gonfle ;
- ne pas faire de vérification exhaustive.

---

# Exemple de configuration attendue dans `~/.claude/settings.json`

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/vibe-session-governor/hooks/session-start.js",
            "timeout": 10
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/vibe-session-governor/hooks/user-prompt-submit.js",
            "timeout": 5
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Read|Bash|Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/vibe-session-governor/hooks/pre-tool-use.js",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Read|Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/vibe-session-governor/hooks/post-tool-use.js",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/vibe-session-governor/hooks/stop.js",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

---

# Installateur

Créer :

```txt
~/.claude/vibe-session-governor/install/install.command
```

Exigences :

- exécutable par double-clic macOS ;
- ne demande pas `sudo` ;
- crée les dossiers nécessaires ;
- copie les hooks, scripts, templates et skill ;
- sauvegarde `~/.claude/settings.json` avant modification ;
- fusionne les hooks sans supprimer les réglages existants ;
- rend les scripts `.js` exécutables ;
- lance `vsg-doctor.command` à la fin ;
- affiche un résumé lisible.

---

# Désinstallateur

Créer :

```txt
~/.claude/vibe-session-governor/install/uninstall.command
```

Exigences :

- retire les hooks VSG de `~/.claude/settings.json` ;
- ne supprime pas les autres settings Claude Code ;
- conserve une sauvegarde ;
- propose de conserver ou supprimer `~/.claude/vibe-session-governor/` ;
- ne touche jamais aux projets.

---

# Diagnostic

Créer :

```txt
~/.claude/vibe-session-governor/install/vsg-doctor.command
```

Il doit vérifier :

- existence de `~/.claude/settings.json` ;
- hooks VSG installés ;
- skill globale présente ;
- scripts exécutables ;
- projet courant initialisé ou non ;
- présence de `.vibe-agent/` si lancé depuis un repo ;
- statut vert/orange/rouge.

Sortie attendue :

```txt
Vibe Session Governor — diagnostic

Claude settings : OK
Hooks globaux : OK
Skill globale : OK
Scripts exécutables : OK
Projet courant : initialisé / non initialisé

Statut : vert / orange / rouge
```

---

# Scripts à créer

## `detect-project.js`

Doit détecter :

- racine git ;
- présence de `.vibe-agent/` ;
- présence de `CLAUDE.md` ;
- présence de `AGENTS.md` ;
- présence de `CHANGELOG.md` ;
- type de projet probable via fichiers manifestes.

Ne doit jamais lire tout le repo.

Commandes autorisées :

```txt
git rev-parse --show-toplevel
git status --short
ls
```

Lecture de manifestes évidents seulement :

```txt
package.json
pyproject.toml
Cargo.toml
go.mod
README.md si court
CLAUDE.md
AGENTS.md
```

## `bootstrap-project.js`

Mode bootstrap prudent :

- créer `.vibe-agent/` si absent ;
- créer `.vibe-agent/rules.yaml` ;
- créer `.vibe-agent/context-ledger.json` ;
- créer `.vibe-agent/read-ledger.json` ;
- créer `.vibe-agent/session-state.json` ;
- créer `CLAUDE.md` minimal si absent ;
- créer `AGENTS.md` minimal si absent ;
- créer `CHANGELOG.md` si absent ;
- ne pas modifier le code applicatif ;
- ne pas écraser README ou ARCHITECTURE existants.

## `audit-context.js`

Doit produire une sortie Markdown courte :

```md
## Économie de contexte

Statut : vert | orange | rouge

Lectures évitables :
- ...

Fichiers déjà connus :
- ...

Action la moins coûteuse :
- utiliser git diff
- utiliser rg
- lire uniquement tel bloc
- clôturer le lot
```

## `audit-batch.js`

Doit vérifier :

- fichiers modifiés ;
- demande littérale probable ;
- présence d’une entrée `CHANGELOG.md` ;
- présence ou absence de commit récent ;
- besoin de mise à jour README/ARCHITECTURE ;
- preuve de vérification déclarée ou absente.

## `close-batch.js`

Doit produire :

```md
## Clôture du lot

Checklist :
- Demande littérale traitée : oui/non
- Scope creep évité : oui/non
- Vérification ciblée faite : oui/non
- Console/tests/lint selon contexte : oui/non/non applicable
- README mis à jour : oui/non/non applicable
- ARCHITECTURE mis à jour : oui/non/non applicable
- CHANGELOG mis à jour : oui/non
- Commit fait : oui/non
- Non vérifié explicitement listé : oui/non

## Économie de contexte

- lectures évitées :
- relectures faites :
- contexte redondant probable :
- session fraîche recommandée :
- raison :

Décision :
- clôturable
- non clôturable
```

---

# Templates projet

## Template `CLAUDE.md`

```md
# CLAUDE.md — règles projet

Ce fichier doit rester court : il est chargé à chaque session.

## Projet
À compléter par Claude avec lecture minimale.

## Priorité 1 — économie de contexte
- Ne pas relire un fichier déjà lu s’il n’a pas changé.
- Préférer `git diff`, `git status`, `rg`, lectures partielles et résumés locaux.
- Éviter les sessions longues.
- Un lot terminé doit produire un handoff court puis une session fraîche.

## Priorité 2 — qualité de lot
- Coller à la demande littérale.
- Ne pas ajouter de feature bonus.
- Vérifier uniquement ce qui a changé.
- Mettre à jour `CHANGELOG.md`.
- Un lot = un commit.

## Définition de “fini”
- demande traitée ;
- preuve ciblée ;
- erreurs ou zones non vérifiées listées ;
- changelog à jour ;
- commit fait ;
- handoff court produit.
```

## Template `AGENTS.md`

```md
# AGENTS.md — instructions agents de code

## Objectif
Travailler par petits lots avec consommation minimale de contexte.

## Avant de modifier
- Utiliser `git status`, `git diff`, `rg` avant de lire de gros fichiers.
- Lire uniquement les fichiers nécessaires.
- Ne pas élargir le périmètre sans demande explicite.

## Pendant le travail
- Modifier le moins de fichiers possible.
- Respecter les conventions existantes.
- Ne pas ajouter de dépendance sans justification.

## Vérification
- Vérifier uniquement ce qui a changé.
- Pour une UI : rendu réel ou test ciblé.
- Pour une API : test endpoint ou test unitaire ciblé.
- Pour du contenu : contrôle cohérence et rendu si applicable.

## Fin de lot
- Mettre à jour `CHANGELOG.md`.
- Faire un commit.
- Produire un handoff court.
```

## Template `.vibe-agent/rules.yaml`

```yaml
agent:
  name: vibe-session-governor
  primary_objective: reduce_context_reread_cost
  secondary_objective: close_batches_cleanly

budget:
  warn_after_session_turns: 12
  recommend_fresh_session_after_turns: 20
  max_repeated_reads_per_file: 1
  max_handoff_tokens: 800
  max_claude_md_tokens: 1200
  max_agents_md_tokens: 1200

context_policy:
  prefer:
    - git_status
    - git_diff
    - rg_search
    - partial_read
    - local_summary
  avoid:
    - full_file_reread
    - broad_project_scan
    - exhaustive_visual_recapture
    - long_handoff
    - duplicated_rules
  exceptions:
    - file_changed_since_last_read
    - previous_read_was_partial
    - exact_content_required_for_bug
    - user_explicitly_requests_full_review

closure_policy:
  one_batch_equals_one_commit: true
  require_changelog: true
  require_targeted_verification: true
  require_unverified_items: true
  recommend_fresh_session_after_commit: true
```

## Template `.vibe-agent/context-ledger.json`

```json
{
  "session_id": null,
  "files_read": {},
  "files_modified": {},
  "repeated_reads": [],
  "estimated_context_waste": null,
  "warnings": []
}
```

## Template `.vibe-agent/read-ledger.json`

```json
{
  "reads": [],
  "summaries": {},
  "avoid_reread_notes": []
}
```

## Template `.vibe-agent/session-state.json`

```json
{
  "current_batch": null,
  "turn_count_estimate": 0,
  "batch_status": "not_started",
  "verification_status": "not_checked",
  "fresh_session_recommended": false
}
```

---

# Messages injectés par les hooks

## Projet déjà initialisé

```txt
Vibe Session Governor actif.
Priorité : réduire les relectures de contexte.
Utilise rg/git diff avant Read complet.
Clôture chaque lot par vérif ciblée + changelog + commit + handoff court.
```

## Projet non initialisé

```txt
Projet non initialisé détecté.
Bootstrap prudent Vibe Session Governor créé.
Avant de coder : finaliser CLAUDE.md/AGENTS.md avec lecture minimale, puis proposer un premier lot court.
```

## Alerte lecture

```txt
Lecture potentiellement coûteuse.
Ce fichier semble déjà connu ou non modifié.
Préférer rg, git diff ou lecture partielle sauf besoin exact.
```

## Alerte clôture

```txt
Lot modifié sans clôture complète.
Avant de continuer : vérification ciblée, CHANGELOG, commit, handoff court, session fraîche recommandée.
```

---

# Commandes Claude Code facultatives

Les slash commands sont secondaires, mais utiles en secours.

Créer si pertinent :

```txt
.claude/commands/budget.md
.claude/commands/check-context.md
.claude/commands/close-batch.md
.claude/commands/fresh-session.md
```

## `budget.md`

```md
Analyse l’état de la session avec priorité absolue à l’économie de contexte.

Ne relis pas de fichiers complets si `git status`, `git diff`, `rg` ou les ledgers `.vibe-agent/` suffisent.

Produis :
1. statut budget contexte ;
2. fichiers à éviter de relire ;
3. action la moins coûteuse ;
4. risque de session trop longue ;
5. recommandation : continuer / vérifier / clôturer / session fraîche.
```

## `check-context.md`

```md
Audite les risques de relecture inutile.

Utilise d’abord :
- git status
- git diff --stat
- .vibe-agent/context-ledger.json
- .vibe-agent/read-ledger.json

Ne propose une lecture complète que si elle est nécessaire.

Sortie courte :
- lectures évitables ;
- lectures justifiées ;
- prochaine action minimale ;
- alerte budget.
```

## `close-batch.md`

```md
Clôture le lot courant avec discipline.

Étapes :
1. Résumer la demande initiale.
2. Mapper chaque point demandé vers fait / non fait / non vérifié.
3. Vérifier seulement ce qui a changé.
4. Mettre à jour CHANGELOG.md si ce n’est pas fait.
5. Proposer ou créer un commit français court.
6. Produire un handoff de moins de 800 tokens.
7. Recommander une session fraîche.

Ne pas déclarer “fini” sans preuve.
```

## `fresh-session.md`

```md
Prépare une nouvelle session en minimisant le contexte.

Produis un handoff court :

## Handoff session fraîche

Objectif du lot terminé :
- ...

Fichiers modifiés :
- ...

Décisions prises :
- ...

Vérifications faites :
- ...

Non vérifié :
- ...

Dette restante :
- ...

Prochaine action recommandée :
- ...

Contrainte budget :
- ne pas relire les fichiers suivants sauf changement :
```

---

# Delta Codex

Créer ou documenter :

- `AGENTS.md` projet ;
- éventuellement `~/.codex/AGENTS.md` global ;
- éventuellement une skill Codex `vibe-session-governor` ;
- un wrapper optionnel `codex-vsg`.

Ne pas chercher à reproduire les hooks Claude Code côté Codex.

Le delta Codex doit dire :

- Codex utilise `AGENTS.md` comme instructions persistantes ;
- le projet reçoit le même socle de règles ;
- l’auto-activation complète reste portée par Claude Code ;
- pour se rapprocher du comportement Claude Code, utiliser un wrapper qui vérifie/crée `AGENTS.md` avant de lancer Codex.

---

# Livrables attendus

À la fin, fournir :

```txt
1. Arborescence créée.
2. Scripts Node.js sans dépendance externe.
3. Installateur macOS double-clic.
4. Désinstallateur macOS double-clic.
5. Doctor macOS double-clic.
6. Skill globale Claude Code.
7. Hooks globaux Claude Code.
8. Templates projet.
9. Documentation courte README.md du système.
10. Delta Codex séparé.
11. Aucun refactor applicatif.
12. Aucun scan massif de repo.
```

À la fin de l’installation :

- afficher les fichiers créés ;
- expliquer comment lancer `install.command` ;
- expliquer comment vérifier avec `vsg-doctor.command` ;
- expliquer le comportement attendu dans Claude Code client lourd ;
- proposer un commit.
