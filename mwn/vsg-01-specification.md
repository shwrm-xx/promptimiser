# Fichier 1 — Spécification initiale consolidée

# Vibe Session Governor

## 1. Intention

`Vibe Session Governor` est un système local de gouvernance pour sessions de vibecoding, pensé d’abord pour **Claude Code en version client lourd / desktop**.

Il doit fonctionner comme un garde-fou automatique, pas comme une simple checklist manuelle.

Son rôle n’est pas de coder à la place de Claude Code, mais de :

1. **initialiser proprement les nouveaux projets** ;
2. **réduire la consommation de tokens liée à la relecture du contexte** ;
3. **forcer une clôture de lot propre** ;
4. **fournir un delta compatible Codex via `AGENTS.md`**.

---

## 2. Problème à résoudre

Dans une session de vibecoding, le coût et la dérive viennent surtout de :

- fichiers relus plusieurs fois alors qu’ils n’ont pas changé ;
- contexte stable réinjecté à chaque tour ;
- sessions trop longues qui accumulent de l’historique ;
- prompts trop larges qui poussent le LLM à scanner tout le projet ;
- vérifications exhaustives au lieu de vérifications ciblées ;
- lots non clôturés : pas de changelog, pas de commit, pas de handoff ;
- initialisation de projet dépendante de la discipline utilisateur.

Le système doit donc rendre ces règles **automatiques**, surtout dans Claude Code desktop.

---

## 3. Hiérarchie des objectifs

```txt
Objectif 1 — Économie de contexte
Réduire les tokens relus, les cache reads, les relectures de fichiers, les sessions longues et les handoffs trop lourds.

Objectif 2 — Qualité de lot
Garantir que chaque lot est prouvé, documenté, changeloggé, committé et transférable à une session fraîche.

Objectif 3 — Initialisation projet
Créer automatiquement le socle CLAUDE.md / AGENTS.md / .vibe-agent / CHANGELOG.md quand un nouveau projet est ouvert.
```

La règle d’arbitrage est simple :

```txt
La qualité reste obligatoire,
mais elle doit être obtenue par le chemin le moins coûteux en contexte.
```

---

## 4. Cible principale

### Claude Code

Cible prioritaire.

Le système doit utiliser :

- configuration globale utilisateur ;
- hooks globaux ;
- skill globale ;
- bootstrap automatique prudent ;
- scripts locaux rapides, sans dépendance externe.

### Codex

Cible secondaire, en delta uniquement.

Le système doit fournir :

- `AGENTS.md` projet ;
- éventuellement `~/.codex/AGENTS.md` global ;
- skill optionnelle ;
- wrapper shell optionnel ;
- pas de tentative de reproduire toute la mécanique de hooks Claude Code.

---

## 5. Architecture logique

```txt
Vibe Session Governor
├─ Project Initializer
│  ├─ détecte projet neuf / non initialisé
│  ├─ crée CLAUDE.md minimal
│  ├─ crée AGENTS.md minimal
│  ├─ crée .vibe-agent/
│  └─ crée CHANGELOG.md si absent
│
├─ Context Budget Controller
│  ├─ surveille fichiers lus
│  ├─ détecte relectures inutiles
│  ├─ recommande rg / git diff / lecture partielle
│  ├─ alerte sur sessions longues
│  └─ recommande session fraîche
│
└─ Batch Quality Controller
   ├─ vérifie demande littérale
   ├─ évite scope creep
   ├─ force vérification ciblée
   ├─ impose CHANGELOG
   ├─ impose commit
   └─ produit handoff court
```

---

## 6. Architecture fichiers globale

À installer dans l’espace utilisateur :

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

## 7. Comportement attendu dans Claude Code desktop

### Projet déjà initialisé

Au démarrage d’une session :

```txt
Vibe Session Governor actif.
Priorité : réduire les relectures de contexte.
Utilise rg/git diff avant Read complet.
Clôture chaque lot par vérif ciblée + changelog + commit + handoff court.
```

### Projet non initialisé

Au démarrage d’une session :

```txt
Projet non initialisé détecté.
Bootstrap prudent Vibe Session Governor créé.
Avant de coder : finaliser CLAUDE.md/AGENTS.md avec lecture minimale, puis proposer un premier lot court.
```

Le bootstrap prudent peut créer :

```txt
CLAUDE.md
AGENTS.md
CHANGELOG.md
.vibe-agent/
```

Mais il ne doit jamais modifier automatiquement le code applicatif.

---

## 8. Hooks Claude Code

### `SessionStart`

Rôle :

- détecter le projet courant ;
- vérifier s’il est initialisé ;
- créer un bootstrap prudent si absent ;
- injecter un rappel court ;
- ne jamais scanner tout le repo.

### `UserPromptSubmit`

Rôle :

- détecter les demandes trop larges ;
- détecter les prompts de création ou d’initialisation de projet ;
- recommander un lot court ;
- rappeler l’économie de contexte ;
- injecter “initialiser avant de coder” si projet neuf.

### `PreToolUse`

Matcher :

```txt
Read|Bash|Edit|Write
```

Rôle :

- alerter sur relecture complète injustifiée ;
- alerter sur lecture de gros fichiers ;
- recommander `rg`, `git diff`, lecture partielle ;
- bloquer ou demander confirmation pour commandes destructrices ;
- empêcher modification applicative dans un projet non initialisé sauf demande explicite.

### `PostToolUse`

Matcher :

```txt
Read|Edit|Write
```

Rôle :

- mettre à jour les ledgers ;
- enregistrer fichiers lus, modifiés, relus ;
- détecter les lectures répétées.

### `Stop`

Rôle :

- si fichiers modifiés sans changelog/commit/handoff : alerter ;
- recommander clôture de lot ;
- recommander session fraîche si la session gonfle ;
- ne pas faire de vérification exhaustive.

---

## 9. Fichiers projet générés

### `CLAUDE.md`

Doit rester court, car il est chargé à chaque session.

Contenu attendu :

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

### `AGENTS.md`

Pour Codex et autres agents de code.

Contenu attendu :

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

---

## 10. Règles de budget contexte

Fichier `.vibe-agent/rules.yaml` :

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

---

## 11. Définition de “lot fini”

Un lot est fini uniquement si :

```txt
- la demande littérale est traitée ;
- le scope creep est évité ;
- une vérification ciblée est faite ;
- les erreurs / zones non vérifiées sont listées ;
- CHANGELOG.md est mis à jour ;
- les docs stables sont mises à jour si nécessaire ;
- un commit existe ;
- un handoff court est produit ;
- une session fraîche est recommandée.
```

---

## 12. Livrables attendus

Le système complet doit produire :

```txt
1. Arborescence globale ~/.claude/vibe-session-governor/
2. Skill globale Claude Code
3. Hooks globaux Claude Code
4. Installateur macOS double-clic
5. Désinstallateur macOS double-clic
6. Doctor macOS double-clic
7. Templates projet
8. Scripts Node.js sans dépendance externe
9. Documentation courte
10. Delta Codex
```

---

## 13. Ce qu’il ne faut pas faire

```txt
- Ne pas créer deux agents séparés.
- Ne pas dépendre de slash commands manuelles.
- Ne pas scanner tout le repo automatiquement.
- Ne pas modifier automatiquement le code applicatif.
- Ne pas créer un CLAUDE.md énorme.
- Ne pas créer un AGENTS.md énorme.
- Ne pas reproduire les hooks Claude Code côté Codex.
- Ne pas faire de vérification exhaustive par défaut.
```

---

## 14. Résumé de la stratégie

```txt
Claude Code desktop
= auto complet : hooks globaux + skill globale + bootstrap prudent.

Codex
= compatible : AGENTS.md + skill + wrapper optionnel.

Slash commands
= secours manuel, pas cœur du système.
```
