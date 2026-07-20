# Note d’orientation — Intégration de RTK et Serena dans Promptimizer

## Objet

Cette note propose une stratégie d’intégration de **RTK** et **Serena** dans Promptimizer, tout en limitant le risque de dépendance à des projets externes qui pourraient ralentir leur développement, devenir incompatibles ou ne plus être maintenus.

L’objectif n’est pas de transformer Promptimizer en une suite monolithique reproduisant ces outils, mais d’en faire une couche d’orchestration capable de les exploiter lorsqu’ils sont disponibles et de continuer à fonctionner lorsqu’ils ne le sont plus.

---

## 1. Positionnement recommandé

Promptimizer doit rester responsable de :

- la gouvernance des sessions ;
- la maîtrise du contexte ;
- le découpage du travail en lots ;
- le backlog persistant ;
- les handoffs entre sessions ;
- la sécurité des commandes ;
- la mesure des coûts et de l’efficacité ;
- la détection et le diagnostic des intégrations.

RTK et Serena doivent rester des moteurs spécialisés et remplaçables :

- **RTK** : optimisation et compression des sorties de commandes ;
- **Serena** : compréhension sémantique, navigation et modification du code au niveau des symboles.

Architecture cible :

```text
Promptimizer Core
│
├── CommandOptimizer
│   ├── RTK
│   ├── futur moteur alternatif
│   └── fallback natif Promptimizer
│
└── SemanticCodeProvider
    ├── Serena
    ├── futur provider MCP ou LSP
    └── fallback recherche textuelle
```

L’absence d’un provider externe doit provoquer une réduction de capacité, jamais une panne de Promptimizer.

---

## 2. Intégration de RTK

### Intérêt

RTK complète directement les fonctions actuelles de Promptimizer.

Promptimizer détecte déjà les sessions trop coûteuses, les relectures inutiles, les commandes répétées et l’occupation excessive du contexte. RTK agit plus tôt dans la chaîne en filtrant les sorties avant qu’elles soient envoyées au modèle.

Les deux outils sont donc complémentaires :

```text
Promptimizer
→ détecte, mesure et gouverne

RTK
→ réduit concrètement le volume transmis au modèle
```

### Mode d’intégration recommandé

Promptimizer devrait devenir l’unique propriétaire du hook de pré-exécution des commandes.

Le flux serait :

```text
Commande demandée par l’agent
→ contrôle de sécurité Promptimizer
→ refus ou confirmation si la commande est dangereuse
→ appel optionnel à RTK pour réécriture
→ exécution de la commande optimisée
→ mesure de l’économie obtenue
```

Cette approche évite que les hooks Promptimizer et RTK tentent tous les deux de modifier la même commande.

### Contrat abstrait

L’intégration ne doit pas être codée directement autour du nom ou de l’implémentation de RTK.

```typescript
interface CommandOptimizer {
  health(): Promise<ProviderHealth>;
  rewrite(command: string): Promise<string | null>;
  getStats?(): Promise<CompressionStats>;
}
```

RTK devient une implémentation parmi d’autres :

```typescript
class RtkOptimizer implements CommandOptimizer {
  async rewrite(command: string) {
    // Appel à `rtk rewrite` avec timeout court et comportement fail-open.
  }
}
```

En l’absence de provider :

```typescript
class PassthroughOptimizer implements CommandOptimizer {
  async rewrite() {
    return null;
  }
}
```

### Comportement attendu en cas d’erreur

L’intégration RTK doit être systématiquement **fail-open** :

- RTK absent : exécution de la commande originale ;
- timeout : exécution de la commande originale ;
- sortie invalide : exécution de la commande originale ;
- version inconnue : mode prudent ou désactivation ;
- erreur du binaire : aucun blocage de l’agent.

### Métrologie par lot

La principale valeur ajoutée de Promptimizer ne consiste pas seulement à activer RTK, mais à rattacher les économies obtenues aux lots.

Exemple :

```json
{
  "id": 12,
  "title": "Implémenter l’authentification",
  "cost_tokens": 84000,
  "command_optimizer": {
    "provider": "rtk",
    "raw_tokens_estimated": 51000,
    "tokens_delivered": 9200,
    "tokens_saved": 41800,
    "saving_ratio": 0.82
  }
}
```

Le bilan de clôture pourrait afficher :

```text
Lot #12 terminé

Coût modèle : 84k tokens
Sorties terminal brutes estimées : 51k
Sorties transmises : 9,2k
Économie RTK : 41,8k — 82 %
```

### Fallback natif minimal

Promptimizer devrait disposer d’un filet de sécurité indépendant de RTK :

- déduplication des lignes répétées ;
- conservation du début et de la fin des sorties ;
- extraction des erreurs principales ;
- troncature des sorties très volumineuses ;
- sauvegarde de la sortie complète dans un fichier local ;
- affichage du chemin permettant de consulter la sortie brute.

Ce fallback doit rester volontairement simple. Il ne faut pas chercher à reproduire les nombreux filtres spécialisés de RTK.

---

## 3. Intégration de Serena

### Intérêt

Serena améliore l’efficacité des agents sur les dépôts importants en leur permettant de travailler au niveau des symboles :

- vue structurelle d’un fichier ;
- recherche de symbole ;
- recherche de références ;
- recherche d’implémentations ;
- remplacement ciblé du corps d’une fonction ou d’une classe ;
- renommages et refactorings sémantiques ;
- diagnostics issus des serveurs de langage.

Cette approche complète la stratégie Promptimizer consistant à éviter les lectures complètes et les relectures inutiles.

### Mode d’intégration recommandé

Serena doit rester un serveur MCP indépendant.

Promptimizer peut :

- détecter sa présence ;
- vérifier sa configuration ;
- proposer son installation ;
- adapter ses règles lorsque Serena est disponible ;
- recommander son usage lorsque les relectures deviennent coûteuses ;
- mesurer approximativement les économies produites.

Promptimizer ne doit pas :

- embarquer Serena ;
- reproduire son moteur sémantique ;
- gérer directement les dizaines de serveurs de langage ;
- devenir responsable de l’indexation multi-langage.

### Contrat abstrait

Promptimizer doit travailler avec des capacités génériques plutôt qu’avec les noms d’outils Serena.

```typescript
interface SemanticCodeProvider {
  health(): Promise<ProviderHealth>;
  capabilities(): Promise<SemanticCapabilities>;

  getFileOutline(path: string): Promise<SymbolOutline>;
  findSymbol(query: SymbolQuery): Promise<SymbolResult[]>;
  findReferences(symbol: SymbolId): Promise<Reference[]>;

  replaceSymbolBody?(
    symbol: SymbolId,
    content: string
  ): Promise<void>;

  renameSymbol?(
    symbol: SymbolId,
    newName: string
  ): Promise<void>;
}
```

L’adaptateur Serena traduit ensuite ces capacités en appels MCP.

Cette abstraction permettra de brancher ultérieurement :

- un autre serveur MCP ;
- un provider LSP direct ;
- un plugin JetBrains ;
- des outils natifs de Claude Code, Codex ou OpenCode ;
- un index Tree-sitter ou ctags.

### Règles conditionnelles

Lorsque Serena est disponible, Promptimizer peut injecter les recommandations suivantes :

1. demander une vue des symboles avant de lire un fichier de code complet ;
2. utiliser la recherche de symbole pour localiser une implémentation ;
3. rechercher les références avant toute modification structurelle ;
4. préférer une édition symbolique à un remplacement textuel ;
5. réserver la lecture complète aux contenus non pris en charge ou lorsque les outils sémantiques sont insuffisants.

Un nudge pourrait prendre cette forme :

```text
Relecture complète répétée de src/auth/service.ts.

Un provider sémantique est disponible.
Rechercher le symbole concerné plutôt que relire l’ensemble du fichier.
```

### Gestion de la mémoire

Serena peut disposer de son propre système de mémoire, tandis que Promptimizer possède déjà :

- le backlog ;
- le handoff ;
- les décisions ;
- les résumés ;
- les chemins à ne pas relire ;
- l’état des lots ;
- les informations de coût.

Il faut éviter deux mémoires générales concurrentes.

| Type d’information | Propriétaire |
|---|---|
| Lots et progression | Promptimizer |
| Handoff de session | Promptimizer |
| Décisions et blocages | Promptimizer |
| Coût et occupation | Promptimizer |
| Symboles et références | Serena |
| Index sémantique | Serena |
| Sorties terminal compressées | RTK |
| Agrégation des économies | Promptimizer |

La mémoire générale de Serena peut être désactivée ou limitée dans le profil recommandé par Promptimizer.

---

## 4. Risque d’abandon de RTK ou Serena

### Principe

Promptimizer ne doit dépendre d’aucun outil externe pour ses fonctions essentielles.

Les fonctions suivantes doivent rester disponibles sans RTK ni Serena :

- démarrage de Promptimizer ;
- surveillance du contexte ;
- backlog ;
- handoff ;
- découpage en lots ;
- sécurité des commandes ;
- suivi des commits ;
- vérification des lots ;
- clôture ;
- diagnostic.

### Cas RTK

En cas d’arrêt de maintenance :

1. continuer à utiliser une version validée ;
2. épingler cette version ;
3. maintenir éventuellement un fork minimal ;
4. remplacer le provider ;
5. activer le fallback natif Promptimizer.

La conservation d’un fork RTK serait envisageable si les corrections nécessaires restent limitées aux intégrations, aux plateformes ou à quelques nouveaux formats de commandes.

### Cas Serena

Serena est plus difficile à reprendre intégralement en raison de :

- son serveur MCP ;
- ses abstractions LSP ;
- son support multi-langage ;
- ses outils de navigation symbolique ;
- ses fonctions de refactoring ;
- ses interactions avec les serveurs de langage.

En cas d’arrêt de maintenance, les options seraient :

1. utiliser la dernière version compatible ;
2. maintenir un fork uniquement pour les corrections critiques ;
3. remplacer Serena par un autre provider ;
4. connecter Promptimizer directement à un provider LSP ;
5. revenir à des outils textuels en mode dégradé.

Promptimizer ne doit pas promettre qu’une recherche textuelle peut remplacer un refactoring sémantique sûr.

---

## 5. Détection par capacités

Promptimizer ne doit pas seulement détecter qu’un outil est installé. Il doit détecter ce qu’il sait réellement faire.

```json
{
  "provider": "serena",
  "available": true,
  "capabilities": {
    "file_outline": true,
    "find_symbol": true,
    "find_references": true,
    "replace_symbol_body": true,
    "rename_symbol": false,
    "diagnostics": true
  }
}
```

Une version future peut conserver le même nom tout en faisant évoluer ses outils ou ses contrats. La logique Promptimizer doit donc se baser sur les capacités disponibles et non sur le seul numéro de version.

---

## 6. Versions validées et reproductibilité

Promptimizer devrait maintenir une matrice de compatibilité :

```yaml
integrations:
  rtk:
    recommended: "version validée"
    tested_range:
      min: "version minimale"
      max: "version maximale testée"

  serena:
    recommended_revision: "commit ou version validée"
    tested_capabilities:
      - file_outline
      - find_symbol
      - find_references
      - replace_symbol_body
```

Pour les usages en entreprise, il peut être pertinent d’archiver :

- les sources des versions validées ;
- leurs sommes SHA-256 ;
- les binaires RTK approuvés ;
- les configurations Serena ;
- les procédures de compilation ;
- les tests contractuels associés.

---

## 7. Tests contractuels

Les tests doivent valider les contrats attendus, sans dépendre des détails internes des providers.

### RTK

```text
Entrée : git status
Attendu :
- réécriture valide ou absence de réécriture ;
- commande originale préservée en cas d’erreur ;
- code de sortie correct ;
- délai maximal respecté ;
- aucun blocage si le binaire est absent.
```

### Serena

```text
Entrée : recherche du symbole AuthService
Attendu :
- réponse structurée ;
- chemins de fichiers exploitables ;
- identification claire d’une absence de résultat ;
- erreur compréhensible si le langage n’est pas initialisé ;
- aucune dépendance de Promptimizer à un nom d’outil non abstrait.
```

---

## 8. Doctor et mode dégradé

Le diagnostic Promptimizer devrait distinguer les fonctions du core et les capacités optionnelles.

```text
Promptimizer — diagnostic des intégrations

Core
Statut : opérationnel

Optimisation des commandes
Provider : RTK
Statut : indisponible
Impact : sorties terminal non compressées
Fallback : troncature générique active

Navigation sémantique
Provider : Serena
Statut : incompatible
Impact : navigation par symboles désactivée
Fallback : recherche textuelle et lecture partielle
```

Le mode dégradé doit être visible, compréhensible et non bloquant.

---

## 9. Politique de maintenance des providers

### Niveau 1 — Projet activement maintenu

- suivre les versions stables ;
- valider les mises à jour ;
- rester proche de l’upstream.

### Niveau 2 — Projet ralenti

- épingler la dernière version validée ;
- limiter les mises à jour ;
- surveiller les incompatibilités.

### Niveau 3 — Projet abandonné mais encore pertinent

- créer un fork maintenu par Promptimizer ;
- limiter le fork aux corrections essentielles ;
- conserver la compatibilité du contrat provider.

### Niveau 4 — Projet devenu obsolète

- arrêter le fork ;
- migrer vers un autre provider ;
- maintenir temporairement le fallback.

Il n’est pas recommandé de forker RTK ou Serena préventivement.

---

## 10. Décision recommandée

### RTK

Intégrer RTK fonctionnellement et profondément dans le flux Promptimizer, mais conserver le binaire comme dépendance externe optionnelle.

Promptimizer doit contrôler :

- l’activation ;
- le hook ;
- la sécurité ;
- le fallback ;
- la métrologie ;
- l’expérience utilisateur.

RTK doit conserver la responsabilité de ses filtres spécialisés.

### Serena

Intégrer Serena comme provider MCP optionnel, détecté et piloté par Promptimizer.

Promptimizer doit contrôler :

- la configuration ;
- la détection des capacités ;
- les règles d’usage ;
- les nudges ;
- les fallbacks ;
- la continuité des sessions.

Serena doit conserver la responsabilité de l’indexation et des opérations sémantiques.

---

## Conclusion

L’intégration de RTK et Serena renforcerait fortement la proposition de valeur de Promptimizer :

```text
Promptimizer
= gouvernance, continuité, sécurité, lots et mesure

RTK
= compression des sorties terminal

Serena
= compréhension sémantique du code
```

La stratégie recommandée repose sur cinq principes :

1. dépendances optionnelles ;
2. contrats abstraits ;
3. détection par capacités ;
4. fallbacks explicites ;
5. possibilité de remplacement ou de fork.

Avec cette architecture, l’arrêt de maintenance de RTK ou Serena provoquerait une dégradation contrôlée des capacités, et non une rupture de Promptimizer.
