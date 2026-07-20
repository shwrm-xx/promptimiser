# Spécification technique — Providers RTK et Serena pour Promptimizer

## 1. Statut du document

- **Type** : spécification technique
- **Portée** : architecture, contrats, flux, stockage, erreurs et tests
- **Cible** : Promptimizer Claude Code et OpenCode
- **Compatibilité secondaire** : delta Codex
- **Décision structurante** : dépendances optionnelles et remplaçables

---

## 2. Objectifs techniques

Le système doit :

1. brancher un moteur de compression de commandes sans dupliquer le hook de sécurité ;
2. détecter un provider sémantique MCP sans l’embarquer ;
3. fonctionner sans provider externe ;
4. sélectionner les comportements selon les capacités réellement disponibles ;
5. mesurer les gains lorsque les données sont fiables ;
6. offrir des fallbacks explicites ;
7. permettre le remplacement d’un provider sans migration du backlog ;
8. résister aux versions incompatibles ou aux projets abandonnés.

---

## 3. Contraintes

### Contraintes fonctionnelles

- Le backlog, le handoff et la clôture des lots ne dépendent d’aucun provider.
- Le contrôle de sécurité Bash précède la compression.
- Les commandes dangereuses ne doivent jamais être rendues silencieusement exécutables par une réécriture.
- Un provider sémantique absent ne doit pas empêcher l’édition textuelle.
- Les opérations sémantiques non disponibles doivent être signalées comme telles.

### Contraintes techniques

- Node.js reste le runtime du core PMZ.
- Les hooks conservent un comportement fail-open.
- Les timeouts sont centralisés.
- Aucune dépendance réseau n’est nécessaire à l’exécution normale.
- Les configurations sont lisibles et versionnables lorsque cela est pertinent.
- Les données éphémères restent hors Git.
- Les métriques durables peuvent être exportées avec le backlog.

---

## 4. Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                    Promptimizer Core                        │
│                                                             │
│  Session / Backlog / Handoff / Safety / Doctor / Metrics    │
└───────────────┬─────────────────────────────┬───────────────┘
                │                             │
                ▼                             ▼
┌───────────────────────────┐    ┌────────────────────────────┐
│ CommandOptimizerRegistry  │    │ SemanticProviderRegistry   │
└───────────────┬───────────┘    └──────────────┬─────────────┘
                │                               │
       ┌────────┴────────┐             ┌────────┴────────┐
       ▼                 ▼             ▼                 ▼
 RtkOptimizer   PassthroughOptimizer  SerenaProvider  TextFallback
```

Le core ne dépend que des interfaces et registres. Les détails RTK et Serena sont isolés dans leurs adaptateurs.

---

## 5. Organisation des modules proposée

```text
promptimizer/
├── integrations/
│   ├── common/
│   │   ├── types.js
│   │   ├── health.js
│   │   ├── capabilities.js
│   │   └── errors.js
│   │
│   ├── command-optimizers/
│   │   ├── registry.js
│   │   ├── passthrough.js
│   │   ├── rtk.js
│   │   ├── fallback-output.js
│   │   └── metrics.js
│   │
│   └── semantic-providers/
│       ├── registry.js
│       ├── text-fallback.js
│       ├── serena.js
│       ├── capability-map.js
│       └── recommendations.js
│
├── hooks/
│   ├── pre-tool-use.js
│   ├── post-tool-use.js
│   └── stop.js
│
├── scripts/
│   ├── integrations.js
│   ├── doctor-integrations.js
│   └── provider-contract-test.js
│
└── lib/
    ├── backlog.js
    ├── messages.js
    ├── timeouts.js
    └── project.js
```

Les noms sont indicatifs et doivent être adaptés à l’arborescence réelle de PMZ.

---

## 6. Types communs

```typescript
type ProviderStatus =
  | "operational"
  | "degraded"
  | "missing"
  | "misconfigured"
  | "incompatible"
  | "disabled"
  | "unknown";

type EvidenceLevel =
  | "measured"
  | "estimated"
  | "unavailable";

interface ProviderHealth {
  provider: string;
  family: "command_optimizer" | "semantic_code";
  status: ProviderStatus;
  version?: string;
  tested?: boolean;
  message?: string;
  impact?: string;
  fallback?: string;
  capabilities?: Record<string, boolean>;
}
```

---

## 7. Contrat `CommandOptimizer`

```typescript
interface RewriteContext {
  cwd: string;
  client: "claude" | "opencode" | "codex" | "unknown";
  sessionId?: string;
  lotId?: number;
}

interface RewriteResult {
  applied: boolean;
  originalCommand: string;
  rewrittenCommand: string;
  provider: string;
  reason?: string;
  durationMs: number;
}

interface CompressionSnapshot {
  provider: string;
  capturedAt: string;
  rawTokensEstimated?: number;
  deliveredTokensEstimated?: number;
  tokensSavedEstimated?: number;
  evidence: EvidenceLevel;
}

interface CommandOptimizer {
  id: string;
  health(): Promise<ProviderHealth>;

  rewrite(
    command: string,
    context: RewriteContext
  ): Promise<RewriteResult>;

  snapshot?(
    context: RewriteContext
  ): Promise<CompressionSnapshot | null>;
}
```

### Provider neutre

```typescript
class PassthroughOptimizer {
  id = "passthrough";

  async health() {
    return {
      provider: this.id,
      family: "command_optimizer",
      status: "operational",
      tested: true,
      message: "Aucune optimisation externe active."
    };
  }

  async rewrite(command) {
    return {
      applied: false,
      originalCommand: command,
      rewrittenCommand: command,
      provider: this.id,
      durationMs: 0
    };
  }
}
```

---

## 8. Adaptateur RTK

### Détection

Ordre proposé :

1. variable `PMZ_RTK_DISABLE=1` ;
2. configuration projet ou globale ;
3. résolution de `rtk` dans le `PATH` ;
4. exécution de `rtk --version` avec timeout ;
5. validation dans la matrice de compatibilité ;
6. test facultatif de `rtk rewrite "git status"`.

### Réécriture

Commande conceptuelle :

```bash
rtk rewrite "<commande>"
```

L’appel doit utiliser un processus sans shell lorsque possible afin de réduire les risques d’échappement.

Pseudo-code :

```typescript
async function rewriteWithRtk(command, context) {
  const started = Date.now();

  try {
    const result = await execFileWithTimeout(
      rtkBinary,
      ["rewrite", command],
      TIMEOUTS.rtkRewrite
    );

    const candidate = result.stdout.trim();

    if (!candidate || candidate === command) {
      return unchanged(command, Date.now() - started);
    }

    return {
      applied: true,
      originalCommand: command,
      rewrittenCommand: candidate,
      provider: "rtk",
      durationMs: Date.now() - started
    };
  } catch {
    return unchanged(command, Date.now() - started, "fail-open");
  }
}
```

### Règles de sécurité

Le flux du hook doit être strictement :

```text
parse input
→ analyse de sécurité PMZ sur la commande originale
→ deny / ask si nécessaire
→ sélection du CommandOptimizer
→ réécriture
→ vérification défensive de la commande réécrite
→ réponse updatedInput
```

Une seconde analyse de sécurité légère sur la commande réécrite est recommandée pour détecter un résultat anormal.

### Commandes déjà préfixées

- `rtk ...` doit passer sans double préfixe ;
- `RTK_DISABLED=1 ...` doit respecter l’override ;
- une commande exclue par RTK doit rester inchangée.

### Timeout

Valeur initiale recommandée :

```text
250 à 500 ms
```

Le timeout doit rester inférieur au budget du hook PMZ et être configurable par variable d’environnement pour les tests.

---

## 9. Conflit de hooks RTK

Le doctor doit rechercher :

- hook RTK dans les réglages Claude Code ;
- plugin RTK OpenCode ;
- instructions Codex ajoutées par RTK ;
- bridge PMZ activé simultanément.

### États

| État | Action |
|---|---|
| RTK absent | Aucun conflit |
| RTK présent sans hook autonome | Bridge PMZ possible |
| Hook RTK autonome détecté | Avertissement |
| Hook autonome + bridge PMZ | Statut incompatible ou dégradé |
| Migration validée | Retrait du hook autonome |

Promptimizer peut fournir une commande guidée :

```text
pmz integrations migrate rtk
```

Cette commande doit sauvegarder les configurations avant toute modification.

---

## 10. Fallback natif de sortie

Le fallback n’est pas un remplacement fonctionnel de RTK.

### Déclenchement

- RTK absent ou désactivé ;
- sortie au-dessus d’un seuil ;
- commande explicitement autorisée ;
- type de sortie compatible avec une réduction générique.

### Stratégies

1. déduplication de lignes consécutives ;
2. conservation d’un en-tête ;
3. conservation des lignes contenant des marqueurs d’erreur ;
4. conservation de la fin ;
5. stockage de la sortie complète ;
6. ajout d’un résumé technique.

### Format de résultat

```text
[PMZ sortie réduite]
Commande : npm test
Lignes brutes : 18 452
Lignes transmises : 164
Erreurs détectées : 7
Sortie complète : .vibe-agent/logs/<id>.log
```

### Limites

- ne jamais filtrer silencieusement une sortie courte ;
- ne jamais supprimer le code de sortie ;
- ne jamais marquer une commande comme réussie sur la seule base du texte ;
- ne pas appliquer à des sorties binaires.

---

## 11. Métrologie RTK

### Stockage par lot

Extension proposée :

```json
{
  "id": 12,
  "title": "Implémenter l’authentification",
  "status": "done",
  "cost_tokens": 84000,
  "integrations": {
    "command_optimizer": {
      "provider": "rtk",
      "evidence": "measured",
      "raw_tokens_estimated": 51000,
      "delivered_tokens_estimated": 9200,
      "tokens_saved_estimated": 41800,
      "saving_ratio": 0.82
    }
  }
}
```

Le champ `integrations` doit être optionnel et rétrocompatible.

### Calcul

```text
delta = snapshot_clôture - snapshot_démarrage
```

En cas d’absence de snapshot initial :

- ne pas inventer de delta ;
- indiquer `evidence: unavailable`.

### Export

Ajouter aux exports :

- `command_optimizer_provider` ;
- `command_tokens_saved` ;
- `command_saving_ratio` ;
- `command_evidence`.

---

## 12. Contrat `SemanticCodeProvider`

```typescript
interface SemanticCapabilities {
  fileOutline: boolean;
  findSymbol: boolean;
  findReferences: boolean;
  findImplementations: boolean;
  diagnostics: boolean;
  replaceSymbolBody: boolean;
  renameSymbol: boolean;
  safeDelete: boolean;
}

interface SemanticQueryContext {
  root: string;
  language?: string;
  client: "claude" | "opencode" | "codex" | "unknown";
}

interface SemanticCodeProvider {
  id: string;

  health(): Promise<ProviderHealth>;

  capabilities(
    context: SemanticQueryContext
  ): Promise<SemanticCapabilities>;

  getFileOutline?(
    path: string,
    context: SemanticQueryContext
  ): Promise<unknown>;

  findSymbol?(
    query: string,
    context: SemanticQueryContext
  ): Promise<unknown[]>;

  findReferences?(
    symbol: string,
    context: SemanticQueryContext
  ): Promise<unknown[]>;

  diagnostics?(
    path: string,
    context: SemanticQueryContext
  ): Promise<unknown[]>;
}
```

Promptimizer n’a pas nécessairement à exécuter lui-même ces opérations. Le contrat peut aussi servir à décrire les capacités exposées à l’agent et à générer les règles adaptées.

---

## 13. Adaptateur Serena

### Principe

Serena reste un serveur MCP indépendant. L’adaptateur PMZ assure :

- détection ;
- qualification ;
- mapping des capacités ;
- génération de règles ;
- diagnostic ;
- recommandations.

### Détection proposée

1. vérifier `PMZ_SERENA_DISABLE=1` ;
2. vérifier la présence du binaire Serena ;
3. rechercher la configuration MCP du client ;
4. vérifier l’initialisation du projet ;
5. interroger ou tester les outils disponibles ;
6. construire la matrice de capacités ;
7. comparer avec la matrice testée PMZ.

### Mapping

Les noms d’outils Serena doivent être isolés dans :

```text
integrations/semantic-providers/serena.js
```

Le reste du core utilise uniquement :

- `fileOutline` ;
- `findSymbol` ;
- `findReferences` ;
- `replaceSymbolBody` ;
- `renameSymbol` ;
- `diagnostics`.

### Mémoire

La configuration recommandée doit éviter une mémoire générale concurrente.

- PMZ conserve : backlog, handoff, décisions, coût, skip paths ;
- Serena conserve : index et informations sémantiques nécessaires à ses outils ;
- la mémoire narrative Serena est désactivée ou documentée comme option avancée.

---

## 14. Provider textuel de fallback

Le fallback doit être explicite sur ses limites.

### Capacités possibles

| Capacité | Implémentation |
|---|---|
| fileOutline | heuristique, Tree-sitter ou ctags |
| findSymbol | `rg`, ctags ou LSP |
| findReferences | recherche textuelle |
| diagnostics | compilateur ou linter |
| replaceSymbolBody | édition ciblée non garantie |
| renameSymbol | indisponible |
| safeDelete | indisponible |

### Contrat de prudence

Si `renameSymbol` est demandé alors que la capacité est absente :

```text
Provider sémantique indisponible : renommage sûr non garanti.
Une recherche textuelle peut être effectuée, mais elle ne remplace pas un refactoring sémantique.
```

---

## 15. Règles injectées à l’agent

### Avec Serena opérationnel

```text
Pour le code :
1. utiliser une vue des symboles avant toute lecture complète d’un gros fichier ;
2. rechercher le symbole ciblé ;
3. rechercher ses références avant une modification structurelle ;
4. préférer l’édition symbolique ;
5. lire le fichier complet seulement si les outils sémantiques sont insuffisants.
```

### Sans Serena

```text
Pour le code :
1. utiliser git grep ou rg avant la lecture ;
2. lire des plages ciblées ;
3. éviter les relectures ;
4. signaler qu’un refactoring textuel n’offre pas de garantie sémantique.
```

Les règles conditionnelles doivent être courtes afin de ne pas annuler les économies recherchées.

---

## 16. Configuration

### Exemple global

```yaml
integrations:
  command_optimizer:
    provider: auto
    fallback: true

  semantic_code:
    provider: auto
    memory_policy: pmz_authoritative

  compatibility:
    unknown_version_policy: warn
```

### Exemple projet

```yaml
integrations:
  command_optimizer:
    provider: rtk

  semantic_code:
    provider: serena
    minimum_repo_files: 200
```

### Variables d’environnement

```text
PMZ_RTK_DISABLE=1
PMZ_SERENA_DISABLE=1
PMZ_OUTPUT_FALLBACK_DISABLE=1
PMZ_RTK_REWRITE_TIMEOUT_MS=400
PMZ_PROVIDER_STRICT=0
```

---

## 17. Commandes utilisateur proposées

```text
/pmz:integrations
/pmz:integrations status
/pmz:integrations enable rtk
/pmz:integrations disable rtk
/pmz:integrations enable serena
/pmz:integrations disable serena
/pmz:integrations doctor
/pmz:integrations migrate rtk
```

Pour éviter d’élargir excessivement la surface de commandes, elles peuvent être regroupées derrière une seule commande `integrations`.

---

## 18. Doctor

### Exemple sain

```text
Promptimizer — intégrations

Core : opérationnel

Command optimizer
Provider : RTK
Version : validée
Bridge PMZ : actif
Hook concurrent : non
Fallback : prêt

Semantic code
Provider : Serena
MCP : configuré
Projet : initialisé
Capacités : outline, symbole, références, diagnostics
État : opérationnel
```

### Exemple dégradé

```text
Promptimizer — intégrations

Core : opérationnel

Command optimizer
Provider : RTK
État : absent
Impact : sorties brutes
Fallback PMZ : actif

Semantic code
Provider : Serena
État : incompatible
Capacité absente : rename_symbol
Fallback : recherche textuelle
```

---

## 19. Compatibilité et versions

### Matrice

```yaml
providers:
  rtk:
    recommended: "<à renseigner>"
    min_tested: "<à renseigner>"
    max_tested: "<à renseigner>"
    required_capabilities:
      - rewrite
      - stats_optional

  serena:
    recommended: "<à renseigner>"
    required_capabilities:
      - file_outline
      - find_symbol
      - find_references
```

Une version au-delà de la plage testée ne doit pas être bloquée par défaut, mais signalée.

### Modes

| Mode | Politique |
|---|---|
| normal | utiliser la version validée |
| prudent | version inconnue, capacités testées |
| dégradé | capacités partielles |
| désactivé | provider ignoré |
| strict | incompatibilité bloquante pour les seules fonctions optionnelles |

---

## 20. Politique de résilience

### RTK non maintenu

1. épingler la dernière version validée ;
2. archiver les sources et binaires ;
3. appliquer les correctifs minimaux dans un fork si nécessaire ;
4. maintenir le contrat `CommandOptimizer` ;
5. remplacer le provider lorsqu’un meilleur moteur existe.

### Serena non maintenu

1. épingler la dernière version compatible ;
2. limiter un éventuel fork aux corrections critiques ;
3. maintenir l’adaptateur séparé du core ;
4. migrer vers un autre MCP ou provider LSP ;
5. conserver le fallback textuel.

### Critère de fork

Créer un fork seulement si :

- l’upstream ne répond plus ;
- une incompatibilité critique est démontrée ;
- le coût de correction est inférieur au coût de migration ;
- une capacité importante ne peut pas être remplacée rapidement.

---

## 21. Tests

### Tests unitaires

- registre sans provider ;
- provider inconnu ;
- sélection automatique ;
- timeout ;
- erreur de parsing ;
- capacités partielles ;
- configuration désactivée ;
- fallback.

### Tests d’intégration RTK

- RTK absent ;
- RTK présent ;
- commande inchangée ;
- commande réécrite ;
- commande déjà préfixée ;
- commande dangereuse ;
- timeout ;
- hook concurrent ;
- métrique absente ;
- delta de métrique.

### Tests d’intégration Serena

- Serena absent ;
- binaire présent sans MCP ;
- MCP présent sans projet initialisé ;
- capacités complètes ;
- capacités partielles ;
- version inconnue ;
- outil renommé ou manquant ;
- fallback textuel ;
- mémoire narrative désactivée.

### Tests de non-régression

- backlog ancien sans champ `integrations` ;
- export CSV historique ;
- handoff sans provider ;
- désinstallation RTK ;
- désinstallation Serena ;
- installation simultanée ;
- fonctionnement OpenCode ;
- fonctionnement Claude Code.

---

## 22. Observabilité

Événements proposés :

```text
provider_detected
provider_missing
provider_incompatible
provider_rewrite_applied
provider_rewrite_bypassed
provider_timeout
provider_fallback_used
semantic_recommendation_shown
semantic_capability_missing
```

Aucune donnée sensible de commande ou de code ne doit être télémétrée par défaut.

Les statistiques locales peuvent être agrégées dans `.vibe-agent/` puis résumées dans le backlog si elles sont durables.

---

## 23. Sécurité

- appel RTK sans interpolation shell lorsque possible ;
- timeout strict ;
- longueur maximale de commande ;
- contrôle de sécurité avant et après réécriture ;
- aucune installation automatique sans confirmation ;
- sauvegarde avant modification des réglages ;
- aucune exécution de commande fournie par un provider sémantique sans validation ;
- logs locaux sans secrets ;
- chemins de sorties complètes protégés par les règles du dépôt.

---

## 24. Migration et désinstallation

### Activation RTK

1. détecter RTK ;
2. vérifier sa version ;
3. détecter un hook autonome ;
4. proposer une migration ;
5. sauvegarder les réglages ;
6. activer le bridge PMZ ;
7. exécuter un test ;
8. afficher le résultat.

### Désactivation RTK

- désactiver le bridge ;
- conserver les métriques historiques ;
- réactiver le fallback si configuré ;
- ne pas désinstaller le binaire sans demande explicite.

### Activation Serena

- détecter le binaire ;
- vérifier la configuration MCP ;
- initialiser le projet avec confirmation ;
- tester les capacités ;
- activer les règles conditionnelles.

### Désactivation Serena

- retirer uniquement les règles PMZ liées ;
- ne pas supprimer l’index ou la configuration Serena sans demande explicite ;
- conserver les handoffs PMZ.

---

## 25. Critères d’acceptation techniques

- [ ] Le core ne référence aucun exécutable externe hors adaptateurs.
- [ ] Le hook Bash retourne toujours une décision valide.
- [ ] La commande originale est exécutée si RTK échoue.
- [ ] Les commandes dangereuses sont évaluées avant réécriture.
- [ ] Le backlog reste lisible sans champs d’intégration.
- [ ] Les exports acceptent les anciens et nouveaux schémas.
- [ ] Le doctor détecte les conflits.
- [ ] Serena est interrogé par capacités.
- [ ] Les noms d’outils Serena restent confinés à l’adaptateur.
- [ ] La mémoire PMZ reste la source de vérité narrative.
- [ ] Le fallback textuel refuse les garanties qu’il ne peut pas fournir.
- [ ] La désinstallation d’un provider ne supprime aucune donnée PMZ.
- [ ] Les modes normal, prudent, dégradé et désactivé sont testés.
- [ ] Claude Code et OpenCode disposent d’un chemin d’intégration fonctionnel.
- [ ] Codex dispose d’instructions compatibles avec ses capacités réelles.

---

## 26. Décisions à arbitrer avant implémentation

1. Le bridge RTK doit-il être activé automatiquement lorsqu’un binaire compatible est détecté ?
2. Où stocker les métriques d’économie détaillées avant agrégation ?
3. Le fallback de sortie doit-il intercepter toutes les commandes ou seulement les commandes de vérification ?
4. Quel seuil de taille de dépôt déclenche une recommandation Serena ?
5. La mémoire narrative Serena doit-elle être explicitement désactivée par l’installateur PMZ ?
6. Quelle politique appliquer à une version plus récente que la plage testée ?
7. Le provider textuel doit-il utiliser uniquement les commandes système ou embarquer Tree-sitter/ctags ?
8. Les champs de métrique doivent-ils être ajoutés immédiatement au schéma du backlog ou dans un fichier séparé ?
9. L’intégration Codex doit-elle rester documentaire ou disposer d’un outil compagnon externe ?
10. Quelle licence et quelle procédure de publication appliquer à un éventuel fork ?

---

## 27. Ordre d’implémentation recommandé

```text
1. Interfaces et registre
2. Provider neutre
3. Doctor commun
4. Bridge RTK
5. Métrologie RTK
6. Fallback de sortie
7. Serena Doctor
8. Règles Serena-aware
9. Provider textuel
10. Tests contractuels et documentation de résilience
```

Cette séquence produit rapidement une valeur mesurable sans rendre Serena bloquant pour la première livraison.
