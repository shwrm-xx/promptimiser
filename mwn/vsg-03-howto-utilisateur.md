# Fichier 3 — Mode d’emploi utilisateur final

# Utiliser Vibe Session Governor

Ce guide explique comment utiliser le système une fois généré par Claude Code.

Le système est conçu pour un usage principal avec **Claude Code client lourd / desktop**.

---

## 1. Ce que le système fait pour toi

`Vibe Session Governor` automatise trois choses :

```txt
1. Initialiser les projets
   → CLAUDE.md, AGENTS.md, CHANGELOG.md, .vibe-agent/

2. Réduire le coût de contexte
   → moins de relectures, moins de cache reads, moins de sessions longues

3. Clôturer proprement les lots
   → vérification ciblée, changelog, commit, handoff, session fraîche
```

Tu n’es pas censé lancer des commandes à chaque fois.

Le fonctionnement normal est :

```txt
J’ouvre Claude Code.
J’ouvre un projet.
Le système s’active automatiquement.
```

---

## 2. Installation

Une fois que Claude Code a généré le package `vibe-session-governor`, localise le fichier :

```txt
install.command
```

Puis double-clique dessus.

L’installateur doit :

```txt
- créer ~/.claude/vibe-session-governor/
- installer la skill globale
- installer les hooks globaux
- sauvegarder ton ancien ~/.claude/settings.json
- rendre les scripts exécutables
- lancer le diagnostic
```

Aucun `sudo` ne doit être demandé.

---

## 3. Vérification de l’installation

Double-clique sur :

```txt
vsg-doctor.command
```

Résultat attendu :

```txt
Vibe Session Governor — diagnostic

Claude settings : OK
Hooks globaux : OK
Skill globale : OK
Scripts exécutables : OK
Projet courant : initialisé / non initialisé

Statut : vert
```

Si le statut est orange ou rouge, lis le message affiché par le diagnostic.

---

## 4. Usage quotidien dans Claude Code desktop

### Cas normal

1. Ouvre Claude Code.
2. Ouvre un dossier projet.
3. Commence à travailler normalement.

Le système doit s’activer automatiquement.

### Projet déjà initialisé

Tu devrais voir un message court du type :

```txt
Vibe Session Governor actif.
Priorité : réduire les relectures de contexte.
Utilise rg/git diff avant Read complet.
Clôture chaque lot par vérif ciblée + changelog + commit + handoff court.
```

### Projet neuf ou non initialisé

Tu devrais voir :

```txt
Projet non initialisé détecté.
Bootstrap prudent Vibe Session Governor créé.
Avant de coder : finaliser CLAUDE.md/AGENTS.md avec lecture minimale, puis proposer un premier lot court.
```

Le système peut créer :

```txt
CLAUDE.md
AGENTS.md
CHANGELOG.md
.vibe-agent/
```

Il ne doit pas modifier ton code applicatif automatiquement.

---

## 5. Ce que tu dois demander à Claude Code au premier lancement d’un projet

Quand un projet vient d’être initialisé automatiquement, demande :

```txt
Finalise l’initialisation du projet avec lecture minimale.
Déduis la stack uniquement à partir des manifestes nécessaires.
Complète CLAUDE.md et AGENTS.md sans les rallonger inutilement.
Propose ensuite un premier lot court.
```

Le système doit éviter de lire tout le repo.

---

## 6. Pendant la session

Tu peux travailler normalement.

Le système doit surveiller automatiquement :

```txt
- les fichiers relus ;
- les lectures complètes évitables ;
- les commandes risquées ;
- les sessions qui deviennent longues ;
- les lots modifiés mais non clôturés ;
- les réponses qui déclarent “fini” sans preuve.
```

Quand Claude veut relire un fichier déjà connu, tu peux voir :

```txt
Lecture potentiellement coûteuse.
Ce fichier semble déjà connu ou non modifié.
Préférer rg, git diff ou lecture partielle sauf besoin exact.
```

Dans ce cas, laisse le système pousser Claude vers l’action la moins coûteuse.

---

## 7. Comment travailler par lots

Le bon rythme est :

```txt
1. Demande courte.
2. Modification ciblée.
3. Vérification ciblée.
4. CHANGELOG.md.
5. Commit.
6. Handoff court.
7. Nouvelle session si le lot est fini.
```

Évite :

```txt
- enchaîner plusieurs sujets dans la même session ;
- demander “continue avec plein d’autres améliorations” ;
- laisser Claude relire tout le projet ;
- accepter un “c’est fini” sans preuve ;
- accumuler des modifications sans commit.
```

---

## 8. Clôture de lot

Le système doit te rappeler de clôturer.

Message attendu :

```txt
Lot modifié sans clôture complète.
Avant de continuer : vérification ciblée, CHANGELOG, commit, handoff court, session fraîche recommandée.
```

La clôture correcte est :

```txt
- demande littérale traitée ;
- scope creep évité ;
- vérification ciblée faite ;
- erreurs ou zones non vérifiées listées ;
- CHANGELOG.md mis à jour ;
- commit fait ;
- handoff court produit ;
- session fraîche recommandée.
```

---

## 9. Slash commands disponibles en secours

Le système doit tourner sans elles, mais elles restent utiles.

### `/budget`

À utiliser si tu sens que la session devient lourde.

Effet attendu :

```txt
- statut budget contexte ;
- fichiers à éviter de relire ;
- action la moins coûteuse ;
- risque de session longue ;
- recommandation : continuer / vérifier / clôturer / session fraîche.
```

### `/check-context`

À utiliser si Claude commence à trop lire.

Effet attendu :

```txt
- lectures évitables ;
- lectures justifiées ;
- prochaine action minimale ;
- alerte budget.
```

### `/close-batch`

À utiliser pour forcer une clôture propre.

Effet attendu :

```txt
- checklist fait / non fait / non vérifié ;
- vérification ciblée ;
- changelog ;
- commit ;
- handoff court.
```

### `/fresh-session`

À utiliser pour préparer une nouvelle session.

Effet attendu :

```txt
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

## 10. Quand repartir en session fraîche

Repars en session fraîche quand :

```txt
- le lot est terminé ;
- un commit a été fait ;
- la session dépasse environ 15 à 20 tours ;
- Claude commence à relire des fichiers déjà connus ;
- le sujet change ;
- tu passes d’une feature à une autre ;
- la réponse finale devient trop longue ;
- le contexte commence à noyer la demande initiale.
```

Le handoff doit rester court.

Objectif :

```txt
Moins de contexte réinjecté.
Moins de cache reads.
Moins de relectures.
Meilleure précision.
```

---

## 11. Codex en delta

Codex n’est pas la cible principale du système automatique.

Pour Codex, le système fournit surtout :

```txt
AGENTS.md
éventuellement ~/.codex/AGENTS.md
skill optionnelle
wrapper codex-vsg optionnel
```

Usage recommandé :

```txt
1. Initialiser le projet avec Claude Code.
2. Laisser Claude Code créer AGENTS.md.
3. Ouvrir ensuite le projet dans Codex si besoin.
4. Codex applique les règles via AGENTS.md.
```

Ne cherche pas à obtenir le même comportement automatique que Claude Code.

La stratégie est :

```txt
Claude Code
= hooks globaux + skill globale + bootstrap prudent.

Codex
= AGENTS.md + skill + wrapper éventuel.
```

---

## 12. Désinstallation

Double-clique sur :

```txt
uninstall.command
```

Le désinstallateur doit :

```txt
- retirer les hooks VSG de ~/.claude/settings.json ;
- préserver les autres settings Claude Code ;
- sauvegarder avant modification ;
- proposer de conserver ou supprimer ~/.claude/vibe-session-governor/ ;
- ne jamais toucher aux projets.
```

---

## 13. Résumé utilisateur

Ton usage quotidien devient :

```txt
1. J’installe Vibe Session Governor une fois.
2. J’ouvre Claude Code desktop.
3. J’ouvre un projet.
4. Le système s’active automatiquement.
5. Il initialise le projet si besoin.
6. Il pousse Claude à lire moins.
7. Il force les lots courts.
8. Il rappelle changelog + commit + handoff.
9. Je repars en session fraîche quand le lot est terminé.
```

La règle à garder en tête :

```txt
Auto par défaut.
Manuel seulement en secours.
```
