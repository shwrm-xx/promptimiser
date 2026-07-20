# Epic PMZ — Providers d’optimisation et de navigation sémantique

## Identité

- **Nom** : Providers d’optimisation et de navigation sémantique
- **Code proposé** : `PMZ-PROVIDERS`
- **Type** : Epic technique et produit
- **Priorité proposée** : Haute
- **Statut initial** : À cadrer
- **Produits concernés** : Promptimizer Claude Code, Promptimizer OpenCode, delta Codex
- **Providers initiaux** : RTK et Serena

---

## 1. Problème à résoudre

Promptimizer sait aujourd’hui :

- suivre l’occupation du contexte ;
- détecter les relectures inutiles ;
- conserver un backlog et un handoff ;
- encadrer les commandes dangereuses ;
- mesurer le coût des lots ;
- recommander une session fraîche.

Il ne réduit toutefois pas directement la sortie de nombreuses commandes terminal et ne fournit pas de navigation sémantique du code.

RTK et Serena peuvent combler ces deux lacunes :

- RTK compresse et filtre les sorties terminal avant leur entrée dans le contexte ;
- Serena fournit une navigation et une édition du code au niveau des symboles.

Une intégration naïve créerait toutefois plusieurs risques :

- conflit entre hooks ;
- dépendances obligatoires ;
- duplication de fonctionnalités ;
- dépendance durable à des projets externes ;
- coexistence de plusieurs mémoires ;
- impossibilité de remplacer un provider devenu obsolète.

---

## 2. Objectif de l’epic

Permettre à Promptimizer d’exploiter des moteurs externes d’optimisation et d’analyse sémantique tout en garantissant :

- l’indépendance du core ;
- la continuité du fonctionnement sans provider ;
- la possibilité de remplacer chaque provider ;
- une dégradation explicite et non bloquante ;
- une mesure des gains par session, lot et epic ;
- l’absence de conflit avec les hooks et outils existants.

---

## 3. Résultat attendu

À la fin de l’epic, Promptimizer doit proposer quatre niveaux de fonctionnement :

```text
PMZ Core
→ aucun provider externe

PMZ + RTK
→ compression des sorties terminal

PMZ + Serena
→ navigation et édition sémantiques

PMZ Full
→ RTK + Serena
```

L’utilisateur doit pouvoir activer, désactiver, diagnostiquer et remplacer les providers sans modifier le cœur de Promptimizer.

---

## 4. Périmètre

### Inclus

- abstraction des providers ;
- détection des installations et capacités ;
- bridge RTK dans le hook de commande Promptimizer ;
- prévention des conflits de hooks ;
- métriques RTK par lot ;
- fallback minimal de sortie terminal ;
- détection et diagnostic Serena ;
- règles de comportement conditionnelles ;
- recommandations Serena sur les gros dépôts ;
- fallbacks textuels ;
- matrice de compatibilité ;
- tests contractuels ;
- documentation de maintenance et remplacement.

### Exclu

- réécriture du moteur RTK ;
- réimplémentation des filtres spécialisés RTK ;
- embarquement du binaire RTK dans le cœur ;
- réimplémentation de Serena ;
- gestion directe de tous les serveurs LSP ;
- création d’un fork préventif ;
- remplacement automatique d’un provider sans validation ;
- promesse de refactoring sémantique sûr en mode textuel.

---

## 5. Valeur utilisateur

### Pour un utilisateur individuel

- moins de contexte consommé par les commandes ;
- sessions plus longues et moins coûteuses ;
- moins de relectures complètes ;
- navigation plus fiable dans les gros dépôts ;
- installation guidée et diagnostic unique.

### Pour une équipe ou une entreprise

- versions validées et épinglables ;
- fonctionnement hors ligne possible après installation ;
- possibilité de miroir ou de fork ;
- contrats de compatibilité testables ;
- dégradation maîtrisée si un projet externe disparaît.

---

## 6. Principes non négociables

1. **Le core doit fonctionner sans RTK ni Serena.**
2. **Toute erreur de provider doit être fail-open lorsque la sécurité n’est pas concernée.**
3. **Promptimizer reste l’unique propriétaire du contrôle de sécurité des commandes.**
4. **Les intégrations doivent reposer sur des capacités abstraites.**
5. **Aucun nom d’outil Serena ne doit être dispersé dans le cœur métier.**
6. **Aucun filtre RTK ne doit être recopié dans Promptimizer.**
7. **Les gains estimés doivent être distingués des gains réellement mesurés.**
8. **Les fallbacks ne doivent jamais prétendre offrir une sécurité sémantique inexistante.**
9. **Le mode dégradé doit être visible dans le doctor et dans les commandes de statut.**
10. **Les données critiques du projet restent détenues par Promptimizer.**

---

## 7. Découpage proposé en lots

## Lot 1 — Socle de providers

### Objectif

Créer une architecture indépendante des outils externes.

### Livrables

- interface `CommandOptimizer` ;
- interface `SemanticCodeProvider` ;
- registre de providers ;
- types de capacité ;
- état de santé standardisé ;
- provider neutre pour chaque famille ;
- configuration d’activation ;
- tests unitaires du registre.

### Fait quand

- Promptimizer démarre avec zéro provider ;
- un provider peut être ajouté sans modifier le code métier du backlog ou du handoff ;
- une indisponibilité retourne un statut structuré ;
- les providers neutres assurent un fonctionnement sans erreur.

### Vérification indicative

```bash
npm test -- providers
```

---

## Lot 2 — Bridge RTK

### Objectif

Faire transiter les commandes compatibles par RTK sans multiplier les hooks concurrents.

### Livrables

- détection du binaire RTK ;
- adaptateur `RtkCommandOptimizer` ;
- appel à `rtk rewrite` ;
- timeout court ;
- fail-open ;
- kill switch ;
- détection d’un hook RTK autonome ;
- intégration Claude Code ;
- intégration OpenCode.

### Fait quand

- une commande sûre peut être réécrite par RTK ;
- une commande dangereuse reste soumise aux règles PMZ avant RTK ;
- une absence ou panne de RTK exécute la commande originale ;
- le doctor signale un hook concurrent ;
- aucun double préfixe RTK n’est produit.

### Vérification indicative

```bash
npm test -- rtk-bridge
```

---

## Lot 3 — Métrologie RTK par lot

### Objectif

Rattacher les économies RTK aux lots Promptimizer.

### Livrables

- snapshot au démarrage de lot ;
- delta à la clôture ;
- champs de métrique dans le backlog ;
- affichage dans `/budget` ;
- affichage dans le bilan d’epic ;
- export CSV et Markdown ;
- distinction entre mesure et estimation.

### Fait quand

- un lot clos peut afficher le nombre de tokens économisés ;
- l’absence de métrique RTK n’empêche pas la clôture ;
- les données sont exportables ;
- les valeurs inconnues ne sont jamais inventées.

### Vérification indicative

```bash
npm test -- rtk-metrics backlog-export
```

---

## Lot 4 — Fallback natif de sortie

### Objectif

Conserver une protection minimale lorsque RTK est indisponible.

### Livrables

- déduplication simple ;
- coupe début/fin ;
- extraction d’erreurs ;
- seuil de sortie volumineuse ;
- stockage local de la sortie complète ;
- message de récupération ;
- configuration d’exclusion.

### Fait quand

- une sortie très volumineuse ne sature pas silencieusement le contexte ;
- le contenu brut reste récupérable ;
- le fallback n’altère pas les petites sorties ;
- le fallback peut être désactivé.

### Vérification indicative

```bash
npm test -- output-fallback
```

---

## Lot 5 — Serena Doctor

### Objectif

Détecter et qualifier l’installation Serena sans l’embarquer.

### Livrables

- détection du binaire ;
- détection de la configuration MCP ;
- détection de l’initialisation projet ;
- interrogation des capacités ;
- diagnostic par client ;
- messages d’installation ou de réparation.

### Fait quand

- le doctor distingue absent, installé, configuré, incompatible et opérationnel ;
- les capacités disponibles sont listées ;
- un échec MCP ne bloque jamais le core ;
- aucun nom d’outil Serena n’est utilisé hors de l’adaptateur.

### Vérification indicative

```bash
npm test -- serena-doctor
```

---

## Lot 6 — Workflow Serena-aware

### Objectif

Orienter l’agent vers la navigation sémantique lorsque cela apporte un gain.

### Livrables

- règles conditionnelles ;
- nudge en cas de relecture complète répétée ;
- recommandation selon la taille du dépôt ;
- stratégie `outline → symbole → références → lecture complète` ;
- métriques d’usage ;
- désactivation sur projets trop petits ou non-code.

### Fait quand

- les règles Serena ne sont injectées que si les capacités existent ;
- une relecture d’un gros fichier peut déclencher une recommandation ;
- les contenus Markdown, JSON ou assets restent gérés normalement ;
- l’économie affichée est marquée comme estimée lorsqu’elle ne vient pas du transcript.

### Vérification indicative

```bash
npm test -- serena-workflow
```

---

## Lot 7 — Compatibilité, résilience et remplacement

### Objectif

Préparer l’abandon ou l’incompatibilité d’un provider.

### Livrables

- matrice de versions testées ;
- tests contractuels ;
- statut version inconnue ;
- fallback par capacité ;
- documentation de fork ;
- documentation de remplacement ;
- provider textuel de référence ;
- politique de maintenance.

### Fait quand

- une nouvelle version non validée produit un avertissement clair ;
- un provider peut être remplacé sans migration du backlog ;
- une capacité absente entraîne un fallback ou un refus explicite ;
- la procédure de fork et de retrait est documentée.

### Vérification indicative

```bash
npm test -- provider-contracts degraded-mode
```

---

## 8. Critères d’acceptation globaux

- [ ] Promptimizer fonctionne sans RTK et sans Serena.
- [ ] RTK peut être activé sans hook concurrent.
- [ ] Toute erreur RTK repasse à la commande originale.
- [ ] Les règles de sécurité PMZ s’exécutent avant toute réécriture.
- [ ] Les gains RTK sont rattachables à un lot.
- [ ] Serena reste une dépendance MCP externe.
- [ ] Les capacités Serena sont détectées dynamiquement.
- [ ] Un provider absent apparaît dans le doctor sans statut rouge du core.
- [ ] Le fallback textuel ne prétend pas offrir un refactoring sûr.
- [ ] Les mémoires PMZ et Serena ne se concurrencent pas.
- [ ] Les versions validées sont documentées.
- [ ] Les tests contractuels couvrent absence, timeout, réponse invalide et version inconnue.
- [ ] L’intégration fonctionne dans Claude Code et OpenCode.
- [ ] Le delta Codex explique les capacités disponibles et ses limites.
- [ ] Une désinstallation d’un provider ne supprime aucune donnée PMZ.

---

## 9. Risques et mitigations

| Risque | Impact | Mitigation |
|---|---|---|
| Conflit entre hooks RTK et PMZ | Commande non déterministe | Hook unique détenu par PMZ |
| RTK absent | Pas de compression | Passthrough + fallback minimal |
| Serena absent | Pas de navigation sémantique | Recherche textuelle et lecture partielle |
| Serena incompatible | Outils MCP cassés | Détection par capacités |
| Abandon upstream | Maintenance future | Version épinglée, fork limité ou remplacement |
| Deux mémoires générales | Contradictions | PMZ garde la mémoire projet |
| Métriques inexactes | Mauvaise décision | Séparer mesures et estimations |
| Scope trop large | Retard et complexité | Livrer RTK puis Serena par lots séparés |
| Installation lourde | Faible adoption | Providers opt-in et doctor guidé |

---

## 10. Ordre de livraison recommandé

1. Socle de providers ;
2. bridge RTK ;
3. métrologie RTK ;
4. fallback natif ;
5. Serena Doctor ;
6. workflow Serena-aware ;
7. résilience et remplacement.

RTK doit être livré en premier : le gain est immédiat, mesurable et plus simple techniquement.

Serena doit être intégré ensuite : sa valeur est élevée sur les gros dépôts, mais son installation et ses capacités sont plus variables.

---

## 11. Indicateurs de succès

- taux de sessions utilisant RTK ;
- taux de commandes réécrites ;
- tokens estimés économisés par lot ;
- réduction des sorties de tests et builds ;
- nombre de relectures complètes évitées ;
- taux d’usage des outils sémantiques ;
- taux d’erreurs de provider ;
- nombre de sessions en mode dégradé ;
- temps moyen de diagnostic ;
- nombre de projets où le provider est désactivé volontairement.

---

## 12. Définition de fini de l’epic

L’epic est considéré terminé lorsque :

- les sept lots sont clos ou explicitement abandonnés ;
- le core fonctionne avec zéro, un ou deux providers ;
- les conflits de hooks sont couverts ;
- les tests contractuels passent ;
- les métriques sont exportables ;
- le doctor explique clairement les modes dégradés ;
- la documentation d’installation, désactivation, remplacement et fork est disponible ;
- une démonstration couvre RTK actif, Serena actif et absence des deux providers.
