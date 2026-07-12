# D1 — Spike : packaging Promptimizer en plugin Claude Code (verdict go/no-go)

Date : 2026-07-12 · Lot #30 (session jetable, **zéro code de portage mergé**).
CLI validé : Claude Code desktop **v2.1.205** (macOS). Tests en bac à sable
(`CLAUDE_CONFIG_DIR` temporaire) — le vrai `~/.claude` n'a **pas** été touché ni pollué.

## Verdict : **GO — staged** (portage recommandé, mais par étapes, avec 1 régression assumée)

Le mécanisme de plugin fonctionne **de bout en bout sur la machine réelle**. Le passage en
plugin supprime la plus grosse dette de PMZ (installeur cross-platform bespoke + fusion
fragile de `settings.json`) et apporte updates/versioning/marketplace natifs. Une seule
capacité est **perdue** en plugin (prise de relais réversible d'un hook Stop tiers) ; elle
est niche et documentable. → Voir « Décision » en fin de doc.

## Ce qui a été validé sur machine réelle (preuves)

| # | Point du scope | Résultat | Preuve |
|---|----------------|----------|--------|
| 1 | `plugin.json` | ✅ | `claude plugin validate` → *Validation passed* sur un `.claude-plugin/plugin.json` minimal. |
| 2 | `hooks.json` de plugin | ✅ | `hooks/hooks.json` (SessionStart+Stop) reconnu ; `plugin details` → *Hooks (2) SessionStart, Stop — harness-only, no model context cost*. |
| 3 | Marketplace locale | ✅ | `.claude-plugin/marketplace.json` + `claude plugin marketplace add ./market` → *Successfully added* ; `install promptimizer@pmz-local` → *installed (scope: user)*. |
| 4 | **Déclenchement réel du hook** | ✅ | Session headless sandbox → le hook **SessionStart a écrit son probe** (l'appel modèle a échoué faute d'auth, mais le hook tourne au niveau harness **avant** l'auth). |
| 5 | `require('../lib/…')` (lib voisine) | ✅ | Probe : `libFound: true`. L'arbre entier (`lib/`, `hooks/`, `commands/`, `skills/`) est copié/servi en préservant la structure. |
| 6 | `CLAUDE_PLUGIN_ROOT` au runtime | ✅ | Probe : présent **dans `process.env`** = racine du plugin. |
| 7 | `CLAUDE_PLUGIN_DATA` au runtime | ✅ | Probe : présent dans `process.env` = `…/plugins/data/<plugin-id>/` — **dossier d'état persistant qui survit aux updates**. |

### Corrections vs la doc / connaissances a priori (vérifiées, importantes pour D2)

- **`CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` SONT exposés en `process.env`** au runtime du
  hook (la doc laissait entendre le contraire : substitution textuelle seulement). En v2.1.205,
  les deux sont lisibles directement — un hook n'a pas besoin de recevoir le chemin en argument.
- **Source locale d'une marketplace = string relative**, pas un objet `{type:"relative-path"}`
  (rejeté par `validate`). Forme valide : `"source": "./plugins/promptimizer"`.
- **Plugin local (`relative-path`) exécuté in-place depuis la SOURCE**, pas depuis le cache copié
  (le probe voit `CLAUDE_PLUGIN_ROOT` = dossier source). Le cache versionné existe mais la source
  fait foi pour un plugin local — pertinent pour un dépôt de dev / marketplace interne montée en local.
- Les **`commands/*.md` sont assimilés à des skills** (unifiés) et **auto-découverts**, préfixés par
  le nom du plugin : `/budget` → **`/promptimizer:budget`**. Coût contexte always-on mesuré : **~21 tok**.

## Faisabilité proxy / git interne MH

- **Chemin zéro-réseau (recommandé pour MH)** : marketplace **locale** montée depuis un dossier
  (`claude plugin marketplace add /chemin/interne`) ou un **dépôt git local/interne**. Aucun accès
  externe requis — validé en sandbox. Un simple zip déposé sur un partage réseau + `add` local suffit.
  (À noter : l'app desktop elle-même se lance déjà avec des `--plugin-dir` locaux — mécanisme éprouvé.)
- **Chemin git interne (GitLab MH)** : `marketplace add https://gitlab.interne/…git` fonctionne si
  l'URL est joignable ; le git sous-jacent honore `HTTP(S)_PROXY`. Faisable, mais dépend de la
  config proxy poste — **le chemin local reste le plan de secours sûr**.
- **Bloquant réseau externe** : les sources `github` / `npm` (marketplace publique) supposent une
  sortie HTTPS. À **éviter** comme canal primaire en interne MH. → distribution interne = local/git-interne.

## Chiffrage du portage (pour cadrer D2/D3 — non réalisé ici)

Surface actuelle : 18 fichiers `install/`, 7 commands, 1 skill, câblage via `merge-settings.js`.
Le cœur du portage tient en **2 fichiers de code** ; le gros de l'effort est l'écosystème (installeur,
tests, doc, UX namespacing, migration legacy).

**Code (petit, ~2 fichiers) :**
1. `lib/claude-dir.js` — **découpler `stateDir()` de `pmzDir()`** : en plugin, l'état global doit
   viser `CLAUDE_PLUGIN_DATA` (persistant, survit aux updates), plus `pmzDir()=~/.claude/promptimizer`.
   `PMZ_STATE_DIR` (déjà supporté par `occupancy.js`/`merge-settings.js`) sert de point d'injection propre.
2. `install/merge-settings.js` — **remplacé par un `hooks/hooks.json` statique** (`node
   "${CLAUDE_PLUGIN_ROOT}/hooks/x.js"`). Toute la mécanique d'écriture dans `settings.json` disparaît.

**Écosystème (le vrai coût) :**
3. **`install/` (18 fichiers) largement obsolètes** : `claude plugin install` remplace
   `install.js/.command/.sh/.ps1`, `uninstall.*`, `package.*`. `doctor.*` à repositionner (ou
   `claude plugin details`). Grosse **simplification nette** à terme, mais migration à écrire.
4. **`test/run-tests.js`** — la partie `merge-settings` / layout `~/.claude` est à refondre pour
   le layout plugin (fail-open et verdicts hooks restent valides).
5. **UX namespacing** : `/budget` → `/promptimizer:budget` sur 7 commands. Doc + habitude à mettre à jour.
6. **Doc** (`README`, `ARCHITECTURE`, `CLAUDE.md`) : le modèle « miroir plat vers `~/.claude/` » n'est
   plus le canal primaire → réécriture des sections install/distribution.
7. **Coexistence / semver** (lot D3) : utilisateurs install-manuelle vs plugin ; éviter le double-firing
   des hooks (le `stripVsg`/tags existant aide au nettoyage legacy).

## Régression assumée (unique blocage dur)

**Prise de relais réversible d'un hook Stop tiers (`context-guard.py`)** : un plugin **ne peut pas
modifier le `settings.json` global** de l'utilisateur → la logique `--takeover`/restore de
`merge-settings.js` est **impossible en plugin**. Impact réel jugé **faible** (fonctionnalité niche).
Mitigation : la documenter comme non supportée en mode plugin, ou la réserver au canal install-manuelle
maintenu une version de transition.

Autres limitations plugin **sans impact** pour PMZ : pas de `statusLine` (PMZ n'en pose pas), pas de
modif arbitraire de `settings.json` (PMZ n'a besoin que de poser ses propres hooks).

## Décision

- **D2 (packaging plugin)** : construire le plugin (`.claude-plugin/plugin.json` + `hooks/hooks.json`
  + `.claude-plugin/marketplace.json` locale), découpler l'état vers `CLAUDE_PLUGIN_DATA`, accepter le
  namespacing `/promptimizer:*`. Canal de distribution interne MH = **marketplace locale / git interne**.
- **D3 (migration + semver)** : garder l'installeur manuel une version de transition, gérer la
  coexistence (anti double-firing), acter la perte du takeover `context-guard.py`.
- **No-go** uniquement si un utilisateur réel dépend du takeover Stop tiers **et** ne peut pas rester
  sur l'install manuelle — non constaté à ce jour.
