# ARCHITECTURE — Vibe Session Governor

Capture la couche **stable** et le non-greppable. Le code fait foi pour le détail volatil.

## Vue d'ensemble

VSG = un package installé dans `~/.claude/` qui branche **5 hooks Claude Code** + une **skill
globale** + des **slash commands** + des **scripts** + des **templates** + un **delta Codex**.
Le dépôt en est la source (miroir plat → `~/.claude/`, cf. [CLAUDE.md](CLAUDE.md)).

```
Vibe Session Governor
├─ Project Initializer      (session-start + bootstrap-project + /vsg-init)
├─ Context Budget Controller (occupancy.js : occupation par tokens, paliers, systemMessage)
└─ Batch Quality Controller  (stop + audit-batch + close-batch + ledgers)
```

## Contrat des hooks (source de vérité)

Hooks invoqués via `node ~/.claude/vibe-session-governor/hooks/<x>.js` (le `~` est développé
dans le champ `command` de `settings.json`). Stdin = JSON ; sortie = JSON sur stdout, exit 0.

| Hook | Event / matcher | Lit (stdin) | Émet | Rôle |
|------|-----------------|-------------|------|------|
| `session-start.js` | SessionStart `startup\|resume` | `cwd`, `source` | `additionalContext` | détecte projet, propose init, rappel court |
| `user-prompt-submit.js` | UserPromptSubmit | `prompt`, `cwd` | `additionalContext` | détecte init/large, anti-spam 1×/session |
| `pre-tool-use.js` | PreToolUse `Bash` | `tool_input.command` | `permissionDecision` allow/ask/deny | sûreté commandes |
| `post-tool-use.js` | PostToolUse `Read\|Edit\|Write` | `tool_input.file_path` | — (effet de bord ledgers) | journalise lectures/édits |
| `stop.js` | Stop | `stop_hook_active`, `transcript_path` | `systemMessage` | alerte coût + rappel clôture |

### Invariants NON négociables
1. **Fail-open** : toute erreur/timeout/JSON → `exit 0` ; jamais `exit 2` ; doute → `allow`.
   `try/catch` global + `uncaughtException`/`unhandledRejection` + watchdog `setTimeout`.
2. **Kill-switch** : `VSG_DISABLE=1` → `exit 0` en 1re ligne de chaque hook.
3. **Pas d'écriture auto** hors repo git initialisé ; **jamais d'écrasement** ; init après confirmation.
4. **PreToolUse étroit** : `deny`/`ask` sur denylist destructive ancrée + whitelist large ;
   aucun `ask` sur Read/Edit (respect `acceptEdits`).
5. **systemMessage** = canal des rappels : visible utilisateur, **non réinjecté** dans le contexte
   du modèle, **non bloquant** (technique reprise de `context-guard.py`).

## Flux de données

- **Occupation contexte** (`lib/occupancy.js`) : lit la dernière ligne `usage` du transcript
  (`input + cache_read + cache_creation`), compare aux paliers `[150k, 300k, 500k, 750k]`,
  anti-spam par session dans `~/.claude/vibe-session-governor/state/<sid>`. Aucune dépendance aux
  ledgers projet. → C'est la méthode reprise de l'ancien `context-guard.py`.
- **Ledgers projet** (`.vibe-agent/{read,context}-ledger.json`) : maintenus par `post-tool-use.js`
  (atomique `tmp`+`rename`, cap FIFO). Servent l'advisory `/check-context`. Granularité
  **per-fichier**, distincte de l'occupation globale.
- **État de clôture** (`.vibe-agent/session-state.json`) : keyé par `session_id` ; flag
  anti-spam du rappel de clôture par lot.

## Mapping source → cible & installation

`merge-settings.js` : parse strict (échec → **abort**), backup horodaté vérifié, fusion
**append-only par event** taguée par le chemin `vibe-session-governor/hooks/` (idempotente),
préserve `permissions`/`statusLine`/`enabledPlugins`. Prise de relais de `context-guard.py`
(`--takeover`) : commente/retire son entrée `Stop`, **réversible** (`--remove` restaure le
backup). Écriture atomique, perms 0600.

## Décisions & pourquoi

- **Occupation-tokens plutôt que compteur de tours** (vs spec) : signal réel, déjà éprouvé par
  `context-guard.py` ; VSG le reprend à son compte (système standalone unifié).
- **Stop non bloquant** : un Stop bloquant risque la boucle (cap 8) et gonfle le contexte ;
  `systemMessage` informe sans bloquer.
- **PreToolUse limité à `Bash`** : `acceptEdits` montre que l'utilisateur veut peu de
  confirmations ; on ne gêne pas Read/Edit.
- **Zéro dépendance / `node` via PATH** : précédent `python3` bare déjà fonctionnel dans les
  hooks de la machine ; fallback fail-open si `node` introuvable.
