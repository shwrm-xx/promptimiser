---
name: promptimizer
description: >-
  Gouvernance de session vibecoding (Claude Code desktop). À utiliser pour : nouveau projet,
  init projet, scaffold, setup Claude Code, optimisation de session, économie de tokens,
  cache read, relecture de contexte, coût tokens, clôture de lot, changelog, commit, handoff,
  session fraîche. Initialise les projets prudemment, réduit le contexte relu, force une
  clôture propre des lots, et fournit un delta AGENTS.md pour Codex.
---

# Promptimizer

Système standalone qui rend automatiques trois disciplines, par le chemin le **moins coûteux
en contexte**. La qualité reste obligatoire ; on l'obtient avec le minimum de relecture.

## 1. Initialiser un projet (prudent, après confirmation)
Quand un projet n'est pas initialisé (présence de `.vibe-agent/` absente) :
1. **Proposer** la création du socle, ne rien écrire sans accord de l'utilisateur.
2. Sur accord : `node ~/.claude/promptimizer/scripts/bootstrap-project.js --augment`
   (crée `.vibe-agent/`, `CLAUDE.md`, `AGENTS.md`, `CHANGELOG.md` s'ils manquent — jamais
   d'écrasement, repo git uniquement, jamais le code applicatif). Sur un **projet en cours**
   dont `CLAUDE.md`/`AGENTS.md` existent déjà, `--augment` ajoute en fin de fichier la
   section « Règles Promptimizer » taguée (`pmz:rules:start/end`) — append-only, idempotent,
   réversible en supprimant le bloc.
3. Finaliser `CLAUDE.md`/`AGENTS.md` avec **lecture minimale** (déduire la stack des seuls
   manifestes), sans les rallonger. Puis proposer un premier lot court.

## 2. Budget de contexte
- Préférer `git status`, `git diff`, `git grep`, lecture partielle, résumé local.
- Éviter : relecture complète d'un fichier inchangé, scan large du repo, handoff long.
- Le coût réel est suivi par paliers de tokens (alerte `systemMessage` en fin de tour).
  Audit ponctuel : `node ~/.claude/promptimizer/scripts/audit-context.js`.

## 3. Clôturer un lot
`node ~/.claude/promptimizer/scripts/close-batch.js` puis :
vérification ciblée → `CHANGELOG.md` → commit (français, court) → handoff < 800 tokens
**écrit dans `.vibe-agent/handoff.md`** (écrasé ; 1re ligne `<!-- pmz:handoff:manual -->`) →
recommander une session fraîche (le handoff y est injecté automatiquement au démarrage ;
à défaut, un handoff auto mécanique est écrit par le hook Stop à chaque fin de tour).

## Définition de « fini »
demande littérale traitée · scope creep évité · vérification ciblée · erreurs/zones non
vérifiées listées · CHANGELOG à jour · docs stables à jour si besoin · commit fait ·
handoff court · session fraîche recommandée.

## Delta Codex
Codex utilise `AGENTS.md` comme instructions persistantes (même socle de règles). Pas de hooks
côté Codex : l'auto-activation complète reste portée par Claude Code. Voir le wrapper optionnel
`pmz-codex`.
