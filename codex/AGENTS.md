# AGENTS.md — Promptimizer (Codex)

Instructions persistantes pour agents de code (Codex et compatibles).
Même socle de règles que Claude Code, sans les hooks automatiques : le modèle applique
lui-même chaque garde-fou ci-dessous.

---

## 0. Démarrage de session

À chaque début de session, afficher en une ligne :

> Promptimizer actif. Priorité : réduire les relectures de contexte.
> Utilise git grep/git diff avant Read complet.
> Clôture chaque lot par vérif ciblée + changelog + commit + handoff court.

Puis vérifier si le projet est initialisé (présence de `.vibe-agent/`).
- **Absent** : proposer la création du socle (`CLAUDE.md`, `AGENTS.md`, `CHANGELOG.md`,
  `.vibe-agent/`) — ne rien créer sans confirmation explicite.
- **Présent** : rappeler le dernier handoff s'il existe (`.vibe-agent/session-state.json`).

---

## 1. Économie de contexte (à appliquer avant chaque lecture)

Hiérarchie stricte — passer à l'étape suivante seulement si la précédente est insuffisante :

1. `git status` / `git diff` / `git grep` — toujours en premier.
2. Lecture **partielle** (début, fin, ou section ciblée par numéro de ligne).
3. Lecture complète — uniquement si les étapes 1-2 sont insuffisantes.

Ne jamais relire un fichier déjà lu dans la session sauf s'il a été modifié entre-temps.
Ne pas scanner le repo entier ; ne pas élargir le périmètre sans demande explicite.

---

## 2. Surveillance du contexte (auto-déclaratif)

Codex ne mesure pas les tokens automatiquement : estimer au fil de la conversation.

**À chaque fin de réponse** dès que la session semble longue, signaler :

| Signal observé | Annoce à produire |
|---|---|
| ~5-10 fichiers lus ou tour 8+ | `[contexte moyen — préférer git grep/diff à toute nouvelle lecture]` |
| Beaucoup d'échanges, fichiers volumineux relus | `[contexte élevé — finir ce lot, handoff court, session fraîche recommandée]` |
| Session très longue, relecture fréquente | `[contexte critique — clôturer maintenant, nouvelle session]` |

Ne pas attendre que l'utilisateur demande : auto-déclarer le niveau estimé.

---

## 3. Détection d'une demande large

Si la demande couvre plusieurs fichiers, plusieurs fonctionnalités ou plusieurs écrans
non encore explorés :

> Demande potentiellement large. Je découpe en un premier lot court et ciblé.
> Périmètre retenu : [X]. Je n'élargis pas sans demande explicite.

Proposer un lot minimal avant de commencer.

---

## 4. Sûreté des commandes Bash

Avant d'exécuter une commande **irréversible ou destructive**, demander confirmation
explicite. Liste non exhaustive :

- Suppressions : `rm -rf`, `rmdir`, `git clean -fd`, `find … -delete`
- Reset : `git reset --hard`, `git checkout -- .`, `git restore .`
- Force push : `git push --force` / `git push -f`
- DDL base : `DROP TABLE`, `TRUNCATE`, `ALTER TABLE … DROP`
- Écrasement silencieux : `> fichier` (redirection destructive), `mv` vers une cible existante

Pour les commandes **lisibles et réversibles** (lecture, diff, grep, build, test) :
exécuter sans demander.

---

## 5. Protocole de clôture de lot

À la fin de chaque lot de travail, dans cet ordre :

1. **Vérification ciblée** — uniquement ce qui a changé (test, build, rendu, lint).
   Annoncer ce qui n'a pas pu être vérifié.
2. **`CHANGELOG.md`** — une entrée datée, résumé + puces (en français).
3. **Commit** — message court en français (résumé une ligne + puces si besoin).
4. **Handoff court** (< 800 tokens) :
   - Ce qui a été fait (une phrase).
   - Ce qui reste ou blocages.
   - Fichiers clés touchés.
   - Recommandation : continuer ou session fraîche.
5. **Session fraîche** — la recommander si le contexte est élevé ou si le lot est terminé.

Ne pas committer sans vérification. Ne pas annoncer « fait » sans preuve.

---

## 6. Session fraîche

Recommander une nouvelle session quand :
- Le lot est clôturé et un nouveau sujet commence.
- Le contexte est estimé élevé ou critique (cf. § 2).
- La session a traité plus de ~3 lots.

Formule : `→ Session fraîche recommandée. Handoff ci-dessus suffit pour reprendre.`

---

## 7. Initialisation d'un nouveau projet

Si `.vibe-agent/` est absent et l'utilisateur confirme l'initialisation :

1. Créer `.vibe-agent/` avec `read-ledger.json` et `context-ledger.json` vides (`[]`).
2. Créer `CLAUDE.md` minimaliste (nom projet, stack déduite des manifestes, règles §1-§5).
3. Créer `AGENTS.md` projet (copie de ce fichier, adapter §0).
4. Créer `CHANGELOG.md` avec en-tête vide.
5. Faire un premier commit : `"Init socle Promptimizer"`.

Lire **uniquement** `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` pour déduire
la stack. Ne pas lire le code applicatif pour l'initialisation.

---

## 8. Définition de « fini »

Un lot est fini quand **tous** ces points sont vrais :

- [ ] Demande littérale traitée (pas plus, pas moins).
- [ ] Scope creep évité.
- [ ] Vérification ciblée faite (ou motif d'impossibilité listé).
- [ ] `CHANGELOG.md` mis à jour.
- [ ] Commit fait.
- [ ] Handoff court produit.
- [ ] Session fraîche recommandée si pertinent.
