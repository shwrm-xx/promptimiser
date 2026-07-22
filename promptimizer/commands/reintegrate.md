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

Deux modes :
1. **Proposition (défaut)** — affiche le pipeline (ordre, branches, gates) **sans rien merger** :
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/backlog.js reintegrate`
   (sortie machine : `--json`).
2. **Exécution** — lance réellement le pipeline :
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/backlog.js reintegrate --execute`
   (forcer la branche d'intégration : `--into <branche>` ; sinon `fleet.integration_branch`, sinon
   la branche courante).

Étapes :
1. Proposer le plan et le restituer tel quel (les lots encore en vol tiennent la vague ouverte ;
   un lot `ready` qui dépend d'un lot en vol est « bloqué » — jamais mergé avant lui).
2. **Valider la frontière de vague** (palier 2 : l'humain valide la réintégration), puis
   `--execute`.
3. Restituer le résultat par lot (mergé + gate vert / conflit / gate rouge), le **changelog
   agrégé** proposé, et l'état de la vague (close ou encore ouverte). En cas d'échec, corriger le
   lot coupable, le remettre « prêt », puis relancer `--execute`.

Le script fait foi : n'invente aucun merge, ne colle le changelog agrégé dans `CHANGELOG.md`
qu'après exécution réussie.
