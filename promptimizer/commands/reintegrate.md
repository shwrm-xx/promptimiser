---
description: Réintègre une vague parallèle en pipeline (merge ordonné + gate verify à chaque étape)
allowed-tools: Bash(node *)
---

Réintègre une **vague parallèle** en **pipeline** (décision D3, principe P3 : jamais de merge
big-bang). Merge séquentiel des lots **prêts à merger** (état `ready` dans `fleet.json`), dans
**l'ordre du graphe `depends_on`**, avec un **gate `verify`** à chaque étape : si une étape casse,
le merge est **annulé** et le pipeline **stoppe** — le coupable est le lot de l'étape, sans
ambiguïté. À chaque lot réintégré, la **tête d'intégration** avance dans `fleet.json`
(`setIntegrationHead` = signal de rebase pour les lots encore en vol).

**Deux gates, pas un** : un gate par étape (le `verify` du lot) **et** un **gate final de vague**
sur la branche d'intégration après le dernier merge — deux lots verts séparément peuvent être
rouges combinés (interférence sémantique sans conflit git). Un lot **sans `verify`** serait mergé
sans filet : `--execute` **refuse** tant que l'humain n'a pas tranché.

Deux modes :
1. **Proposition (défaut)** — affiche le pipeline (ordre, branches, gates) **sans rien merger** :
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/backlog.js reintegrate`
   (sortie machine : `--json`).
2. **Exécution** — lance réellement le pipeline :
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/backlog.js reintegrate --execute`
   (forcer la branche d'intégration : `--into <branche>` ; sinon `fleet.integration_branch`, sinon
   la branche courante).

Flags de gate (`--execute`) :
- `--gate "<cmd>"` — gate de **repli** exécutée pour les lots **sans `verify`** propre.
- `--allow-no-gate` — merge **assumé sans filet** de ces lots (le changelog agrégé le dira).
- `--final-gate "<cmd>"` — gate **final de vague** dédié (typecheck + tests + build, cf. D3 P3).
  À défaut : **union** des `verify` de la vague, privée de la dernière déjà passée verte sur l'état
  final. Aucun `verify` nulle part → la vague se clôt en le **disant** (« sans preuve »).

Étapes :
1. Proposer le plan et le restituer tel quel (les lots encore en vol tiennent la vague ouverte ;
   un lot `ready` qui dépend d'un lot en vol est « bloqué » — jamais mergé avant lui).
2. **Valider la frontière de vague** (palier 2 : l'humain valide la réintégration), puis
   `--execute`.
3. Si des lots sont **sans gate**, trancher avec l'humain (`--gate` ou `--allow-no-gate`) : ne
   jamais ajouter `--allow-no-gate` de sa propre initiative.
4. Restituer le résultat par lot (mergé + gate vert / conflit / gate rouge), le verdict du **gate
   final de vague**, le **changelog agrégé** proposé, et l'état de la vague (close ou encore
   ouverte). En cas d'échec d'étape, corriger le lot coupable, le remettre « prêt »
   (`fleet ready --id <id>`), puis relancer `--execute`. Si c'est le **gate final** qui rougit :
   les merges restent faits (aucun rollback automatique), la branche d'intégration est rouge —
   corriger sur place, puis relancer.
5. **Rapport persisté** : chaque `--execute` écrit `.vibe-agent/logs/reintegrate-<horodatage>.md`
   (plan, statut par lot, sortie **intégrale** des conflits/gates rouges, changelog agrégé,
   composition de la vague). Le chemin est affiché en fin de sortie — cite-le plutôt que de
   recoller les diagnostics dans le contexte, et va l'y lire si un gate rouge demande un
   diagnostic (la sortie brute n'est plus affichée dans le terminal).
6. **Vague close = rangement automatique** : `fleet.json` est vidé (la vague redevient inerte) et
   les `handoff-lot-*.md` des filles sont purgés. La composition de la vague reste dans le
   rapport. Ne t'attends donc pas à retrouver les lots `reintegrated` dans `fleet show`.

Le script fait foi : n'invente aucun merge, ne colle le changelog agrégé dans `CHANGELOG.md`
qu'après exécution réussie.
